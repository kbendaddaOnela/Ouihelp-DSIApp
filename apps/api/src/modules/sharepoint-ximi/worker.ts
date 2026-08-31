// Worker in-process : migre un site SharePoint d'agence ONELA vers son site
// équivalent sur le tenant SharePoint Ouihelp.
//
// ── Ce qui change par rapport au module `sharepoint-migration` (→ Google Drive)
//
// La cible étant SharePoint, la source peut être parcourue avec l'API `delta` de
// Graph. Une passe delta ne renvoie QUE ce qui a bougé, suppressions et
// déplacements compris. Le module Drive, lui, compare des dates de modification :
// il voit les créations et les modifications, jamais les suppressions ni les
// déplacements. C'est exactement la limite que ce module lève, et c'est ce qui
// rend la synchro du jour J fidèle.
//
// ── Déroulé d'une passe
//
//   1. résoudre la bibliothèque source
//   2. créer le site cible (SPSiteManager) s'il n'existe pas encore
//   3. donner accès au groupe dynamique de l'agence
//   4. pré-migration (jeton delta absent) : énumération complète → comptage,
//      puis transfert. Passe delta (jeton présent) : uniquement les changements.
//   5. n'enregistrer le nouveau jeton delta QU'EN CAS DE PASSE COMPLÈTE — une
//      passe interrompue doit repartir d'une énumération complète (idempotente),
//      jamais d'un jeton qui ferait sauter des changements non appliqués.
//
// Single-instance comme les autres workers du projet : une migration à la fois.

import { eq, and } from 'drizzle-orm'
import { db } from '../../db/index'
import { ximiMigrations, ximiMigratedItems, type XimiMigration } from './schema'
import {
  SOURCE,
  TARGET,
  DeltaResyncRequired,
  getDefaultDrive,
  resolveSiteByUrl,
  walkDelta,
  downloadContent,
  openContentStream,
  createTargetFolder,
  uploadSmallFile,
  uploadLargeFile,
  moveOrRenameTarget,
  deleteTargetItem,
  getRootItemId,
  type DeltaItem,
} from './graphService'
import {
  createCommunicationSite,
  grantGroupAccess,
  normalizeAlias,
  siteExists,
  targetSiteUrlFor,
} from './sharepointAdminService'
import { findGroupByExactName } from './graphService'

const POLL_INTERVAL_MS = 5000
const HEARTBEAT_MS = 60_000
const ORPHAN_STALE_MS = 15 * 60 * 1000

/** Fichiers transférés en parallèle. Même plafond que le module Drive : au-delà
 *  de 10, Graph throttle et le débit BAISSE au lieu de monter. */
const BATCH_SIZE = Math.min(
  10,
  Math.max(1, Number(process.env['XIMI_BATCH_SIZE'] ?? process.env['SHAREPOINT_BATCH_SIZE'] ?? 4)),
)
const MAX_FILE_BYTES = Number(process.env['SHAREPOINT_MAX_FILE_MB'] ?? 5120) * 1024 * 1024
const MEM_BUDGET_BYTES = Number(process.env['SHAREPOINT_MEM_BUDGET_MB'] ?? 250) * 1024 * 1024
const STREAM_THRESHOLD_BYTES =
  Number(process.env['SHAREPOINT_STREAM_THRESHOLD_MB'] ?? 64) * 1024 * 1024
/** Coût mémoire réservé pour un transfert streamé (≈ 2 morceaux en vol). */
const CHUNK_MEM_COST = 24 * 1024 * 1024

let memInFlight = 0

/** Réserve `bytes` du budget mémoire (attend si nécessaire). Un fichier plus
 *  gros que le budget passe quand même, mais seul. */
async function withMem<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
  const reserved = Math.max(0, bytes)
  while (memInFlight > 0 && memInFlight + reserved > MEM_BUDGET_BYTES) {
    await new Promise((r) => setTimeout(r, 250))
  }
  memInFlight += reserved
  try {
    return await fn()
  } finally {
    memInFlight = Math.max(0, memInFlight - reserved)
  }
}

const RUNNING = new Set<string>()
const STOP_SIGNALS = new Set<string>()

/** Demande l'arrêt propre d'une migration (vérifié entre deux lots). */
export function signalStopXimi(id: string) {
  STOP_SIGNALS.add(id)
}

let workerStarted = false

export function startXimiMigrationWorker() {
  if (workerStarted) return
  workerStarted = true
  console.log(
    `[ximi-worker] started — batch=${BATCH_SIZE}, budget mém=${Math.round(MEM_BUDGET_BYTES / 1024 / 1024)} Mo, ` +
      `seuil flux=${Math.round(STREAM_THRESHOLD_BYTES / 1024 / 1024)} Mo`,
  )
  setInterval(() => {
    pollAndProcess().catch((err) => console.error('[ximi-worker] tick error:', err))
  }, POLL_INTERVAL_MS)
}

function startHeartbeat(id: string): () => void {
  const timer = setInterval(() => {
    void db
      .update(ximiMigrations)
      .set({ updatedAt: new Date() })
      .where(eq(ximiMigrations.id, id))
      .catch((err) =>
        console.warn(`[ximi-heartbeat] ${id}:`, err instanceof Error ? err.message : err),
      )
  }, HEARTBEAT_MS)
  return () => clearInterval(timer)
}

async function pollAndProcess() {
  const all = await db.select().from(ximiMigrations).where(eq(ximiMigrations.archived, 0))

  // Orphelins : 'running' sans worker vivant et inactif > 15 min → remis en file.
  for (const job of all) {
    if (job.status === 'running' && !RUNNING.has(job.id)) {
      const stale = Date.now() - new Date(job.updatedAt).getTime() > ORPHAN_STALE_MS
      if (stale) {
        console.warn(`[ximi-worker] orphan detected: ${job.id} — reset 'pending'`)
        await db
          .update(ximiMigrations)
          .set({ status: 'pending' })
          .where(eq(ximiMigrations.id, job.id))
        job.status = 'pending'
      }
    }
  }

  if (RUNNING.size > 0) return
  const next = all.find((j) => j.status === 'pending')
  if (!next) return

  RUNNING.add(next.id)
  processMigration(next)
    .catch((err) => console.error(`[ximi-worker] ${next.id} fatal:`, err))
    .finally(() => RUNNING.delete(next.id))
}

// ── État local d'une passe ────────────────────────────────────────────────────

interface ItemState {
  targetItemId: string | null
  isFolder: boolean
  name: string | null
  parentSpItemId: string | null
  /** Dernière modification source connue (ms) ; 0 = inconnue */
  lastModified: number
  deleted: boolean
}

interface PassCounters {
  created: number
  updated: number
  moved: number
  deleted: number
  failed: number
  skipped: number
  scanned: number
  migratedBytes: number
  processedBytes: number
}

async function processMigration(job: XimiMigration) {
  console.log(`[ximi] start ${job.id} (${job.sourceSiteName})`)
  const stopHeartbeat = startHeartbeat(job.id)
  try {
    const runStartedAt = new Date()
    await db
      .update(ximiMigrations)
      .set({ status: 'running', errorDetails: null, startedAt: runStartedAt, scannedItems: 0 })
      .where(eq(ximiMigrations.id, job.id))

    // 1) Bibliothèque source
    const sourceDriveId = job.sourceDriveId ?? (await resolveSourceDrive(job))

    // Mode analyse : on énumère et on compte, on ne crée ni ne transfère rien.
    if (job.analyzeOnly) {
      await runAnalysis(job, sourceDriveId)
      return
    }

    // 2) Site cible + 3) droits
    const target = await ensureTargetSite(job)
    await ensurePermissions(job)

    // 4) Passe de transfert
    const stopped = await runTransferPass(job, sourceDriveId, target)

    if (stopped) {
      STOP_SIGNALS.delete(job.id)
      await db
        .update(ximiMigrations)
        .set({ status: 'paused', finishedAt: new Date(), errorDetails: 'En pause' })
        .where(eq(ximiMigrations.id, job.id))
      console.log(`[ximi] paused ${job.id}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .update(ximiMigrations)
      .set({ status: 'error', errorDetails: msg.slice(0, 2000), finishedAt: new Date() })
      .where(eq(ximiMigrations.id, job.id))
    console.error(`[ximi] ${job.id} erreur fatale:`, msg)
  } finally {
    stopHeartbeat()
  }
}

/** Résout la bibliothèque de documents par défaut du site source et la mémorise. */
async function resolveSourceDrive(job: XimiMigration): Promise<string> {
  const drive = await getDefaultDrive(job.sourceSiteId, SOURCE)
  await db
    .update(ximiMigrations)
    .set({ sourceDriveId: drive.id, sourceDriveName: drive.name })
    .where(eq(ximiMigrations.id, job.id))
  return drive.id
}

/** Mode analyse : comptage du contenu source, sans création ni transfert. */
async function runAnalysis(job: XimiMigration, sourceDriveId: string): Promise<void> {
  let files = 0
  let bytes = 0
  await walkDelta(sourceDriveId, null, SOURCE, (items) => {
    for (const it of items) {
      if (it.isFolder || it.isRoot || it.deleted) continue
      files++
      bytes += it.size ?? 0
    }
  })
  const gb = (bytes / 1024 / 1024 / 1024).toFixed(2)
  await db
    .update(ximiMigrations)
    .set({
      status: 'success',
      finishedAt: new Date(),
      totalItems: files,
      totalBytes: bytes,
      errorDetails: `Analyse : ${files} fichiers, ${gb} Go`,
    })
    .where(eq(ximiMigrations.id, job.id))
  console.log(`[ximi] analyse ${job.id}: ${files} fichiers, ${gb} Go`)
}

interface TargetContext {
  siteId: string
  driveId: string
  rootItemId: string
}

/**
 * Garantit l'existence du site cible et de sa bibliothèque.
 *
 * Trois cas : site déjà résolu (rien à faire), site pré-existant fourni par
 * l'opérateur (on résout l'URL), site à créer (SPSiteManager). Dans tous les
 * cas on termine par une résolution Graph : c'est elle qui donne le `siteId`
 * dont dépend tout le transfert.
 */
async function ensureTargetSite(job: XimiMigration): Promise<TargetContext> {
  if (job.targetSiteId && job.targetDriveId) {
    return {
      siteId: job.targetSiteId,
      driveId: job.targetDriveId,
      rootItemId: await getRootItemId(job.targetDriveId),
    }
  }

  await db
    .update(ximiMigrations)
    .set({ siteStatus: 'running', siteError: null })
    .where(eq(ximiMigrations.id, job.id))

  try {
    let siteUrl: string
    if (job.targetPreexisting && job.targetSiteUrl) {
      siteUrl = job.targetSiteUrl
    } else {
      const alias = normalizeAlias(job.targetSiteAlias ?? job.sourceSiteName)
      if (!alias) throw new Error(`Alias de site cible vide ou invalide (source « ${job.sourceSiteName} »)`)
      siteUrl = targetSiteUrlFor(alias)
      // Un site déjà provisionné (run précédent interrompu après la création,
      // ou création manuelle) ne doit PAS être recréé : SPSiteManager
      // répondrait « alias déjà utilisé » et la migration s'arrêterait là.
      if (await siteExists(siteUrl)) {
        console.log(`[ximi] ${job.id}: site ${siteUrl} déjà présent — réutilisé`)
      } else {
        const created = await createCommunicationSite({
          title: job.targetSiteName ?? job.sourceSiteName,
          alias,
          description: `Site migré depuis ${job.sourceSiteUrl}`,
        })
        siteUrl = created.siteUrl
        console.log(`[ximi] ${job.id}: site cible créé → ${siteUrl}`)
      }
    }

    const site = await resolveSiteByUrl(siteUrl, TARGET)
    const drive = await getDefaultDrive(site.id, TARGET)
    await db
      .update(ximiMigrations)
      .set({
        targetSiteUrl: site.webUrl ?? siteUrl,
        targetSiteId: site.id,
        targetSiteName: site.displayName ?? site.name,
        targetDriveId: drive.id,
        siteStatus: 'success',
        siteError: null,
      })
      .where(eq(ximiMigrations.id, job.id))
    return { siteId: site.id, driveId: drive.id, rootItemId: await getRootItemId(drive.id) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .update(ximiMigrations)
      .set({ siteStatus: 'error', siteError: msg.slice(0, 2000) })
      .where(eq(ximiMigrations.id, job.id))
    throw err
  }
}

/**
 * Donne accès au site au groupe dynamique de l'agence.
 *
 * Volontairement NON bloquant : un groupe introuvable ou un refus d'ACL ne doit
 * pas empêcher le transfert des données. Le statut reste visible sur la carte et
 * l'attribution est rejouable seule.
 */
async function ensurePermissions(job: XimiMigration): Promise<void> {
  if (!job.dynamicGroupName) return
  const [fresh] = await db
    .select()
    .from(ximiMigrations)
    .where(eq(ximiMigrations.id, job.id))
    .limit(1)
  if (!fresh?.targetSiteUrl) return
  if (fresh.permissionStatus === 'success') return

  await db
    .update(ximiMigrations)
    .set({ permissionStatus: 'running', permissionError: null })
    .where(eq(ximiMigrations.id, job.id))
  try {
    let groupId = fresh.dynamicGroupId
    if (!groupId) {
      const group = await findGroupByExactName(fresh.dynamicGroupName!)
      if (!group) {
        throw new Error(
          `Groupe « ${fresh.dynamicGroupName} » introuvable sur le tenant Ouihelp — ` +
            `vérifie son nom exact, puis relance l'attribution.`,
        )
      }
      groupId = group.id
    }
    await grantGroupAccess({ siteUrl: fresh.targetSiteUrl, groupObjectId: groupId })
    await db
      .update(ximiMigrations)
      .set({ dynamicGroupId: groupId, permissionStatus: 'success', permissionError: null })
      .where(eq(ximiMigrations.id, job.id))
    console.log(`[ximi] ${job.id}: accès accordé à « ${fresh.dynamicGroupName} »`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .update(ximiMigrations)
      .set({ permissionStatus: 'error', permissionError: msg.slice(0, 2000) })
      .where(eq(ximiMigrations.id, job.id))
    console.warn(`[ximi] ${job.id}: attribution des droits échouée (non bloquant):`, msg)
  }
}

/**
 * Passe de transfert. Renvoie true si l'opérateur a demandé la pause.
 */
async function runTransferPass(
  job: XimiMigration,
  sourceDriveId: string,
  target: TargetContext,
): Promise<boolean> {
  // État déjà transféré : sert à la fois d'idempotence, de table de traduction
  // parent source → parent cible, et de mémoire des suppressions.
  const rows = await db
    .select()
    .from(ximiMigratedItems)
    .where(eq(ximiMigratedItems.migrationId, job.id))

  const state = new Map<string, ItemState>()
  for (const r of rows) {
    state.set(r.spItemId, {
      targetItemId: r.targetItemId,
      isFolder: r.isFolder,
      name: r.name,
      parentSpItemId: r.parentSpItemId,
      lastModified: r.spLastModified ? r.spLastModified.getTime() : 0,
      deleted: r.status === 'deleted',
    })
  }

  const c: PassCounters = {
    created: 0,
    updated: 0,
    moved: 0,
    deleted: 0,
    failed: 0,
    skipped: 0,
    scanned: 0,
    migratedBytes: rows.reduce((s, r) => (!r.isFolder && r.targetItemId ? s + (r.sizeBytes ?? 0) : s), 0),
    processedBytes: rows.reduce((s, r) => (r.isFolder ? s : s + (r.sizeBytes ?? 0)), 0),
  }

  const isFullPass = !job.deltaToken
  let deltaTokenToSave: string | null = null
  let totalFiles = job.totalItems
  let totalBytes = job.totalBytes

  // Pré-comptage — uniquement sur une pré-migration. Sans lui la barre monte
  // instantanément à 99 %. Sur une passe delta il n'a aucun sens (les totaux
  // restent ceux de la bibliothèque) et coûterait une énumération complète.
  if (isFullPass) {
    totalFiles = 0
    totalBytes = 0
    let flush = 0
    const { nextDeltaToken } = await walkDelta(sourceDriveId, null, SOURCE, async (items) => {
      for (const it of items) {
        if (it.isFolder || it.isRoot || it.deleted) continue
        totalFiles++
        totalBytes += it.size ?? 0
      }
      if (++flush >= 5) {
        flush = 0
        await db
          .update(ximiMigrations)
          .set({ totalItems: totalFiles, totalBytes })
          .where(eq(ximiMigrations.id, job.id))
      }
    })
    // On garde le jeton du COMPTAGE, pas celui du transfert : il correspond à un
    // instantané ANTÉRIEUR au transfert. Tout ce qui bouge pendant la passe sera
    // donc revu au delta suivant. L'inverse (jeton postérieur) perdrait ces
    // changements en silence.
    deltaTokenToSave = nextDeltaToken
    await db
      .update(ximiMigrations)
      .set({ totalItems: totalFiles, totalBytes })
      .where(eq(ximiMigrations.id, job.id))
    console.log(
      `[ximi] ${job.id} pré-comptage: ${totalFiles} fichiers, ${(totalBytes / 1024 / 1024).toFixed(0)} Mo`,
    )
  }

  /** Traduit un parent SOURCE en parent CIBLE. null = pas encore connu. */
  const resolveParent = (item: DeltaItem): string | null => {
    if (!item.parentId) return null
    const known = state.get(item.parentId)
    if (known?.targetItemId && !known.deleted) return known.targetItemId
    // Le parent est la racine du drive : elle n'a pas toujours de ligne en base
    // (elle n'est pas « migrée »), mais son équivalent cible est connu.
    if (item.parentPath === '' || item.parentPath === '/') return target.rootItemId
    return null
  }

  let stopped = false
  let sincePersist = 0
  const persist = async (force = false) => {
    if (!force && ++sincePersist < 5) return
    sincePersist = 0
    await db
      .update(ximiMigrations)
      .set({
        migratedItems: rows.filter((r) => !r.isFolder && r.targetItemId).length + c.created,
        updatedItems: c.updated,
        movedItems: c.moved,
        deletedItems: c.deleted,
        failedItems: c.failed,
        skippedItems: c.skipped,
        scannedItems: c.scanned,
        migratedBytes: c.migratedBytes,
        processedBytes: c.processedBytes,
      })
      .where(eq(ximiMigrations.id, job.id))
  }

  /** Items dont le parent n'était pas encore connu — rejoués en fin de passe. */
  const deferred: DeltaItem[] = []

  const applyPage = async (items: DeltaItem[]): Promise<void> => {
    if (STOP_SIGNALS.has(job.id)) {
      stopped = true
      return
    }
    // Racine : on mémorise sa correspondance, rien à créer.
    for (const it of items) {
      if (it.isRoot) state.set(it.id, {
        targetItemId: target.rootItemId,
        isFolder: true,
        name: it.name,
        parentSpItemId: null,
        lastModified: 0,
        deleted: false,
      })
    }

    const live = items.filter((i) => !i.isRoot && !i.deleted)
    const removed = items.filter((i) => !i.isRoot && i.deleted)

    // Dossiers d'abord et en SÉQUENTIEL : un enfant ne peut être créé qu'après
    // son parent, et Graph ne garantit pas l'ordre hiérarchique du delta.
    // Le tri par profondeur de chemin réduit fortement le nombre de reports.
    const folders = live
      .filter((i) => i.isFolder)
      .sort((a, b) => a.parentPath.split('/').length - b.parentPath.split('/').length)
    for (const f of folders) {
      if (STOP_SIGNALS.has(job.id)) {
        stopped = true
        return
      }
      const done = await applyFolder(f)
      if (!done) deferred.push(f)
    }

    // Fichiers par lots parallèles
    const files = live.filter((i) => !i.isFolder)
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      if (STOP_SIGNALS.has(job.id)) {
        stopped = true
        return
      }
      const batch = files.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(batch.map((f) => applyFile(f)))
      for (let k = 0; k < results.length; k++) {
        const res = results[k]!
        if (res.status === 'rejected') {
          const file = batch[k]!
          await recordFailure(file, res.reason)
        } else if (res.value === false) {
          deferred.push(batch[k]!)
        }
      }
      await persist()
    }

    // Suppressions en DERNIER : si un dossier et ses enfants sont supprimés dans
    // la même passe, supprimer le parent d'abord fait répondre 404 aux enfants —
    // traité comme un succès, ce qui est le bon comportement.
    for (const d of removed) {
      await applyDeletion(d)
    }
  }

  /** Crée / renomme / déplace un dossier. false = parent inconnu, à reporter. */
  const applyFolder = async (item: DeltaItem): Promise<boolean> => {
    c.scanned++
    const prev = state.get(item.id)
    const parentTargetId = resolveParent(item)
    if (!parentTargetId) return false

    try {
      if (!prev || !prev.targetItemId || prev.deleted) {
        const targetId = await createTargetFolder(target.driveId, parentTargetId, item.name, {
          createdDateTime: item.createdDateTime,
          lastModifiedDateTime: item.lastModifiedDateTime,
        })
        await upsertItem(job.id, item, targetId, 'success')
        state.set(item.id, {
          targetItemId: targetId,
          isFolder: true,
          name: item.name,
          parentSpItemId: item.parentId,
          lastModified: parseTime(item.lastModifiedDateTime),
          deleted: false,
        })
        return true
      }
      // Renommage / déplacement d'un dossier existant : indispensable, sinon la
      // passe suivante le prendrait pour un nouveau dossier et dupliquerait
      // toute sa descendance côté cible.
      const renamed = prev.name !== item.name
      const movedOut = prev.parentSpItemId !== item.parentId
      if (renamed || movedOut) {
        await moveOrRenameTarget({
          driveId: target.driveId,
          itemId: prev.targetItemId,
          ...(renamed ? { newName: item.name } : {}),
          ...(movedOut ? { newParentItemId: parentTargetId } : {}),
        })
        c.moved++
        await upsertItem(job.id, item, prev.targetItemId, 'success')
        state.set(item.id, {
          ...prev,
          name: item.name,
          parentSpItemId: item.parentId,
          deleted: false,
        })
      }
      return true
    } catch (err) {
      await recordFailure(item, err)
      return true
    }
  }

  /** Crée / met à jour / déplace un fichier. false = parent inconnu, à reporter. */
  const applyFile = async (item: DeltaItem): Promise<boolean> => {
    c.scanned++
    const prev = state.get(item.id)
    const parentTargetId = resolveParent(item)
    if (!parentTargetId) return false

    const size = item.size ?? 0
    const times = {
      createdDateTime: item.createdDateTime,
      lastModifiedDateTime: item.lastModifiedDateTime,
    }

    // Trop volumineux → ignoré, PAS une erreur (à transférer à la main).
    if (size > MAX_FILE_BYTES) {
      await upsertItem(
        job.id,
        item,
        null,
        'skipped',
        `Fichier trop volumineux (${Math.round(size / 1024 / 1024)} Mo, limite ${MAX_FILE_BYTES / 1024 / 1024} Mo) — à transférer manuellement`,
      )
      c.skipped++
      c.processedBytes += size
      return true
    }

    const upload = async (name: string, replace: boolean): Promise<string> => {
      if (size > STREAM_THRESHOLD_BYTES) {
        return withMem(CHUNK_MEM_COST, () =>
          uploadLargeFile({
            driveId: target.driveId,
            parentItemId: parentTargetId,
            name,
            size,
            // Factory : la source n'est ouverte qu'une fois la session prête.
            openStream: () => openContentStream(sourceDriveId, item.id, SOURCE),
            times,
            replace,
          }),
        )
      }
      return withMem(size, async () => {
        const body = await downloadContent(sourceDriveId, item.id, SOURCE)
        return uploadSmallFile({
          driveId: target.driveId,
          parentItemId: parentTargetId,
          name,
          body,
          times,
          replace,
        })
      })
    }

    // ── Nouveau fichier ────────────────────────────────────────────────────
    if (!prev || !prev.targetItemId || prev.deleted) {
      const targetId = await upload(item.name, false)
      await upsertItem(job.id, item, targetId, 'success')
      state.set(item.id, {
        targetItemId: targetId,
        isFolder: false,
        name: item.name,
        parentSpItemId: item.parentId,
        lastModified: parseTime(item.lastModifiedDateTime),
        deleted: false,
      })
      c.created++
      c.migratedBytes += size
      c.processedBytes += size
      return true
    }

    // ── Fichier connu : renommage/déplacement puis contenu ─────────────────
    // L'ordre compte : l'upload de remplacement cible un CHEMIN (parent + nom).
    // Renommer d'abord garantit qu'on remplace bien le bon fichier au lieu d'en
    // créer un second sous l'ancien nom.
    const renamed = prev.name !== item.name
    const movedOut = prev.parentSpItemId !== item.parentId
    if (renamed || movedOut) {
      await moveOrRenameTarget({
        driveId: target.driveId,
        itemId: prev.targetItemId,
        ...(renamed ? { newName: item.name } : {}),
        ...(movedOut ? { newParentItemId: parentTargetId } : {}),
      })
      c.moved++
    }

    const spMod = parseTime(item.lastModifiedDateTime)
    // Date illisible → on ne touche pas au contenu : ne jamais ré-uploader dans
    // le doute, une passe delta doit rester courte.
    const contentChanged = spMod > 0 && spMod > prev.lastModified
    if (contentChanged) {
      await upload(item.name, true)
      c.updated++
      c.processedBytes += size
    }
    if (renamed || movedOut || contentChanged) {
      await upsertItem(job.id, item, prev.targetItemId, 'success')
      state.set(item.id, {
        targetItemId: prev.targetItemId,
        isFolder: false,
        name: item.name,
        parentSpItemId: item.parentId,
        lastModified: contentChanged ? spMod : prev.lastModified,
        deleted: false,
      })
    }
    return true
  }

  /** Répercute une suppression source côté cible (→ corbeille du site). */
  const applyDeletion = async (item: DeltaItem): Promise<void> => {
    c.scanned++
    const prev = state.get(item.id)
    // Jamais migré, ou déjà supprimé : rien à faire. Ne pas compter comme une
    // erreur — un delta rejoue volontiers des suppressions déjà traitées.
    if (!prev || !prev.targetItemId || prev.deleted) return
    try {
      await deleteTargetItem(target.driveId, prev.targetItemId)
      await db
        .update(ximiMigratedItems)
        .set({ status: 'deleted', deletedAt: new Date(), syncedAt: new Date(), errorDetails: null })
        .where(
          and(eq(ximiMigratedItems.migrationId, job.id), eq(ximiMigratedItems.spItemId, item.id)),
        )
      state.set(item.id, { ...prev, deleted: true })
      c.deleted++
    } catch (err) {
      await recordFailure(item, err)
    }
  }

  const recordFailure = async (item: DeltaItem, err: unknown): Promise<void> => {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 2000)
    await upsertItem(job.id, item, state.get(item.id)?.targetItemId ?? null, 'error', msg)
    c.failed++
    if (!item.isFolder) c.processedBytes += item.size ?? 0
    console.warn(`[ximi] ${item.name} erreur:`, msg.slice(0, 200))
  }

  // ── Énumération ────────────────────────────────────────────────────────────
  let resyncNeeded = false
  try {
    const { nextDeltaToken } = await walkDelta(
      sourceDriveId,
      job.deltaToken ?? null,
      SOURCE,
      applyPage,
    )
    // Sur une passe delta, le jeton du parcours EST le bon (pas de pré-comptage
    // qui l'aurait devancé).
    if (!isFullPass) deltaTokenToSave = nextDeltaToken
  } catch (err) {
    if (err instanceof DeltaResyncRequired) {
      // Le jeton est périmé (site restauré, changement de bibliothèque…). On
      // efface le jeton : la prochaine passe repartira d'une énumération
      // complète, idempotente grâce à la table de correspondance.
      await db
        .update(ximiMigrations)
        .set({ deltaToken: null })
        .where(eq(ximiMigrations.id, job.id))
      resyncNeeded = true
    } else {
      throw err
    }
  }

  // Reports : items vus avant leur parent. Plusieurs tours car un report peut
  // débloquer un autre report (chaîne de dossiers imbriqués).
  if (!stopped && deferred.length > 0) {
    let pending = deferred
    for (let round = 0; round < 10 && pending.length > 0; round++) {
      const stillPending: DeltaItem[] = []
      for (const item of pending) {
        if (STOP_SIGNALS.has(job.id)) {
          stopped = true
          break
        }
        const ok = item.isFolder ? await applyFolder(item) : await applyFile(item).catch(async (e) => {
          await recordFailure(item, e)
          return true
        })
        if (!ok) stillPending.push(item)
      }
      if (stopped) break
      if (stillPending.length === pending.length) {
        // Aucun progrès : le parent est réellement introuvable (supprimé côté
        // source entre le delta et maintenant, ou en erreur). On les marque en
        // échec plutôt que de boucler.
        for (const item of stillPending) {
          await recordFailure(item, new Error('Dossier parent introuvable côté cible'))
        }
        pending = []
        break
      }
      pending = stillPending
    }
  }

  await persist(true)

  if (stopped) return true

  // 5) Jeton delta : enregistré UNIQUEMENT après une passe complète non
  // interrompue. Le sauver après une pause ferait sauter tout ce qui restait.
  const finishedAt = new Date()
  const [current] = await db
    .select({ migratedItems: ximiMigrations.migratedItems })
    .from(ximiMigrations)
    .where(eq(ximiMigrations.id, job.id))
    .limit(1)

  const summary =
    `${c.created} créés, ${c.updated} mis à jour, ${c.moved} déplacés/renommés, ` +
    `${c.deleted} supprimés, ${c.failed} en erreur, ${c.skipped} ignorés`
  await db
    .update(ximiMigrations)
    .set({
      status: c.failed === 0 ? 'success' : 'error',
      finishedAt,
      ...(deltaTokenToSave && !resyncNeeded
        ? { deltaToken: deltaTokenToSave, lastDeltaAt: finishedAt }
        : {}),
      errorDetails: resyncNeeded
        ? `Jeton delta périmé — la prochaine passe refera une énumération complète. ${summary}`
        : c.failed > 0
          ? `${c.failed} élément(s) en erreur — ${summary}`
          : null,
    })
    .where(eq(ximiMigrations.id, job.id))

  console.log(
    `[ximi] done ${job.id}: ${summary} (total migrés ${current?.migratedItems ?? 0})`,
  )
  return false
}

// ── Utilitaires ───────────────────────────────────────────────────────────────

function parseTime(iso: string | null): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** Chemin lisible d'un item (pour l'affichage des erreurs / changements). */
function itemPath(item: DeltaItem): string {
  const parent = item.parentPath.replace(/^\/+/, '')
  return (parent ? `${parent}/${item.name}` : item.name).slice(0, 1500)
}

async function upsertItem(
  migrationId: string,
  item: DeltaItem,
  targetItemId: string | null,
  status: 'success' | 'error' | 'skipped',
  errorDetails?: string,
): Promise<void> {
  const now = new Date()
  /**
   * `sp_last_modified` est la RÉFÉRENCE de la synchro delta : « ce que la cible
   * contient date de cet instant côté source ». On ne l'écrit donc QUE sur un
   * succès. L'inscrire sur un échec ferait passer le fichier pour à jour à la
   * passe suivante — il ne serait jamais retenté et la cible garderait
   * indéfiniment un contenu périmé, en silence.
   */
  const dateOnSuccess =
    status === 'success' && item.lastModifiedDateTime
      ? { spLastModified: new Date(item.lastModifiedDateTime) }
      : {}
  await db
    .insert(ximiMigratedItems)
    .values({
      migrationId,
      spItemId: item.id,
      parentSpItemId: item.parentId,
      name: item.name,
      spPath: itemPath(item),
      isFolder: item.isFolder,
      sizeBytes: item.size ?? null,
      targetItemId,
      status,
      errorDetails: errorDetails ?? null,
      syncedAt: now,
      // Une ré-apparition après suppression doit repartir propre.
      deletedAt: null,
      ...dateOnSuccess,
    })
    .onDuplicateKeyUpdate({
      set: {
        parentSpItemId: item.parentId,
        name: item.name,
        spPath: itemPath(item),
        sizeBytes: item.size ?? null,
        // Ne JAMAIS écraser un id cible connu par null : sur une erreur, la
        // ligne doit conserver l'id du fichier déjà créé, sinon la passe
        // suivante le prendrait pour un nouvel item et créerait un DOUBLON.
        ...(targetItemId ? { targetItemId } : {}),
        status,
        errorDetails: errorDetails ?? null,
        syncedAt: now,
        deletedAt: null,
        ...dateOnSuccess,
      },
    })
}
