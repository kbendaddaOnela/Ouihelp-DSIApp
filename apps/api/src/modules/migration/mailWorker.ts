// Worker in-process pour migrer les mails Exchange → Gmail
// - Polling toutes les 5s sur step_mail_migration='pending'
// - Max 3 users en parallèle (throttling Graph + Gmail)
// - Reprise automatique : skip les graph_message_id déjà présents en DB

import { eq, and } from 'drizzle-orm'
import { db } from '../../db/index'
import { migrations, migratedMessages, type Migration } from './schema'
import {
  iterateOnelaMessages,
  fetchOnelaMessageMime,
  listOnelaFolders,
  buildLabelResolver,
  gmailImportMime,
  type GraphFolder,
} from './mailService'

const MAX_CONCURRENT = 3
const POLL_INTERVAL_MS = 5000
const RUNNING = new Set<string>()

let workerStarted = false

export function startMailWorker() {
  if (workerStarted) return
  workerStarted = true
  console.log('[mail-worker] started')
  setInterval(() => {
    pollAndProcess().catch((err) => console.error('[mail-worker] tick error:', err))
  }, POLL_INTERVAL_MS)
  // Premier tick immédiat
  pollAndProcess().catch((err) => console.error('[mail-worker] initial tick error:', err))
}

async function pollAndProcess() {
  if (RUNNING.size >= MAX_CONCURRENT) return

  const slots = MAX_CONCURRENT - RUNNING.size
  const candidates = await db
    .select()
    .from(migrations)
    .where(eq(migrations.stepMailMigration, 'pending'))
    .limit(slots)

  for (const job of candidates) {
    if (RUNNING.has(job.id)) continue
    if (RUNNING.size >= MAX_CONCURRENT) break
    RUNNING.add(job.id)
    // fire-and-forget : le worker continue à tourner
    processUserMail(job)
      .catch((err) => console.error(`[mail-worker] job ${job.id} fatal:`, err))
      .finally(() => RUNNING.delete(job.id))
  }
}

async function processUserMail(job: Migration) {
  const startedAt = new Date()
  console.log(`[mail-worker] start ${job.id} (${job.onelaUpn} → ${job.gohUpn})`)

  if (!job.gohUpn) {
    await markError(job.id, 'gohUpn manquant')
    return
  }

  try {
    await db
      .update(migrations)
      .set({ stepMailMigration: 'running', mailStartedAt: startedAt, mailError: null })
      .where(eq(migrations.id, job.id))

    // 1. Lister les folders ONELA + construire le mapping label Gmail
    const folders = await listOnelaFolders(job.onelaUserId)
    const folderById = new Map<string, GraphFolder>(folders.map((f) => [f.id, f]))
    const resolver = await buildLabelResolver(job.gohUpn, folders)

    // 2. Charger les message IDs déjà migrés (reprise idempotente)
    const alreadyMigratedRows = await db
      .select({ graphMessageId: migratedMessages.graphMessageId })
      .from(migratedMessages)
      .where(eq(migratedMessages.migrationId, job.id))
    const skipSet = new Set(alreadyMigratedRows.map((r) => r.graphMessageId))

    let migrated = job.mailMigrated
    let failed = job.mailFailed
    let total = job.mailTotal

    // 3. Itérer tous les messages
    for await (const msg of iterateOnelaMessages(job.onelaUserId)) {
      total++
      if (skipSet.has(msg.id)) continue

      try {
        const rawMime = await fetchOnelaMessageMime(job.onelaUserId, msg.id)
        const folder = msg.parentFolderId ? folderById.get(msg.parentFolderId) : undefined
        const labelIds = folder
          ? await resolver.resolve(folder)
          : ['INBOX']

        // Brouillons → DRAFT label uniquement
        const finalLabels = msg.isDraft ? ['DRAFT'] : labelIds

        const result = await gmailImportMime({
          userEmail: job.gohUpn,
          rawMime,
          labelIds: finalLabels,
          isDraft: msg.isDraft,
          isRead: msg.isRead,
        })

        await db.insert(migratedMessages).values({
          migrationId: job.id,
          graphMessageId: msg.id,
          internetMessageId: msg.internetMessageId ?? null,
          gmailMessageId: result.id,
          status: 'success',
        })
        migrated++
      } catch (err) {
        const errorDetails = err instanceof Error ? err.message : String(err)
        try {
          await db.insert(migratedMessages).values({
            migrationId: job.id,
            graphMessageId: msg.id,
            internetMessageId: msg.internetMessageId ?? null,
            status: 'error',
            errorDetails,
          })
        } catch { /* unique violation = déjà loggé */ }
        failed++
        console.warn(`[mail-worker] msg ${msg.id} error:`, errorDetails.slice(0, 200))
      }

      // Update progress toutes les 25 messages
      if ((migrated + failed) % 25 === 0) {
        await db
          .update(migrations)
          .set({ mailTotal: total, mailMigrated: migrated, mailFailed: failed })
          .where(eq(migrations.id, job.id))
      }
    }

    // 4. Final update
    await db
      .update(migrations)
      .set({
        stepMailMigration: failed === 0 ? 'success' : 'error',
        mailTotal: total,
        mailMigrated: migrated,
        mailFailed: failed,
        mailFinishedAt: new Date(),
        mailError: failed > 0 ? `${failed} message(s) en erreur` : null,
      })
      .where(eq(migrations.id, job.id))

    console.log(`[mail-worker] done ${job.id}: ${migrated}/${total} OK, ${failed} fail`)
  } catch (err) {
    await markError(job.id, err instanceof Error ? err.message : String(err))
  }
}

async function markError(id: string, message: string) {
  console.error(`[mail-worker] ${id} fatal: ${message}`)
  await db
    .update(migrations)
    .set({
      stepMailMigration: 'error',
      mailError: message,
      mailFinishedAt: new Date(),
    })
    .where(eq(migrations.id, id))
}

export async function enqueueMailMigration(migrationId: string): Promise<void> {
  await db
    .update(migrations)
    .set({
      stepMailMigration: 'pending',
      mailError: null,
      mailStartedAt: null,
      mailFinishedAt: null,
      // On ne reset PAS mailTotal/mailMigrated/mailFailed pour conserver les compteurs cumulés sur reprise
    })
    .where(and(eq(migrations.id, migrationId)))
}
