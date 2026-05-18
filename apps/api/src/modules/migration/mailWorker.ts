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
    // Récupérer les migrations "running" orphelines (process a crashé/redémarré)
    // Si le status est 'running' mais pas dans notre map RUNNING → remettre en 'pending'
    for (const [phase, stepCol] of [
      ['mail', 'stepMailMigration'],
      ['calendar', 'stepCalendarMigration'],
      ['contacts', 'stepContactsMigration'],
    ] as const) {
      const key = `${job.id}-${phase}`
      if (job[stepCol] === 'running' && !RUNNING.has(key)) {
        console.warn(`[migration-worker] orphan detected: ${key} is 'running' but not in RUNNING map — resetting to 'pending'`)
        if (phase === 'mail') {
          await db.update(migrations).set({ stepMailMigration: 'pending' }).where(eq(migrations.id, job.id))
          job.stepMailMigration = 'pending'
        } else if (phase === 'calendar') {
          await db.update(migrations).set({ stepCalendarMigration: 'pending' }).where(eq(migrations.id, job.id))
          job.stepCalendarMigration = 'pending'
        } else {
          await db.update(migrations).set({ stepContactsMigration: 'pending' }).where(eq(migrations.id, job.id))
          job.stepContactsMigration = 'pending'
        }
      }
    }

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
    // Charger les messages déjà migrés pour skip (idempotence)
    // On ne skip que les succès — les erreurs seront retentées automatiquement
    const already = await db
      .select({ graphMessageId: migratedMessages.graphMessageId, status: migratedMessages.status })
      .from(migratedMessages)
      .where(eq(migratedMessages.migrationId, job.id))
    const skipSet = new Set(already.filter((r) => r.status === 'success' || r.status === 'skipped').map((r) => r.graphMessageId))
    const errorSet = new Set(already.filter((r) => r.status === 'error').map((r) => r.graphMessageId))

    // Compteurs toujours cumulatifs (total historique) — l'utilisateur veut voir
    // le nombre TOTAL de mails migrés, pas seulement ceux du dernier run.
    const isDelta = !!job.mailLastSyncAt
    const alreadySuccess = already.filter((r) => r.status === 'success').length
    const alreadyFailed = already.filter((r) => r.status === 'error').length

    console.log(`[mail] ${isDelta ? 'delta' : 'resume'} ${job.id}: ${alreadySuccess} OK + ${alreadyFailed} erreurs (à retenter), ${skipSet.size} à skipper, ${errorSet.size} à retenter`)

    await db.update(migrations)
      .set({
        stepMailMigration: 'running',
        mailStartedAt: new Date(),
        mailError: null,
        mailMigrated: alreadySuccess,
        mailFailed: 0, // Les erreurs vont être retentées
      })
      .where(eq(migrations.id, job.id))

    const folders = await listOnelaFolders(job.onelaUserId)
    const folderById = new Map<string, GraphFolder>(folders.map((f) => [f.id, f]))
    const resolver = await buildLabelResolver(job.gohUpn, folders)

    let migrated = alreadySuccess
    let failed = 0 // Les erreurs vont être retentées, on ne les compte pas d'avance
    // En delta : total = messages déjà traités (en DB) + nouveaux messages ; en resume : total = tous
    // On utilise already.length (nombre réel d'entrées en DB) plutôt que job.mailTotal qui peut être corrompu
    const previousTotal = isDelta ? already.length : 0
    let total = previousTotal
    let preCountSet = false
    try {
      const newCount = await countOnelaMessages(job.onelaUserId, job.mailLastSyncAt)
      total = previousTotal + newCount
      preCountSet = true
      await db.update(migrations).set({ mailTotal: total, mailMigrated: migrated, mailFailed: failed }).where(eq(migrations.id, job.id))
    } catch (countErr) {
      console.warn('[mail] pre-count failed, will count during iteration:', countErr instanceof Error ? countErr.message : countErr)
    }

    let skipped = 0
    const syncStartedAt = new Date()
    for await (const msg of iterateOnelaMessages(job.onelaUserId, job.mailLastSyncAt)) {
      if (!preCountSet) total++
      if (skipSet.has(msg.id)) {
        skipped++
        if (skipped % 500 === 0) console.log(`[mail] ${job.id}: skipped ${skipped}/${skipSet.size} déjà migrés...`)
        continue
      }

      try {
        const rawMime = await fetchOnelaMessageMime(job.onelaUserId, msg.id)
        const folder = msg.parentFolderId ? folderById.get(msg.parentFolderId) : undefined
        const folderLabels = folder ? await resolver.resolve(folder) : ['INBOX']
        // Catégories Outlook → labels Gmail supplémentaires
        const categoryLabels = msg.categories?.length
          ? await resolver.resolveCategories(msg.categories)
          : []
        const mergedLabels = [...new Set([...folderLabels, ...categoryLabels])]
        const finalLabels = msg.isDraft ? ['DRAFT'] : mergedLabels

        const result = await gmailImportMime({
          userEmail: job.gohUpn,
          rawMime,
          labelIds: finalLabels,
          isDraft: msg.isDraft,
          isRead: msg.isRead,
        })

        const isRetry = errorSet.has(msg.id)
        await db.insert(migratedMessages).values({
          migrationId: job.id,
          graphMessageId: msg.id,
          internetMessageId: msg.internetMessageId ?? null,
          gmailMessageId: result.id,
          subject: msg.subject?.slice(0, 500) ?? null,
          receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
          status: 'success',
        }).onDuplicateKeyUpdate({
          set: { gmailMessageId: result.id, status: 'success', subject: msg.subject?.slice(0, 500) ?? null, receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null, errorDetails: null },
        })
        migrated++
        if (isRetry) console.log(`[mail] retry OK: ${msg.id} (${msg.subject?.slice(0, 60)})`)
      } catch (err) {
        const errorDetails = err instanceof Error ? err.message : String(err)
        await db.insert(migratedMessages).values({
          migrationId: job.id,
          graphMessageId: msg.id,
          internetMessageId: msg.internetMessageId ?? null,
          subject: msg.subject?.slice(0, 500) ?? null,
          receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
          status: 'error',
          errorDetails,
        }).onDuplicateKeyUpdate({
          set: { status: 'error', errorDetails, subject: msg.subject?.slice(0, 500) ?? null, receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null },
        })
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
    const alreadyCal = await db
      .select({ graphEventId: migratedEvents.graphEventId, status: migratedEvents.status })
      .from(migratedEvents)
      .where(eq(migratedEvents.migrationId, job.id))
    const skipSet = new Set(alreadyCal.filter((r) => r.status === 'success' || r.status === 'skipped').map((r) => r.graphEventId))
    const calErrorSet = new Set(alreadyCal.filter((r) => r.status === 'error').map((r) => r.graphEventId))
    const isDeltaCal = !!job.calLastSyncAt
    const calSuccessCount = alreadyCal.filter((r) => r.status === 'success').length

    await db.update(migrations)
      .set({
        stepCalendarMigration: 'running', calStartedAt: new Date(), calError: null,
        calMigrated: calSuccessCount, calFailed: 0,
      })
      .where(eq(migrations.id, job.id))

    let migrated = calSuccessCount
    let failed = 0
    const previousCalTotal = isDeltaCal ? alreadyCal.length : 0
    let total = previousCalTotal
    let preCountSet = false
    try {
      const newCount = await countOnelaEvents(job.onelaUserId, job.calLastSyncAt)
      total = previousCalTotal + newCount
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
          }).onDuplicateKeyUpdate({ set: { status: 'skipped', errorDetails: 'event sans start/end' } })
          continue
        }
        await db.insert(migratedEvents).values({
          migrationId: job.id,
          graphEventId: ev.id,
          iCalUid: ev.iCalUId ?? null,
          googleEventId: result.id,
          status: 'success',
        }).onDuplicateKeyUpdate({ set: { googleEventId: result.id, status: 'success', errorDetails: null } })
        migrated++
      } catch (err) {
        const errorDetails = err instanceof Error ? err.message : String(err)
        await db.insert(migratedEvents).values({
          migrationId: job.id,
          graphEventId: ev.id,
          iCalUid: ev.iCalUId ?? null,
          status: 'error',
          errorDetails,
        }).onDuplicateKeyUpdate({ set: { status: 'error', errorDetails } })
        failed++
        console.warn(`[calendar] event ${ev.id} error:`, errorDetails.slice(0, 200))
      }

      if ((migrated + failed) % 25 === 0) {
        await db.update(migrations)
          .set({ calTotal: total, calMigrated: migrated, calFailed: failed })
          .where(eq(migrations.id, job.id))
      }
    }

    const calAllOk = failed === 0
    await db.update(migrations)
      .set({
        stepCalendarMigration: calAllOk ? 'success' : 'error',
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
    const alreadyCt = await db
      .select({ graphContactId: migratedContacts.graphContactId, status: migratedContacts.status })
      .from(migratedContacts)
      .where(eq(migratedContacts.migrationId, job.id))
    const skipSet = new Set(alreadyCt.filter((r) => r.status === 'success' || r.status === 'skipped').map((r) => r.graphContactId))
    const isDeltaCt = !!job.contactsLastSyncAt
    const ctSuccessCount = alreadyCt.filter((r) => r.status === 'success').length

    await db.update(migrations)
      .set({
        stepContactsMigration: 'running', contactsStartedAt: new Date(), contactsError: null,
        contactsMigrated: ctSuccessCount, contactsFailed: 0,
      })
      .where(eq(migrations.id, job.id))

    let migrated = ctSuccessCount
    let failed = 0
    const previousCtTotal = isDeltaCt ? alreadyCt.length : 0
    let total = previousCtTotal
    let preCountSet = false
    try {
      const newCount = await countOnelaContacts(job.onelaUserId, job.contactsLastSyncAt)
      total = previousCtTotal + newCount
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
        }).onDuplicateKeyUpdate({ set: { googleResourceName: result.resourceName, status: 'success', errorDetails: null } })
        migrated++
      } catch (err) {
        const errorDetails = err instanceof Error ? err.message : String(err)
        await db.insert(migratedContacts).values({
          migrationId: job.id,
          graphContactId: ct.id,
          status: 'error',
          errorDetails,
        }).onDuplicateKeyUpdate({ set: { status: 'error', errorDetails } })
        failed++
        console.warn(`[contacts] ct ${ct.id} error:`, errorDetails.slice(0, 200))
      }

      if ((migrated + failed) % 25 === 0) {
        await db.update(migrations)
          .set({ contactsTotal: total, contactsMigrated: migrated, contactsFailed: failed })
          .where(eq(migrations.id, job.id))
      }
    }

    const ctAllOk = failed === 0
    await db.update(migrations)
      .set({
        stepContactsMigration: ctAllOk ? 'success' : 'error',
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
