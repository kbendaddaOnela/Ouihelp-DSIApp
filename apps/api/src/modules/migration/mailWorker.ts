// Worker in-process pour migrer mail + calendrier + contacts (Exchange → Google)
// - Polling 5s sur step_*_migration='pending'
// - Max 3 jobs simultanés (toutes phases confondues)

import { eq, and } from 'drizzle-orm'
import { db } from '../../db/index'
import { migrations, migratedMessages, migratedEvents, migratedContacts, type Migration } from './schema'
import {
  countOnelaMessages,
  iterateOnelaMessages,
  fetchOnelaMessageMime,
  listOnelaFolders,
  buildLabelResolver,
  gmailImportMime,
  type GraphFolder,
} from './mailService'
import { countOnelaEvents, iterateOnelaEvents, googleCalendarImportEvent } from './calendarService'
import { countOnelaContacts, iterateOnelaContacts, googlePeopleCreateContact } from './contactsService'

const MAX_CONCURRENT = 3
const POLL_INTERVAL_MS = 5000
const RUNNING = new Map<string, 'mail' | 'calendar' | 'contacts'>()

let workerStarted = false

export function startMailWorker() {
  if (workerStarted) return
  workerStarted = true
  console.log('[migration-worker] started')
  setInterval(() => {
    pollAndProcess().catch((err) => console.error('[migration-worker] tick error:', err))
  }, POLL_INTERVAL_MS)
  pollAndProcess().catch((err) => console.error('[migration-worker] initial tick error:', err))
}

async function pollAndProcess() {
  if (RUNNING.size >= MAX_CONCURRENT) return
  const slots = MAX_CONCURRENT - RUNNING.size

  // On cherche tous les jobs pending sur n'importe laquelle des 3 phases
  const candidates = await db.select().from(migrations)
  const pending: Array<{ job: Migration; phase: 'mail' | 'calendar' | 'contacts' }> = []

  for (const job of candidates) {
    const key = `${job.id}-mail`
    if (job.stepMailMigration === 'pending' && !RUNNING.has(key)) {
      pending.push({ job, phase: 'mail' })
    }
    const keyC = `${job.id}-calendar`
    if (job.stepCalendarMigration === 'pending' && !RUNNING.has(keyC)) {
      pending.push({ job, phase: 'calendar' })
    }
    const keyK = `${job.id}-contacts`
    if (job.stepContactsMigration === 'pending' && !RUNNING.has(keyK)) {
      pending.push({ job, phase: 'contacts' })
    }
    if (pending.length >= slots) break
  }

  for (const { job, phase } of pending.slice(0, slots)) {
    const key = `${job.id}-${phase}`
    RUNNING.set(key, phase)
    const fn =
      phase === 'mail' ? processUserMail
      : phase === 'calendar' ? processUserCalendar
      : processUserContacts
    fn(job)
      .catch((err) => console.error(`[migration-worker] ${key} fatal:`, err))
      .finally(() => RUNNING.delete(key))
  }
}

// ── Phase mail ────────────────────────────────────────────────────────────────

async function processUserMail(job: Migration) {
  console.log(`[mail] start ${job.id} (${job.onelaUpn} → ${job.gohUpn})`)
  if (!job.gohUpn) return markStepError(job.id, 'mail', 'gohUpn manquant')

  try {
    await db.update(migrations)
      .set({
        stepMailMigration: 'running',
        mailStartedAt: new Date(),
        mailError: null,
        // Reset counters : ils reflètent uniquement cette synchro
        mailTotal: 0, mailMigrated: 0, mailFailed: 0,
      })
      .where(eq(migrations.id, job.id))

    const folders = await listOnelaFolders(job.onelaUserId)
    const folderById = new Map<string, GraphFolder>(folders.map((f) => [f.id, f]))
    const resolver = await buildLabelResolver(job.gohUpn, folders)

    const already = await db
      .select({ graphMessageId: migratedMessages.graphMessageId })
      .from(migratedMessages)
      .where(eq(migratedMessages.migrationId, job.id))
    const skipSet = new Set(already.map((r) => r.graphMessageId))

    let migrated = 0
    let failed = 0
    let total = 0
    let preCountSet = false
    try {
      total = await countOnelaMessages(job.onelaUserId, job.mailLastSyncAt)
      preCountSet = true
      await db.update(migrations).set({ mailTotal: total }).where(eq(migrations.id, job.id))
    } catch (countErr) {
      console.warn('[mail] pre-count failed, will count during iteration:', countErr instanceof Error ? countErr.message : countErr)
    }

    const syncStartedAt = new Date()
    for await (const msg of iterateOnelaMessages(job.onelaUserId, job.mailLastSyncAt)) {
      if (!preCountSet) total++
      if (skipSet.has(msg.id)) continue

      try {
        const rawMime = await fetchOnelaMessageMime(job.onelaUserId, msg.id)
        const folder = msg.parentFolderId ? folderById.get(msg.parentFolderId) : undefined
        const labelIds = folder ? await resolver.resolve(folder) : ['INBOX']
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
        } catch { /* dup */ }
        failed++
        console.warn(`[mail] msg ${msg.id} error:`, errorDetails.slice(0, 200))
      }

      if ((migrated + failed) % 25 === 0) {
        await db.update(migrations)
          .set({ mailTotal: total, mailMigrated: migrated, mailFailed: failed })
          .where(eq(migrations.id, job.id))
      }
    }

    const success = failed === 0
    // L'itération a terminé normalement → lastSyncAt avance toujours, même si des messages
    // individuels ont échoué (ils sont en DB avec status='error', skippés au prochain run).
    await db.update(migrations)
      .set({
        stepMailMigration: success ? 'success' : 'error',
        mailTotal: total, mailMigrated: migrated, mailFailed: failed,
        mailFinishedAt: new Date(),
        mailLastSyncAt: syncStartedAt,
        mailError: failed > 0 ? `${failed} message(s) en erreur` : null,
      })
      .where(eq(migrations.id, job.id))

    console.log(`[mail] done ${job.id}: ${migrated}/${total} OK, ${failed} fail`)
  } catch (err) {
    await markStepError(job.id, 'mail', err instanceof Error ? err.message : String(err))
  }
}

// ── Phase calendrier ──────────────────────────────────────────────────────────

async function processUserCalendar(job: Migration) {
  console.log(`[calendar] start ${job.id} (${job.onelaUpn} → ${job.gohUpn})`)
  if (!job.gohUpn) return markStepError(job.id, 'calendar', 'gohUpn manquant')

  try {
    await db.update(migrations)
      .set({
        stepCalendarMigration: 'running', calStartedAt: new Date(), calError: null,
        calTotal: 0, calMigrated: 0, calFailed: 0,
      })
      .where(eq(migrations.id, job.id))

    const already = await db
      .select({ graphEventId: migratedEvents.graphEventId })
      .from(migratedEvents)
      .where(eq(migratedEvents.migrationId, job.id))
    const skipSet = new Set(already.map((r) => r.graphEventId))

    let migrated = 0
    let failed = 0
    let total = 0
    let preCountSet = false
    try {
      total = await countOnelaEvents(job.onelaUserId, job.calLastSyncAt)
      preCountSet = true
      await db.update(migrations).set({ calTotal: total }).where(eq(migrations.id, job.id))
    } catch (countErr) {
      console.warn('[calendar] pre-count failed, will count during iteration:', countErr instanceof Error ? countErr.message : countErr)
    }

    const calSyncStart = new Date()
    for await (const ev of iterateOnelaEvents(job.onelaUserId, job.calLastSyncAt)) {
      if (!preCountSet) total++
      if (skipSet.has(ev.id)) continue

      try {
        const result = await googleCalendarImportEvent(job.gohUpn, ev)
        if (!result) {
          await db.insert(migratedEvents).values({
            migrationId: job.id,
            graphEventId: ev.id,
            iCalUid: ev.iCalUId ?? null,
            status: 'skipped',
            errorDetails: 'event sans start/end',
          })
          continue
        }
        await db.insert(migratedEvents).values({
          migrationId: job.id,
          graphEventId: ev.id,
          iCalUid: ev.iCalUId ?? null,
          googleEventId: result.id,
          status: 'success',
        })
        migrated++
      } catch (err) {
        const errorDetails = err instanceof Error ? err.message : String(err)
        try {
          await db.insert(migratedEvents).values({
            migrationId: job.id,
            graphEventId: ev.id,
            iCalUid: ev.iCalUId ?? null,
            status: 'error',
            errorDetails,
          })
        } catch { /* dup */ }
        failed++
        console.warn(`[calendar] event ${ev.id} error:`, errorDetails.slice(0, 200))
      }

      if ((migrated + failed) % 25 === 0) {
        await db.update(migrations)
          .set({ calTotal: total, calMigrated: migrated, calFailed: failed })
          .where(eq(migrations.id, job.id))
      }
    }

    const calSuccess = failed === 0
    await db.update(migrations)
      .set({
        stepCalendarMigration: calSuccess ? 'success' : 'error',
        calTotal: total, calMigrated: migrated, calFailed: failed,
        calFinishedAt: new Date(),
        calLastSyncAt: calSyncStart,
        calError: failed > 0 ? `${failed} événement(s) en erreur` : null,
      })
      .where(eq(migrations.id, job.id))

    console.log(`[calendar] done ${job.id}: ${migrated}/${total} OK, ${failed} fail`)
  } catch (err) {
    await markStepError(job.id, 'calendar', err instanceof Error ? err.message : String(err))
  }
}

// ── Phase contacts ────────────────────────────────────────────────────────────

async function processUserContacts(job: Migration) {
  console.log(`[contacts] start ${job.id} (${job.onelaUpn} → ${job.gohUpn})`)
  if (!job.gohUpn) return markStepError(job.id, 'contacts', 'gohUpn manquant')

  try {
    await db.update(migrations)
      .set({
        stepContactsMigration: 'running', contactsStartedAt: new Date(), contactsError: null,
        contactsTotal: 0, contactsMigrated: 0, contactsFailed: 0,
      })
      .where(eq(migrations.id, job.id))

    const already = await db
      .select({ graphContactId: migratedContacts.graphContactId })
      .from(migratedContacts)
      .where(eq(migratedContacts.migrationId, job.id))
    const skipSet = new Set(already.map((r) => r.graphContactId))

    let migrated = 0
    let failed = 0
    let total = 0
    let preCountSet = false
    try {
      total = await countOnelaContacts(job.onelaUserId, job.contactsLastSyncAt)
      preCountSet = true
      await db.update(migrations).set({ contactsTotal: total }).where(eq(migrations.id, job.id))
    } catch (countErr) {
      console.warn('[contacts] pre-count failed, will count during iteration:', countErr instanceof Error ? countErr.message : countErr)
    }

    const ctSyncStart = new Date()
    for await (const ct of iterateOnelaContacts(job.onelaUserId, job.contactsLastSyncAt)) {
      if (!preCountSet) total++
      if (skipSet.has(ct.id)) continue

      try {
        const result = await googlePeopleCreateContact(job.gohUpn, ct)
        await db.insert(migratedContacts).values({
          migrationId: job.id,
          graphContactId: ct.id,
          googleResourceName: result.resourceName,
          status: 'success',
        })
        migrated++
      } catch (err) {
        const errorDetails = err instanceof Error ? err.message : String(err)
        try {
          await db.insert(migratedContacts).values({
            migrationId: job.id,
            graphContactId: ct.id,
            status: 'error',
            errorDetails,
          })
        } catch { /* dup */ }
        failed++
        console.warn(`[contacts] ct ${ct.id} error:`, errorDetails.slice(0, 200))
      }

      if ((migrated + failed) % 25 === 0) {
        await db.update(migrations)
          .set({ contactsTotal: total, contactsMigrated: migrated, contactsFailed: failed })
          .where(eq(migrations.id, job.id))
      }
    }

    const ctSuccess = failed === 0
    await db.update(migrations)
      .set({
        stepContactsMigration: ctSuccess ? 'success' : 'error',
        contactsTotal: total, contactsMigrated: migrated, contactsFailed: failed,
        contactsFinishedAt: new Date(),
        contactsLastSyncAt: ctSyncStart,
        contactsError: failed > 0 ? `${failed} contact(s) en erreur` : null,
      })
      .where(eq(migrations.id, job.id))

    console.log(`[contacts] done ${job.id}: ${migrated}/${total} OK, ${failed} fail`)
  } catch (err) {
    await markStepError(job.id, 'contacts', err instanceof Error ? err.message : String(err))
  }
}

// ── Helpers communs ──────────────────────────────────────────────────────────

async function markStepError(id: string, phase: 'mail' | 'calendar' | 'contacts', message: string) {
  console.error(`[migration-worker] ${id} ${phase} fatal: ${message}`)
  if (phase === 'mail') {
    await db.update(migrations)
      .set({ stepMailMigration: 'error', mailError: message, mailFinishedAt: new Date() })
      .where(eq(migrations.id, id))
  } else if (phase === 'calendar') {
    await db.update(migrations)
      .set({ stepCalendarMigration: 'error', calError: message, calFinishedAt: new Date() })
      .where(eq(migrations.id, id))
  } else {
    await db.update(migrations)
      .set({ stepContactsMigration: 'error', contactsError: message, contactsFinishedAt: new Date() })
      .where(eq(migrations.id, id))
  }
}

export async function enqueueMailMigration(migrationId: string): Promise<void> {
  await db.update(migrations)
    .set({ stepMailMigration: 'pending', mailError: null, mailStartedAt: null, mailFinishedAt: null })
    .where(and(eq(migrations.id, migrationId)))
}

export async function enqueueCalendarMigration(migrationId: string): Promise<void> {
  await db.update(migrations)
    .set({ stepCalendarMigration: 'pending', calError: null, calStartedAt: null, calFinishedAt: null })
    .where(and(eq(migrations.id, migrationId)))
}

export async function enqueueContactsMigration(migrationId: string): Promise<void> {
  await db.update(migrations)
    .set({ stepContactsMigration: 'pending', contactsError: null, contactsStartedAt: null, contactsFinishedAt: null })
    .where(and(eq(migrations.id, migrationId)))
}
