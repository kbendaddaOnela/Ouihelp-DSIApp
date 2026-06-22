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
import { listChildren, getDownloadUrl, openDownloadStream } from './sharepointService'
import { getSharedDrive, createFolder, uploadFile } from './googleDriveService'

const POLL_INTERVAL_MS = 5000
const BATCH_SIZE = 3 // fichiers transférés en parallèle par dossier
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
  try {
    await db
      .update(sharepointMigrations)
      .set({ status: 'running', errorDetails: null, startedAt: new Date() })
      .where(eq(sharepointMigrations.id, job.id))

    // 1) Valider le Shared Drive cible (créé manuellement par l'admin)
    const sharedDriveId = job.gdSharedDriveId
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

    await db
      .update(sharepointMigrations)
      .set({ migratedItems: migrated, failedItems: 0 })
      .where(eq(sharepointMigrations.id, job.id))

    // 3) Parcours BFS
    const queue: QueueEntry[] = [
      { spFolderId: job.rootItemId, gdParentId: sharedDriveId, path: job.rootPath ?? '' },
    ]
    let stoppedByUser = false

    const persistCounters = () =>
      db
        .update(sharepointMigrations)
        .set({ migratedItems: migrated, failedItems: failed, totalItems: discovered, migratedBytes })
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
          gdId = await createFolder(child.name, gdParentId)
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
            const dlUrl = await getDownloadUrl(job.driveId, file.id)
            const { body, size } = await openDownloadStream(dlUrl)
            const gdFileId = await uploadFile({
              name: file.name,
              parentId: gdParentId,
              body,
              size: size ?? file.size,
            })
            return { file, skipped: false as const, gdFileId, bytes: file.size ?? size ?? 0 }
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
          totalItems: discovered,
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
        totalItems: discovered,
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
  }
}
