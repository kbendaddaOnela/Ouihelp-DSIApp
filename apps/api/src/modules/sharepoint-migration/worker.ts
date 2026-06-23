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
import { listChildren, downloadItemContent, type SpItem } from './sharepointService'
import {
  getSharedDrive,
  createFolder,
  uploadFile,
  addSharedDriveMember,
  removeSharedDrivePermission,
  type ItemMeta,
} from './googleDriveService'
import { migrations } from '../migration/schema'
import { isNotNull } from 'drizzle-orm'

/**
 * Construit la table de mapping auteur ONELA → compte Google à usurper.
 * Source : la table `migrations` (onelaEmail / onelaUpn → gohUpn = compte Google
 * prenom.nom@mig.onela.com). Indexée sur l'email ET l'UPN, en minuscules.
 * Seuls les users réellement migrés (gohUpn non null) sont mappables.
 */
async function loadAuthorMap(): Promise<Map<string, string>> {
  const rows = await db
    .select({
      onelaEmail: migrations.onelaEmail,
      onelaUpn: migrations.onelaUpn,
      gohUpn: migrations.gohUpn,
    })
    .from(migrations)
    .where(isNotNull(migrations.gohUpn))
  const map = new Map<string, string>()
  for (const r of rows) {
    if (!r.gohUpn) continue
    if (r.onelaEmail) map.set(r.onelaEmail.toLowerCase(), r.gohUpn)
    if (r.onelaUpn) map.set(r.onelaUpn.toLowerCase(), r.gohUpn)
  }
  return map
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
const MAX_FILE_BYTES = 300 * 1024 * 1024 // 300 Mo
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

    // 1) Valider le Shared Drive cible (créé manuellement par l'admin)
    sharedDriveId = job.gdSharedDriveId
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
    let discovered = 0
    let migratedBytes = 0

    // 2b) Mapping auteur ONELA → compte Google + ajout de membre à la demande.
    const authorMap = await loadAuthorMap()
    const adminLower = (process.env['GOOGLE_ADMIN_EMAIL'] ?? '').toLowerCase()
    const driveId = sharedDriveId // non-null après le check ci-dessus (pour les closures)
    /** Ajoute (une seule fois) un user au Shared Drive ; renvoie l'id de permission ou null. */
    const ensureMember = (gohUpn: string): Promise<string | null> => {
      let p = memberPromises.get(gohUpn)
      if (!p) {
        p = addSharedDriveMember(driveId, gohUpn)
        memberPromises.set(gohUpn, p)
      }
      return p
    }

    // 2c) Pré-comptage : parcours métadonnées (BFS, pas de téléchargement) pour
    // connaître le total de fichiers + octets AVANT de transférer → barre de
    // progression juste dès le départ. On fixe le total AVANT d'écrire migrated
    // (sinon, au resume, migrated/total≈1 fait sauter la barre à ~100%).
    let totalFiles = 0
    let totalBytes = 0
    {
      const countQueue: (string | null)[] = [job.rootItemId]
      let sinceFlush = 0
      while (countQueue.length > 0) {
        if (STOP_SIGNALS.has(job.id)) break // la pause interrompt aussi le comptage
        const fid = countQueue.shift()!
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
          if (k.isFolder) countQueue.push(k.id)
          else {
            totalFiles++
            totalBytes += k.size ?? 0
          }
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
    }
    console.log(
      `[sharepoint] ${job.id} pré-comptage: ${totalFiles} fichiers, ${(totalBytes / 1024 / 1024).toFixed(0)} Mo`,
    )

    await db
      .update(sharepointMigrations)
      .set({ totalItems: totalFiles, totalBytes, migratedItems: migrated, failedItems: 0 })
      .where(eq(sharepointMigrations.id, job.id))

    // 3) Parcours BFS
    const queue: QueueEntry[] = [
      { spFolderId: job.rootItemId, gdParentId: sharedDriveId, path: job.rootPath ?? '' },
    ]
    let stoppedByUser = false

    // totalItems est figé par le pré-comptage : on ne l'écrase pas ici.
    const persistCounters = () =>
      db
        .update(sharepointMigrations)
        .set({ migratedItems: migrated, failedItems: failed, migratedBytes })
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
            if (doneFiles.has(file.id)) return { file, skipped: true as const }
            if (file.size != null && file.size > MAX_FILE_BYTES) {
              throw new Error(
                `Fichier trop volumineux (${Math.round(file.size / 1024 / 1024)} Mo, limite ${MAX_FILE_BYTES / 1024 / 1024} Mo) — à transférer manuellement`,
              )
            }

            // Auteur SharePoint → compte Google à usurper (pour le « modifié par »).
            // Repli sur le compte admin si auteur non mappé, sans compte, ou échec.
            const authorEmail = (file.lastModifiedByEmail ?? file.createdByEmail ?? '').toLowerCase()
            const gohUpn = authorEmail ? authorMap.get(authorEmail) : undefined
            let impersonate: string | undefined
            if (gohUpn && gohUpn.toLowerCase() !== adminLower) {
              const permId = await ensureMember(gohUpn)
              if (permId) impersonate = gohUpn
            }

            const { buffer, size } = await downloadItemContent(job.driveId, file.id)
            let gdFileId: string
            try {
              gdFileId = await uploadFile({
                name: file.name,
                parentId: gdParentId,
                body: buffer,
                meta: spMeta(file),
                impersonate,
              })
            } catch (e) {
              if (!impersonate) throw e
              // L'upload usurpé a échoué → on dépose en tant qu'admin (le fichier
              // passe, mais « modifié par » = compte de migration pour celui-ci).
              console.warn(
                `[sharepoint] upload usurpé (${impersonate}) échoué pour ${file.name}, repli admin:`,
                e instanceof Error ? e.message : e,
              )
              gdFileId = await uploadFile({
                name: file.name,
                parentId: gdParentId,
                body: buffer,
                meta: spMeta(file),
              })
            }
            return { file, skipped: false as const, gdFileId, bytes: file.size ?? size }
          }),
        )

        for (let k = 0; k < results.length; k++) {
          const file = batch[k]!
          const res = results[k]!
          const filePath = path ? `${path}/${file.name}` : file.name
          if (res.status === 'fulfilled') {
            if (res.value.skipped) continue // déjà migré, rien à écrire
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
                gdFileId: res.value.gdFileId,
                status: 'success',
              })
              .onDuplicateKeyUpdate({
                set: { status: 'success', gdFileId: res.value.gdFileId, errorDetails: null },
              })
            migrated++
            migratedBytes += res.value.bytes
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
          migratedBytes,
          errorDetails: `En pause (${migrated} fichiers migrés)`,
        })
        .where(eq(sharepointMigrations.id, job.id))
      console.log(`[sharepoint] paused ${job.id}: ${migrated} migrés avant pause`)
      return
    }

    const ok = failed === 0
    await db
      .update(sharepointMigrations)
      .set({
        status: ok ? 'success' : 'error',
        finishedAt: new Date(),
        migratedItems: migrated,
        failedItems: failed,
        migratedBytes,
        errorDetails: failed > 0 ? `${failed} fichier(s) en erreur` : null,
      })
      .where(eq(sharepointMigrations.id, job.id))
    console.log(`[sharepoint] done ${job.id}: ${migrated} migrés, ${failed} échecs, ${discovered} découverts`)
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
