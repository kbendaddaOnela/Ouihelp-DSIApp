// Worker in-process pour migrer une boîte aux lettres PARTAGÉE Exchange
// vers l'archive d'un Google Group (sans consommer de licence Workspace).
//
// Polling 5s sur step_mail_import='pending'. Une seule migration partagée à
// la fois (les BAL partagées sont peu nombreuses, pas besoin de concurrence).

import { eq } from 'drizzle-orm'
import { db } from '../../db/index'
import { sharedMigrations, sharedMigratedMessages, type SharedMigration } from './schema'
import {
  countOnelaMessages,
  iterateOnelaMessages,
  fetchOnelaMessageMime,
  listOnelaFolders,
  type GraphFolder,
  type GraphMessageMeta,
} from '../migration/mailService'
import { ensureGoogleGroup, archiveMessageToGroup } from './googleGroupsService'

// eslint-disable-next-line no-control-regex
const sanitize = (s: string | undefined | null, maxLen = 500): string | null =>
  s ? s.replace(/[\u{10000}-\u{10FFFF}]/gu, '').slice(0, maxLen) || null : null

const POLL_INTERVAL_MS = 5000
const BATCH_SIZE = 2 // 2 imports en parallèle (Groups Migration API throttle vite)
const HEARTBEAT_MS = 60_000
const ORPHAN_STALE_MS = 15 * 60 * 1000

const RUNNING = new Set<string>()

let workerStarted = false

export function startSharedMailboxWorker() {
  if (workerStarted) return
  workerStarted = true
  console.log('[shared-mailbox-worker] started')
  setInterval(() => {
    pollAndProcess().catch((err) =>
      console.error('[shared-mailbox-worker] tick error:', err),
    )
  }, POLL_INTERVAL_MS)
}

function startHeartbeat(id: string): () => void {
  const timer = setInterval(() => {
    void db
      .update(sharedMigrations)
      .set({ updatedAt: new Date() })
      .where(eq(sharedMigrations.id, id))
      .catch((err) =>
        console.warn(`[shared-heartbeat] ${id}:`, err instanceof Error ? err.message : err),
      )
  }, HEARTBEAT_MS)
  return () => clearInterval(timer)
}

async function pollAndProcess() {
  const all = await db.select().from(sharedMigrations)

  // Détection d'orphelins : si 'running' mais pas dans RUNNING et updatedAt > 15min → reset
  for (const job of all) {
    if (job.stepMailImport === 'running' && !RUNNING.has(job.id)) {
      const stale = Date.now() - new Date(job.updatedAt).getTime() > ORPHAN_STALE_MS
      if (stale) {
        console.warn(
          `[shared-mailbox-worker] orphan detected: ${job.id} (inactive since ${job.updatedAt}) — resetting to 'pending'`,
        )
        await db
          .update(sharedMigrations)
          .set({ stepMailImport: 'pending' })
          .where(eq(sharedMigrations.id, job.id))
        job.stepMailImport = 'pending'
      }
    }
  }

  // Pick first pending job (single-instance — pas de concurrence)
  if (RUNNING.size > 0) return
  const next = all.find((j) => j.stepMailImport === 'pending')
  if (!next) return

  RUNNING.add(next.id)
  processSharedMailbox(next)
    .catch((err) => console.error(`[shared-mailbox-worker] ${next.id} fatal:`, err))
    .finally(() => RUNNING.delete(next.id))
}

async function processSharedMailbox(job: SharedMigration) {
  console.log(`[shared] start ${job.id} (${job.onelaEmail} → ${job.targetGroupEmail})`)
  const stopHeartbeat = startHeartbeat(job.id)
  try {
    // 1) Garantir l'existence du groupe Google
    if (job.stepCreateGroup !== 'success') {
      await db
        .update(sharedMigrations)
        .set({ stepCreateGroup: 'running', createGroupError: null })
        .where(eq(sharedMigrations.id, job.id))
      try {
        const group = await ensureGoogleGroup({
          email: job.targetGroupEmail,
          name: job.targetGroupName,
        })
        await db
          .update(sharedMigrations)
          .set({
            stepCreateGroup: 'success',
            targetGroupId: group.id,
            createGroupError: null,
          })
          .where(eq(sharedMigrations.id, job.id))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await db
          .update(sharedMigrations)
          .set({
            stepCreateGroup: 'error',
            createGroupError: msg,
            stepMailImport: 'error',
            mailError: 'Création du groupe échouée',
          })
          .where(eq(sharedMigrations.id, job.id))
        return
      }
    }

    // 2) Import des mails dans l'archive du groupe
    // Idempotence : on skippe les messages déjà marqués success/skipped en base
    const already = await db
      .select({ graphMessageId: sharedMigratedMessages.graphMessageId, status: sharedMigratedMessages.status })
      .from(sharedMigratedMessages)
      .where(eq(sharedMigratedMessages.sharedMigrationId, job.id))
    const skipSet = new Set(
      already.filter((r) => r.status === 'success' || r.status === 'skipped').map((r) => r.graphMessageId),
    )
    const alreadySuccess = already.filter((r) => r.status === 'success').length

    console.log(
      `[shared] resume ${job.id}: ${alreadySuccess} OK déjà importés, ${skipSet.size} à skipper`,
    )

    await db
      .update(sharedMigrations)
      .set({
        stepMailImport: 'running',
        mailStartedAt: new Date(),
        mailError: null,
        mailMigrated: alreadySuccess,
        mailFailed: 0,
      })
      .where(eq(sharedMigrations.id, job.id))

    // Pré-compte (somme des totalItemCount des dossiers visibles, hors Recoverable Items)
    const folders = await listOnelaFolders(job.onelaUserId)
    const folderById = new Map<string, GraphFolder>(folders.map((f) => [f.id, f]))
    let total = 0
    try {
      total = await countOnelaMessages(job.onelaUserId, null, folders)
      await db
        .update(sharedMigrations)
        .set({ mailTotal: total })
        .where(eq(sharedMigrations.id, job.id))
    } catch (err) {
      console.warn('[shared] pre-count failed:', err instanceof Error ? err.message : err)
    }

    let migrated = alreadySuccess
    let failed = 0
    let skipped = 0
    const iter = iterateOnelaMessages(job.onelaUserId, null)
    let buffer: GraphMessageMeta[] = []

    const flush = async (batch: typeof buffer) => {
      const toProcess = batch.filter((msg) => {
        if (skipSet.has(msg.id)) {
          skipped++
          return false
        }
        if (msg.parentFolderId && !folderById.has(msg.parentFolderId)) {
          // Dossier caché (Recoverable Items) → skip silencieux
          skipped++
          return false
        }
        return true
      })

      const results = await Promise.allSettled(
        toProcess.map(async (msg) => {
          const rawMime = await fetchOnelaMessageMime(job.onelaUserId, msg.id)
          await archiveMessageToGroup({ groupEmail: job.targetGroupEmail, rawMime })
          return msg
        }),
      )

      for (let i = 0; i < results.length; i++) {
        const msg = toProcess[i]!
        const res = results[i]!
        if (res.status === 'fulfilled') {
          await db
            .insert(sharedMigratedMessages)
            .values({
              sharedMigrationId: job.id,
              graphMessageId: msg.id,
              internetMessageId: msg.internetMessageId ?? null,
              subject: sanitize(msg.subject),
              receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
              status: 'success',
            })
            .onDuplicateKeyUpdate({
              set: { status: 'success', errorDetails: null },
            })
          migrated++
        } else {
          const errorDetails =
            sanitize(res.reason instanceof Error ? res.reason.message : String(res.reason), 2000) ?? 'unknown'
          await db
            .insert(sharedMigratedMessages)
            .values({
              sharedMigrationId: job.id,
              graphMessageId: msg.id,
              internetMessageId: msg.internetMessageId ?? null,
              subject: sanitize(msg.subject),
              receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
              status: 'error',
              errorDetails,
            })
            .onDuplicateKeyUpdate({ set: { status: 'error', errorDetails } })
          failed++
          console.warn(`[shared] msg ${msg.id} error:`, errorDetails.slice(0, 200))
        }
      }

      await db
        .update(sharedMigrations)
        .set({ mailMigrated: migrated, mailFailed: failed })
        .where(eq(sharedMigrations.id, job.id))
    }

    for await (const msg of iter) {
      buffer.push(msg)
      if (buffer.length >= BATCH_SIZE) {
        await flush(buffer)
        buffer = []
        // Délai léger anti-throttle
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (buffer.length > 0) await flush(buffer)

    const success = failed === 0
    await db
      .update(sharedMigrations)
      .set({
        stepMailImport: success ? 'success' : 'error',
        mailFinishedAt: new Date(),
        mailError: failed > 0 ? `${failed} message(s) en erreur` : null,
      })
      .where(eq(sharedMigrations.id, job.id))

    console.log(`[shared] done ${job.id}: ${migrated}/${total} OK, ${failed} fail, ${skipped} skip`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .update(sharedMigrations)
      .set({ stepMailImport: 'error', mailError: msg, mailFinishedAt: new Date() })
      .where(eq(sharedMigrations.id, job.id))
  } finally {
    stopHeartbeat()
  }
}
