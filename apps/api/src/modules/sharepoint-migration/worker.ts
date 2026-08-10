// Worker in-process : migre une bibliothèque (ou sous-dossier) d'un site
// SharePoint ONELA vers un Google Shared Drive (Drive partagé) OUIHELP/GOH.
//
// Parcours en LARGEUR (BFS) : pour chaque dossier, on crée d'abord les
// sous-dossiers Google (mapping spFolderId → gdFolderId) puis on transfère les
// fichiers. Le BFS garantit que le parent Google existe avant ses enfants.
//
// Idempotence / reprise : table sharepoint_migrated_items.
//   - dossier success → gdFileId réutilisé comme parent (pas de recréation)
//   - fichier success → skippé
//   - fichier error    → re-tenté (non présent dans le skipSet)
//
// Single-instance comme le worker shared-mailbox : une migration à la fois
// (les transferts Drive saturent vite la bande passante du conteneur).

import { eq } from 'drizzle-orm'
import { db } from '../../db/index'
import {
  sharepointMigrations,
  sharepointMigratedItems,
  type SharepointMigration,
} from './schema'
import {
  listChildren,
  downloadItemContent,
  listItemVersions,
  downloadItemVersionContent,
  openItemContentStream,
  openItemVersionContentStream,
  type SpItem,
  type SpVersion,
} from './sharepointService'
import {
  getSharedDrive,
  createFolder,
  uploadFile,
  uploadFileStreamed,
  addRevision,
  addRevisionStreamed,
  setFileModifiedTime,
  addSharedDriveMember,
  removeSharedDrivePermission,
  type ItemMeta,
} from './googleDriveService'
import { migrations } from '../migration/schema'
import { isNotNull } from 'drizzle-orm'

interface AuthorMaps {
  byEmail: Map<string, string>
  byName: Map<string, string>
}

/**
 * Construit les tables de mapping auteur ONELA → compte Google à usurper.
 * Source : la table `migrations` (gohUpn = compte Google prenom.nom@mig.onela.com).
 * - byEmail : indexée sur onelaEmail ET onelaUpn (en minuscules).
 * - byName  : indexée sur onelaDisplayName — filet de secours quand Microsoft
 *   Graph ne renvoie PAS l'email dans lastModifiedBy/createdBy (fréquent : il n'y
 *   a alors que le displayName). Sans ça, le même auteur est attribué sur les
 *   fichiers où Graph donne l'email, et en repli admin sur les autres.
 * Seuls les users réellement migrés (gohUpn non null) sont mappables.
 */
async function loadAuthorMaps(): Promise<AuthorMaps> {
  const rows = await db
    .select({
      onelaEmail: migrations.onelaEmail,
      onelaUpn: migrations.onelaUpn,
      onelaDisplayName: migrations.onelaDisplayName,
      gohUpn: migrations.gohUpn,
    })
    .from(migrations)
    .where(isNotNull(migrations.gohUpn))
  const byEmail = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const r of rows) {
    if (!r.gohUpn) continue
    if (r.onelaEmail) byEmail.set(r.onelaEmail.toLowerCase(), r.gohUpn)
    if (r.onelaUpn) byEmail.set(r.onelaUpn.toLowerCase(), r.gohUpn)
    if (r.onelaDisplayName) byName.set(r.onelaDisplayName.trim().toLowerCase(), r.gohUpn)
  }
  return { byEmail, byName }
}

/** Résout un compte Google depuis un couple (email, nom) : email d'abord, puis nom. */
function resolveGoh(
  email: string | null,
  name: string | null,
  maps: AuthorMaps,
): string | undefined {
  const e = email?.toLowerCase()
  const n = name?.trim().toLowerCase()
  return (e ? maps.byEmail.get(e) : undefined) ?? (n ? maps.byName.get(n) : undefined)
}

/**
 * Résout le compte Google à usurper pour un item : dernier modificateur d'abord,
 * puis créateur. Email prioritaire sur le nom (filet quand Graph omet l'email).
 * Renvoie le gohUpn ou undefined (→ repli admin).
 */
function resolveAuthorGoh(item: SpItem, maps: AuthorMaps): string | undefined {
  return (
    resolveGoh(item.lastModifiedByEmail, item.lastModifiedByName, maps) ??
    resolveGoh(item.createdByEmail, item.createdByName, maps)
  )
}

/**
 * Construit les métadonnées Google à partir d'un item SharePoint :
 * dates d'origine (créées/modifiées) + auteurs d'origine en appProperties
 * (le « Modifié par » natif d'un Shared Drive reste le compte de migration).
 */
function spMeta(item: SpItem): ItemMeta {
  const appProperties: Record<string, string> = { sourceItemId: item.id.slice(0, 120) }
  if (item.createdByName) appProperties['sourceCreatedBy'] = item.createdByName.slice(0, 120)
  if (item.lastModifiedByName) appProperties['sourceModifiedBy'] = item.lastModifiedByName.slice(0, 120)
  return {
    createdTime: item.createdDateTime,
    modifiedTime: item.lastModifiedDateTime,
    appProperties,
  }
}

const POLL_INTERVAL_MS = 5000
const BATCH_SIZE = 3 // fichiers transférés en parallèle par dossier
// Garde-fou : on bufferise chaque fichier en mémoire (×BATCH_SIZE en parallèle).
// Au-delà de cette taille on saute le fichier (évite l'OOM du conteneur et les
// téléchargements de 10 min type backup .pst). À transférer manuellement.
// Plafond de sécurité. Les fichiers > STREAM_THRESHOLD sont streamés (mémoire
// constante), donc cette limite peut être haute : elle ne protège plus que
// contre les transferts absurdement longs.
const MAX_FILE_BYTES = Number(process.env['SHAREPOINT_MAX_FILE_MB'] ?? 5120) * 1024 * 1024

/**
 * Budget mémoire global pour les contenus en vol.
 *
 * Les fichiers sont bufferisés en RAM (Buffer rejouable). Sans plafond, 3 gros
 * fichiers en parallèle (3 × 300 Mo) suffisent à faire tuer le conteneur Azure
 * par l'OOM killer — l'API redémarre et la migration est interrompue. On réserve
 * donc la taille avant de télécharger : un gros fichier passe SEUL au lieu de
 * s'additionner aux autres.
 */
const MEM_BUDGET_BYTES = Number(process.env['SHAREPOINT_MEM_BUDGET_MB'] ?? 250) * 1024 * 1024
let memInFlight = 0

/**
 * Au-delà de ce seuil, le fichier est transféré EN FLUX (morceaux de 16 Mo)
 * au lieu d'être bufferisé : la mémoire ne dépend plus de sa taille, ce qui
 * permet de migrer des fichiers de plusieurs Go.
 */
const STREAM_THRESHOLD_BYTES = Number(process.env['SHAREPOINT_STREAM_THRESHOLD_MB'] ?? 64) * 1024 * 1024
/** Coût mémoire réservé pour un transfert streamé (≈ 2 morceaux en vol). */
const CHUNK_MEM_COST = 48 * 1024 * 1024

/** Réserve `bytes` du budget (attend si nécessaire). Un fichier plus gros que le
 *  budget passe quand même, mais seul — sinon on bloquerait indéfiniment. */
async function acquireMem(bytes: number): Promise<void> {
  while (memInFlight > 0 && memInFlight + bytes > MEM_BUDGET_BYTES) {
    await new Promise((r) => setTimeout(r, 250))
  }
  memInFlight += bytes
}

function releaseMem(bytes: number): void {
  memInFlight = Math.max(0, memInFlight - bytes)
}

/** Exécute `fn` en réservant `bytes` du budget mémoire pour toute sa durée. */
async function withMem<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
  const reserved = Math.max(0, bytes)
  await acquireMem(reserved)
  try {
    return await fn()
  } finally {
    releaseMem(reserved)
  }
}
const HEARTBEAT_MS = 60_000
const ORPHAN_STALE_MS = 15 * 60 * 1000

const RUNNING = new Set<string>()
const STOP_SIGNALS = new Set<string>()

/** Demande l'arrêt propre d'une migration (vérifié entre deux dossiers/batches). */
export function signalStopSharepoint(id: string) {
  STOP_SIGNALS.add(id)
}

let workerStarted = false

export function startSharepointMigrationWorker() {
  if (workerStarted) return
  workerStarted = true
  console.log('[sharepoint-worker] started')
  setInterval(() => {
    pollAndProcess().catch((err) => console.error('[sharepoint-worker] tick error:', err))
  }, POLL_INTERVAL_MS)
}

function startHeartbeat(id: string): () => void {
  const timer = setInterval(() => {
    void db
      .update(sharepointMigrations)
      .set({ updatedAt: new Date() })
      .where(eq(sharepointMigrations.id, id))
      .catch((err) =>
        console.warn(`[sharepoint-heartbeat] ${id}:`, err instanceof Error ? err.message : err),
      )
  }, HEARTBEAT_MS)
  return () => clearInterval(timer)
}

async function pollAndProcess() {
  const all = await db.select().from(sharepointMigrations)

  // Détection d'orphelins : 'running' mais pas dans RUNNING et inactif > 15min → reset
  for (const job of all) {
    if (job.status === 'running' && !RUNNING.has(job.id)) {
      const stale = Date.now() - new Date(job.updatedAt).getTime() > ORPHAN_STALE_MS
      if (stale) {
        console.warn(
          `[sharepoint-worker] orphan detected: ${job.id} (inactif depuis ${job.updatedAt}) — reset 'pending'`,
        )
        await db
          .update(sharepointMigrations)
          .set({ status: 'pending' })
          .where(eq(sharepointMigrations.id, job.id))
        job.status = 'pending'
      }
    }
  }

  if (RUNNING.size > 0) return
  const next = all.find((j) => j.status === 'pending')
  if (!next) return

  RUNNING.add(next.id)
  processMigration(next)
    .catch((err) => console.error(`[sharepoint-worker] ${next.id} fatal:`, err))
    .finally(() => RUNNING.delete(next.id))
}

interface QueueEntry {
  spFolderId: string | null // null = racine du drive
  gdParentId: string
  path: string
}

/**
 * Dossiers source à migrer. Chacun est recréé à la racine du Shared Drive.
 * Liste vide (selectedRoots null) = toute la bibliothèque (racine, sans wrapper).
 */
function parseSelectedRoots(job: SharepointMigration): Array<{ id: string; name: string }> {
  if (!job.selectedRoots) return []
  try {
    const arr = JSON.parse(job.selectedRoots)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string')
      .map((r) => ({ id: r.id as string, name: r.name as string }))
  } catch {
    return []
  }
}

async function processMigration(job: SharepointMigration) {
  console.log(`[sharepoint] start ${job.id} (${job.siteName} / ${job.driveName} → ${job.gdSharedDriveName})`)
  const stopHeartbeat = startHeartbeat(job.id)
  // Membres ajoutés temporairement au Shared Drive pour l'impersonation
  // (gohUpn → promesse d'id de permission). Retirés en fin de run (le « modifié
  // par » historique, lui, persiste même après retrait du membre).
  const memberPromises = new Map<string, Promise<string | null>>()
  let sharedDriveId: string | null = null
  try {
    await db
      .update(sharepointMigrations)
      .set({ status: 'running', errorDetails: null, startedAt: new Date() })
      .where(eq(sharepointMigrations.id, job.id))

    // 1) Valider le Shared Drive cible (créé manuellement par l'admin).
    // En mode analyse on ne transfère rien → pas de cible requise.
    sharedDriveId = job.gdSharedDriveId
    if (!job.analyzeOnly) {
      if (!sharedDriveId) {
        throw new Error('Aucun Shared Drive Google sélectionné pour cette migration')
      }
      const target = await getSharedDrive(sharedDriveId)
      if (!target) {
        throw new Error(
          `Le Shared Drive sélectionné (${job.gdSharedDriveName}) est introuvable côté Google. ` +
            `A-t-il été supprimé ou renommé ? Recrée-le et relance.`,
        )
      }
    }

    // 2) Charger l'état (idempotence)
    const existing = await db
      .select()
      .from(sharepointMigratedItems)
      .where(eq(sharepointMigratedItems.migrationId, job.id))

    const doneFiles = new Set(
      existing.filter((r) => !r.isFolder && r.status === 'success').map((r) => r.spItemId),
    )
    const folderGdMap = new Map<string, string>() // spFolderId → gdFolderId
    for (const r of existing) {
      if (r.isFolder && r.status === 'success' && r.gdFileId) folderGdMap.set(r.spItemId, r.gdFileId)
    }

    let migrated = doneFiles.size
    let failed = 0
    let skipped = 0 // fichiers ignorés (trop volumineux) — distinct des erreurs
    let discovered = 0
    let migratedBytes = 0

    // 2b) Mapping auteur ONELA → compte Google + ajout de membre à la demande.
    const authorMaps = await loadAuthorMaps()
    const adminLower = (process.env['GOOGLE_ADMIN_EMAIL'] ?? '').toLowerCase()
    const driveId = sharedDriveId ?? '' // non-null hors mode analyse (pour les closures)
    /** Ajoute (une seule fois) un user au Shared Drive ; renvoie l'id de permission ou null. */
    const ensureMember = (gohUpn: string): Promise<string | null> => {
      let p = memberPromises.get(gohUpn)
      if (!p) {
        p = addSharedDriveMember(driveId, gohUpn)
        memberPromises.set(gohUpn, p)
      }
      return p
    }
    /** Renvoie l'email à usurper (membre garanti) ou undefined (→ repli admin). */
    const impersonationFor = async (gohUpn: string | undefined): Promise<string | undefined> => {
      if (gohUpn && gohUpn.toLowerCase() !== adminLower) {
        const permId = await ensureMember(gohUpn)
        if (permId) return gohUpn
      }
      return undefined
    }

    /**
     * Transfère la version COURANTE d'un fichier.
     * - petit fichier (≤ STREAM_THRESHOLD) : bufferisé (rapide, rejouable)
     * - gros fichier : streamé par morceaux de 16 Mo (mémoire constante)
     */
    const transferCurrent = async (
      file: SpItem,
      gdParentId: string,
      meta: ItemMeta,
      impersonate: string | undefined,
    ): Promise<string> => {
      const size = file.size ?? 0
      if (size > STREAM_THRESHOLD_BYTES) {
        return withMem(CHUNK_MEM_COST, async () => {
          const { stream, size: hdrSize } = await openItemContentStream(job.driveId, file.id)
          return uploadFileStreamed({
            name: file.name,
            parentId: gdParentId,
            stream,
            size: hdrSize ?? size,
            meta,
            impersonate,
          })
        })
      }
      return withMem(size, async () => {
        const { buffer } = await downloadItemContent(job.driveId, file.id)
        return uploadOne(file, gdParentId, buffer, meta, impersonate)
      })
    }

    /**
     * Transfère un fichier AVEC son historique de versions : crée le fichier à
     * partir de la version la plus ancienne, puis empile chaque version suivante
     * comme révision Drive. Chaque version est usurpée par SON auteur (créé par =
     * plus ancien auteur, modifié par = dernier). modifiedTime final = dernière
     * version. Repli sur le téléchargement simple si l'API versions échoue ou ≤ 1
     * version. Renvoie l'id du fichier Google.
     */
    const transferWithVersions = async (
      file: SpItem,
      gdParentId: string,
      fileImpersonate: string | undefined,
    ): Promise<string> => {
      let versions: SpVersion[] = []
      try {
        versions = await listItemVersions(job.driveId, file.id)
      } catch (e) {
        console.warn(
          `[sharepoint] versions ${file.name} illisibles, repli version courante:`,
          e instanceof Error ? e.message : e,
        )
        versions = []
      }
      // Limite le nombre de versions : on garde la PREMIÈRE (elle porte la date et
      // l'auteur de création, et SharePoint ne l'expire pas) + les N-1 plus
      // récentes. Graph n'expose pas l'expiration : c'est le meilleur proxy.
      const cap = job.maxVersions
      if (cap >= 0 && versions.length > cap) {
        if (cap <= 1) {
          versions = versions.slice(-1) // version courante seule
        } else {
          const first = versions[0]!
          versions = [first, ...versions.slice(-(cap - 1))]
        }
      }

      // ≤ 1 version → upload simple de la version courante
      if (versions.length <= 1) {
        return transferCurrent(file, gdParentId, spMeta(file), fileImpersonate)
      }

      let gdFileId: string | null = null
      for (let idx = 0; idx < versions.length; idx++) {
        const v = versions[idx]!
        if (v.size != null && v.size > MAX_FILE_BYTES) {
          console.warn(`[sharepoint] version ${v.id} de ${file.name} trop volumineuse, ignorée`)
          continue
        }
        const vSize = v.size ?? file.size ?? 0
        const isLastVersion = idx === versions.length - 1
        const vImpersonateP = impersonationFor(
          resolveGoh(v.lastModifiedByEmail, v.lastModifiedByName, authorMaps),
        )

        // Grosse version → streaming par morceaux (mémoire constante)
        if (vSize > STREAM_THRESHOLD_BYTES) {
          const vImpersonate = await vImpersonateP
          gdFileId = await withMem(CHUNK_MEM_COST, async () => {
            const opened = isLastVersion
              ? await openItemContentStream(job.driveId, file.id)
              : await openItemVersionContentStream(job.driveId, file.id, v.id).catch(async (e) => {
                  if (e instanceof Error && /current version/i.test(e.message)) {
                    return openItemContentStream(job.driveId, file.id)
                  }
                  throw e
                })
            if (gdFileId === null) {
              return uploadFileStreamed({
                name: file.name,
                parentId: gdParentId,
                stream: opened.stream,
                size: opened.size ?? vSize,
                meta: {
                  ...spMeta(file),
                  createdTime: v.lastModifiedDateTime,
                  modifiedTime: v.lastModifiedDateTime,
                },
                impersonate: vImpersonate,
              })
            }
            await addRevisionStreamed({
              fileId: gdFileId,
              stream: opened.stream,
              size: opened.size ?? vSize,
              impersonate: vImpersonate,
            })
            return gdFileId
          })
          continue
        }

        // Budget mémoire : le contenu de la version est réservé pour toute la
        // durée download + upload (évite l'OOM du conteneur).
        gdFileId = await withMem(vSize, async () => {
          // ⚠️ Graph refuse /versions/{id}/content sur la version COURANTE. Celle-ci
          // n'est PAS toujours la dernière du tri par date (fichier restauré à une
          // version antérieure → date courante ancienne). On prend donc /content pour
          // la dernière ET en repli sur toute version qui répond « current version »
          // (/content renvoie toujours le contenu courant).
          let buffer: Buffer
          if (isLastVersion) {
            buffer = (await downloadItemContent(job.driveId, file.id)).buffer
          } else {
            try {
              buffer = (await downloadItemVersionContent(job.driveId, file.id, v.id)).buffer
            } catch (e) {
              if (e instanceof Error && /current version/i.test(e.message)) {
                buffer = (await downloadItemContent(job.driveId, file.id)).buffer
              } else {
                throw e
              }
            }
          }
          const vImpersonate = await vImpersonateP
          if (gdFileId === null) {
            // Première version exploitable → crée le fichier (createdTime = sa date)
            const meta: ItemMeta = {
              ...spMeta(file),
              createdTime: v.lastModifiedDateTime,
              modifiedTime: v.lastModifiedDateTime,
            }
            return uploadOne(file, gdParentId, buffer, meta, vImpersonate)
          }
          await addRevisionWithFallback(gdFileId, buffer, vImpersonate)
          return gdFileId
        })
      }
      if (gdFileId === null) {
        // Toutes les versions étaient trop volumineuses → tente la courante
        return transferCurrent(file, gdParentId, spMeta(file), fileImpersonate)
      }
      // modifiedTime final = date de la dernière version
      const last = versions[versions.length - 1]
      if (last?.lastModifiedDateTime) {
        await setFileModifiedTime(gdFileId, last.lastModifiedDateTime, fileImpersonate)
      }
      return gdFileId
    }

    /** uploadFile avec repli admin si l'upload usurpé échoue. */
    const uploadOne = async (
      file: SpItem,
      gdParentId: string,
      buffer: Buffer,
      meta: ItemMeta,
      impersonate: string | undefined,
    ): Promise<string> => {
      try {
        return await uploadFile({ name: file.name, parentId: gdParentId, body: buffer, meta, impersonate })
      } catch (e) {
        if (!impersonate) throw e
        console.warn(
          `[sharepoint] upload usurpé (${impersonate}) échoué pour ${file.name}, repli admin:`,
          e instanceof Error ? e.message : e,
        )
        return uploadFile({ name: file.name, parentId: gdParentId, body: buffer, meta })
      }
    }

    /** addRevision avec repli admin si la révision usurpée échoue. */
    const addRevisionWithFallback = async (
      fileId: string,
      buffer: Buffer,
      impersonate: string | undefined,
    ): Promise<void> => {
      try {
        await addRevision({ fileId, body: buffer, impersonate })
      } catch (e) {
        if (!impersonate) throw e
        console.warn(`[sharepoint] révision usurpée (${impersonate}) échouée, repli admin:`, e instanceof Error ? e.message : e)
        await addRevision({ fileId, body: buffer })
      }
    }

    // 2c) Pré-comptage : parcours métadonnées (BFS, pas de téléchargement) pour
    // connaître le total de fichiers + octets AVANT de transférer → barre de
    // progression juste dès le départ. On fixe le total AVANT d'écrire migrated
    // (sinon, au resume, migrated/total≈1 fait sauter la barre à ~100%).
    let totalFiles = 0
    let totalBytes = 0
    // Diagnostic d'attribution (calculé pendant le comptage) : combien de fichiers
    // seront attribués à leur auteur vs en repli admin, et quels auteurs ne sont
    // pas mappés (pas de compte Google migré, ou « Compte système »).
    let attributable = 0
    let fallbackCount = 0
    const unmapped = new Map<string, number>()
    const selectedRoots = parseSelectedRoots(job)
    let sinceFlush = 0

    /** Comptabilise un fichier (total + attribution prévisionnelle). */
    const accountFile = (k: SpItem) => {
      totalFiles++
      totalBytes += k.size ?? 0
      const mapped = resolveAuthorGoh(k, authorMaps)
      if (mapped && mapped.toLowerCase() !== adminLower) {
        attributable++
      } else {
        fallbackCount++
        const who =
          k.lastModifiedByName ??
          k.createdByName ??
          k.lastModifiedByEmail ??
          k.createdByEmail ??
          'système'
        unmapped.set(who, (unmapped.get(who) ?? 0) + 1)
      }
    }

    /** Compte récursivement un sous-arbre (métadonnées seules, pas de download). */
    const countSubtree = async (startId: string | null): Promise<{ files: number; bytes: number }> => {
      let files = 0
      let bytes = 0
      const q: (string | null)[] = [startId]
      while (q.length > 0) {
        if (STOP_SIGNALS.has(job.id)) break // la pause interrompt aussi le comptage
        const fid = q.shift()!
        let kids: SpItem[]
        try {
          kids = await listChildren(job.driveId, fid)
        } catch (e) {
          console.warn(
            `[sharepoint] comptage: listChildren ${fid ?? 'root'} échoué:`,
            e instanceof Error ? e.message : e,
          )
          continue
        }
        for (const k of kids) {
          if (k.isFolder) {
            q.push(k.id)
            continue
          }
          accountFile(k)
          files++
          bytes += k.size ?? 0
        }
        // Feedback périodique : le total grimpe pendant l'analyse (barre à 0%
        // tant que migrated=0), l'opérateur voit que ça avance.
        if (++sinceFlush >= 10) {
          sinceFlush = 0
          await db
            .update(sharepointMigrations)
            .set({ totalItems: totalFiles, totalBytes })
            .where(eq(sharepointMigrations.id, job.id))
        }
      }
      return { files, bytes }
    }

    // Comptage par « bucket » = dossier sélectionné, ou dossier de 1er niveau de
    // la bibliothèque → donne la répartition du poids (contenu courant).
    const buckets: Array<{ name: string; files: number; bytes: number }> = []
    if (selectedRoots.length > 0) {
      for (const r of selectedRoots) {
        const { files, bytes } = await countSubtree(r.id)
        buckets.push({ name: r.name, files, bytes })
      }
    } else {
      const rootChildren = await listChildren(job.driveId, null)
      for (const f of rootChildren.filter((c) => c.isFolder)) {
        const { files, bytes } = await countSubtree(f.id)
        buckets.push({ name: f.name, files, bytes })
      }
      // Fichiers posés directement à la racine de la bibliothèque
      const rootFiles = rootChildren.filter((c) => !c.isFolder)
      if (rootFiles.length > 0) {
        let bytes = 0
        for (const k of rootFiles) {
          accountFile(k)
          bytes += k.size ?? 0
        }
        buckets.push({ name: '(fichiers à la racine)', files: rootFiles.length, bytes })
      }
    }
    buckets.sort((a, b) => b.bytes - a.bytes)
    console.log(
      `[sharepoint] ${job.id} pré-comptage: ${totalFiles} fichiers, ${(totalBytes / 1024 / 1024).toFixed(0)} Mo`,
    )
    console.log(
      `[sharepoint] ${job.id} attribution prévue: ${attributable}/${totalFiles} à leur auteur, ${fallbackCount} en repli admin`,
    )
    if (unmapped.size > 0) {
      const top = [...unmapped.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | ')
      console.log(`[sharepoint] ${job.id} auteurs en repli (top 20): ${top}`)
    }

    // Mode analyse : on s'arrête ici, rien n'est transféré.
    if (job.analyzeOnly) {
      const gb = (totalBytes / 1024 / 1024 / 1024).toFixed(1)
      await db
        .update(sharepointMigrations)
        .set({
          status: 'success',
          finishedAt: new Date(),
          totalItems: totalFiles,
          totalBytes,
          analysisResult: JSON.stringify(buckets),
          errorDetails: `Analyse : ${totalFiles} fichiers, ${gb} Go (contenu courant, hors versions)`,
        })
        .where(eq(sharepointMigrations.id, job.id))
      console.log(`[sharepoint] analyse terminée ${job.id}: ${totalFiles} fichiers, ${gb} Go`)
      return
    }

    if (!sharedDriveId) throw new Error('Aucun Shared Drive Google sélectionné pour cette migration')

    await db
      .update(sharepointMigrations)
      .set({
        totalItems: totalFiles,
        totalBytes,
        migratedItems: migrated,
        failedItems: 0,
        analysisResult: JSON.stringify(buckets),
      })
      .where(eq(sharepointMigrations.id, job.id))

    // 3) Parcours BFS — un point de départ par dossier sélectionné (chacun RECRÉÉ
    // à la racine du Shared Drive), ou la racine de la bibliothèque si aucun.
    const queue: QueueEntry[] = []
    if (selectedRoots.length === 0) {
      queue.push({ spFolderId: null, gdParentId: sharedDriveId, path: '' })
    } else {
      for (const root of selectedRoots) {
        let gdId = folderGdMap.get(root.id)
        if (!gdId) {
          gdId = await createFolder(root.name, sharedDriveId)
          folderGdMap.set(root.id, gdId)
          await db
            .insert(sharepointMigratedItems)
            .values({
              migrationId: job.id,
              spItemId: root.id,
              parentSpItemId: null,
              name: root.name,
              spPath: root.name.slice(0, 1500),
              isFolder: true,
              sizeBytes: null,
              gdFileId: gdId,
              status: 'success',
            })
            .onDuplicateKeyUpdate({ set: { status: 'success', gdFileId: gdId, errorDetails: null } })
        }
        queue.push({ spFolderId: root.id, gdParentId: gdId, path: root.name })
      }
    }
    let stoppedByUser = false

    // totalItems est figé par le pré-comptage : on ne l'écrase pas ici.
    const persistCounters = () =>
      db
        .update(sharepointMigrations)
        .set({ migratedItems: migrated, failedItems: failed, skippedItems: skipped, migratedBytes })
        .where(eq(sharepointMigrations.id, job.id))

    while (queue.length > 0) {
      if (STOP_SIGNALS.has(job.id)) {
        stoppedByUser = true
        break
      }
      const { spFolderId, gdParentId, path } = queue.shift()!
      const children = await listChildren(job.driveId, spFolderId)

      // 3a) Dossiers d'abord : créer (ou réutiliser) puis enfiler
      for (const child of children.filter((c) => c.isFolder)) {
        let gdId = folderGdMap.get(child.id)
        const childPath = path ? `${path}/${child.name}` : child.name
        if (!gdId) {
          gdId = await createFolder(child.name, gdParentId, spMeta(child))
          folderGdMap.set(child.id, gdId)
          await db
            .insert(sharepointMigratedItems)
            .values({
              migrationId: job.id,
              spItemId: child.id,
              parentSpItemId: spFolderId,
              name: child.name,
              spPath: childPath.slice(0, 1500),
              isFolder: true,
              sizeBytes: null,
              gdFileId: gdId,
              status: 'success',
            })
            .onDuplicateKeyUpdate({ set: { status: 'success', gdFileId: gdId, errorDetails: null } })
        }
        queue.push({ spFolderId: child.id, gdParentId: gdId, path: childPath })
      }

      // 3b) Fichiers par batches
      const files = children.filter((c) => !c.isFolder)
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        if (STOP_SIGNALS.has(job.id)) {
          stoppedByUser = true
          break
        }
        const batch = files.slice(i, i + BATCH_SIZE)
        const results = await Promise.allSettled(
          batch.map(async (file) => {
            discovered++
            if (doneFiles.has(file.id)) return { kind: 'doneskip' as const }
            // Trop volumineux → ignoré (PAS une erreur) : à transférer à la main
            if (file.size != null && file.size > MAX_FILE_BYTES) {
              return {
                kind: 'oversized' as const,
                reason: `Fichier trop volumineux (${Math.round(file.size / 1024 / 1024)} Mo, limite ${MAX_FILE_BYTES / 1024 / 1024} Mo) — à transférer manuellement`,
              }
            }

            // Auteur du fichier → compte Google à usurper (repli admin sinon).
            const fileImpersonate = await impersonationFor(resolveAuthorGoh(file, authorMaps))

            let gdFileId: string
            if (job.migrateVersions && job.maxVersions !== 0) {
              gdFileId = await transferWithVersions(file, gdParentId, fileImpersonate)
            } else {
              gdFileId = await transferCurrent(file, gdParentId, spMeta(file), fileImpersonate)
            }
            return { kind: 'ok' as const, gdFileId, bytes: file.size ?? 0 }
          }),
        )

        for (let k = 0; k < results.length; k++) {
          const file = batch[k]!
          const res = results[k]!
          const filePath = path ? `${path}/${file.name}` : file.name
          if (res.status === 'fulfilled') {
            const v = res.value
            if (v.kind === 'doneskip') continue // déjà migré, rien à écrire
            if (v.kind === 'oversized') {
              await db
                .insert(sharepointMigratedItems)
                .values({
                  migrationId: job.id,
                  spItemId: file.id,
                  parentSpItemId: spFolderId,
                  name: file.name,
                  spPath: filePath.slice(0, 1500),
                  isFolder: false,
                  sizeBytes: file.size ?? null,
                  status: 'skipped',
                  errorDetails: v.reason,
                })
                .onDuplicateKeyUpdate({ set: { status: 'skipped', errorDetails: v.reason } })
              skipped++
              continue
            }
            // kind === 'ok'
            await db
              .insert(sharepointMigratedItems)
              .values({
                migrationId: job.id,
                spItemId: file.id,
                parentSpItemId: spFolderId,
                name: file.name,
                spPath: filePath.slice(0, 1500),
                isFolder: false,
                sizeBytes: file.size ?? null,
                gdFileId: v.gdFileId,
                status: 'success',
              })
              .onDuplicateKeyUpdate({
                set: { status: 'success', gdFileId: v.gdFileId, errorDetails: null },
              })
            migrated++
            migratedBytes += v.bytes
          } else {
            const errorDetails = (
              res.reason instanceof Error ? res.reason.message : String(res.reason)
            ).slice(0, 2000)
            await db
              .insert(sharepointMigratedItems)
              .values({
                migrationId: job.id,
                spItemId: file.id,
                parentSpItemId: spFolderId,
                name: file.name,
                spPath: filePath.slice(0, 1500),
                isFolder: false,
                sizeBytes: file.size ?? null,
                status: 'error',
                errorDetails,
              })
              .onDuplicateKeyUpdate({ set: { status: 'error', errorDetails } })
            failed++
            console.warn(`[sharepoint] fichier ${file.name} erreur:`, errorDetails.slice(0, 200))
          }
        }
        await persistCounters()
        // Trace mémoire périodique : permet de diagnostiquer une dérive avant
        // que l'OOM killer d'Azure ne tue le conteneur.
        if (migrated % 200 < BATCH_SIZE) {
          const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024)
          console.log(
            `[sharepoint] ${job.id} progression: ${migrated}/${totalFiles} — RSS ${rssMb} Mo, en vol ${Math.round(memInFlight / 1024 / 1024)} Mo`,
          )
        }
        // Petit répit anti-throttle entre deux batches de transfert
        await new Promise((r) => setTimeout(r, 300))
      }
      if (stoppedByUser) break
    }

    if (stoppedByUser) {
      STOP_SIGNALS.delete(job.id)
      await db
        .update(sharepointMigrations)
        .set({
          status: 'paused',
          finishedAt: new Date(),
          migratedItems: migrated,
          failedItems: failed,
          skippedItems: skipped,
          migratedBytes,
          errorDetails: `En pause (${migrated} fichiers migrés)`,
        })
        .where(eq(sharepointMigrations.id, job.id))
      console.log(`[sharepoint] paused ${job.id}: ${migrated} migrés avant pause`)
      return
    }

    // Les fichiers « trop volumineux » (skipped) ne comptent PAS comme des erreurs :
    // la migration est un succès s'il n'y a aucun vrai échec.
    const ok = failed === 0
    await db
      .update(sharepointMigrations)
      .set({
        status: ok ? 'success' : 'error',
        finishedAt: new Date(),
        migratedItems: migrated,
        failedItems: failed,
        skippedItems: skipped,
        migratedBytes,
        errorDetails: failed > 0 ? `${failed} fichier(s) en erreur` : null,
      })
      .where(eq(sharepointMigrations.id, job.id))
    console.log(
      `[sharepoint] done ${job.id}: ${migrated} migrés, ${failed} échecs, ${skipped} ignorés (trop gros), ${discovered} découverts`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .update(sharepointMigrations)
      .set({ status: 'error', errorDetails: msg, finishedAt: new Date() })
      .where(eq(sharepointMigrations.id, job.id))
    console.error(`[sharepoint] ${job.id} erreur fatale:`, msg)
  } finally {
    stopHeartbeat()
    // Retirer les membres ajoutés temporairement pour l'impersonation.
    // Best-effort : l'attribution « modifié par » persiste après le retrait.
    if (sharedDriveId && memberPromises.size > 0) {
      for (const [, p] of memberPromises) {
        const permId = await p.catch(() => null)
        if (permId) await removeSharedDrivePermission(sharedDriveId, permId).catch(() => {})
      }
      console.log(`[sharepoint] ${job.id}: ${memberPromises.size} membre(s) temporaire(s) retiré(s)`)
    }
  }
}
