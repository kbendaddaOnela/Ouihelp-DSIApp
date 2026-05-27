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
  gmailModifyLabels,
  gmailFindByMessageId,
  type GraphFolder,
} from './mailService'
import { countOnelaEvents, iterateOnelaEvents, googleCalendarImportEvent } from './calendarService'
import { countOnelaContacts, iterateOnelaContacts, googlePeopleCreateContact } from './contactsService'

// Supprime les caractères hors BMP (emojis 4-bytes) pour éviter les erreurs MySQL utf8
// eslint-disable-next-line no-control-regex
const sanitize = (s: string | undefined | null, maxLen = 500): string | null =>
  s ? s.replace(/[\u{10000}-\u{10FFFF}]/gu, '').slice(0, maxLen) || null : null

const MAX_CONCURRENT = 6
const POLL_INTERVAL_MS = 5000
const RUNNING = new Map<string, 'mail' | 'calendar' | 'contacts'>()

// Signaux d'arrêt : quand l'utilisateur clique "Arrêter", on ajoute la clé ici
// Le worker vérifie entre chaque batch et s'arrête proprement
const STOP_SIGNALS = new Set<string>()

export function signalStop(migrationId: string, phase: 'mail' | 'calendar' | 'contacts') {
  STOP_SIGNALS.add(`${migrationId}-${phase}`)
}

function isStopRequested(migrationId: string, phase: 'mail' | 'calendar' | 'contacts'): boolean {
  return STOP_SIGNALS.has(`${migrationId}-${phase}`)
}

function clearStopSignal(migrationId: string, phase: 'mail' | 'calendar' | 'contacts') {
  STOP_SIGNALS.delete(`${migrationId}-${phase}`)
}

// Nombre d'items traités en parallèle dans chaque phase
// Mail : 2 (Graph $value est TRÈS agressivement throttlé, surtout avec plusieurs jobs)
// Calendar/Contacts : 5 (moins de données par requête)
const MAIL_CONCURRENCY = 2
const CAL_CONCURRENCY = 2
const CONTACTS_CONCURRENCY = 2

// Avec retry+throttle adaptatif sur Graph et Gmail, on peut faire tourner 2 migrations
// mail en parallèle sans saturer (testé : OK avec 2x MAIL_CONCURRENCY=2 = 4 req/s max sur $value)
const MAX_CONCURRENT_MAIL = 2

/** Collecte `count` items d'un AsyncGenerator (ou moins si épuisé) */
async function collectBatch<T>(gen: AsyncGenerator<T>, count: number): Promise<T[]> {
  const batch: T[] = []
  for (let i = 0; i < count; i++) {
    const { value, done } = await gen.next()
    if (done) break
    batch.push(value)
  }
  return batch
}

/** Délai adaptatif : augmente quand on détecte du throttling (429), diminue sinon */
function adaptiveThrottle(had429: boolean, currentDelay: number): number {
  if (had429) return Math.min(currentDelay + 1500, 8000) // augmenter agressivement jusqu'à 8s max
  return Math.max(currentDelay - 500, 500) // réduire progressivement, minimum 500ms entre batches
}

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

    // Compter combien de jobs mail sont déjà en cours
    const runningMailCount = [...RUNNING.values()].filter((p) => p === 'mail').length

    const key = `${job.id}-mail`
    if (job.stepMailMigration === 'pending' && !RUNNING.has(key) && runningMailCount + pending.filter((p) => p.phase === 'mail').length < MAX_CONCURRENT_MAIL) {
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

    // Log diagnostic : lister les dossiers découverts et leurs labels Gmail
    const customFolders = folders.filter((f) => !f.wellKnownName)
    console.log(`[mail] ${job.id}: ${folders.length} dossiers Exchange (${customFolders.length} custom)`)
    for (const f of customFolders.slice(0, 20)) {
      const labels = await resolver.resolve(f)
      console.log(`[mail]   folder "${f.path}" (${f.id.slice(0, 16)}…) → labels: ${JSON.stringify(labels)}`)
    }

    let migrated = alreadySuccess
    let failed = 0 // Les erreurs vont être retentées, on ne les compte pas d'avance
    // En delta : total = messages déjà traités (en DB) + nouveaux messages ; en resume : total = tous
    // On utilise already.length (nombre réel d'entrées en DB) plutôt que job.mailTotal qui peut être corrompu
    const previousTotal = isDelta ? already.length : 0
    let total = previousTotal
    let preCountSet = false
    try {
      // En full-resync (pas de lastSyncAt), on utilise la somme des totalItemCount
      // des dossiers visibles : exclut Recoverable Items / Notes / Tasks / Calendar
      const newCount = await countOnelaMessages(job.onelaUserId, job.mailLastSyncAt, folders)
      total = previousTotal + newCount
      preCountSet = true
      await db.update(migrations).set({ mailTotal: total, mailMigrated: migrated, mailFailed: failed }).where(eq(migrations.id, job.id))
    } catch (countErr) {
      console.warn('[mail] pre-count failed, will count during iteration:', countErr instanceof Error ? countErr.message : countErr)
    }

    let skipped = 0
    let dedupHits = 0 // compteur des messages détectés comme déjà présents dans Gmail
    let batchDelay = 500 // délai adaptatif entre les batches (ms), commence à 500ms pour éviter le burst initial
    const syncStartedAt = new Date()
    const msgIterator = iterateOnelaMessages(job.onelaUserId, job.mailLastSyncAt)

    // Traitement par batch de MAIL_CONCURRENCY messages en parallèle
    let batch = await collectBatch(msgIterator, MAIL_CONCURRENCY)
    while (batch.length > 0) {
      // Filtrer les messages déjà migrés + ceux dans des dossiers cachés
      // (Recoverable Items : Versions, Purges, Deletions — non visibles dans Outlook)
      const toProcess = batch.filter((msg) => {
        if (!preCountSet) total++
        if (skipSet.has(msg.id)) {
          skipped++
          if (skipped % 500 === 0) console.log(`[mail] ${job.id}: skipped ${skipped}/${skipSet.size} déjà migrés...`)
          return false
        }
        // Dossier inconnu = Recoverable Items ou dossier système caché → skip silencieux
        // (on évite ainsi les ~11k messages fantômes par rapport au compte Outlook visible)
        if (msg.parentFolderId && !folderById.has(msg.parentFolderId)) {
          skipped++
          // Compte non-incrémenté : ces messages ne devraient pas peser sur total
          if (!preCountSet) total--
          return false
        }
        return true
      })

      // Traiter le batch en parallèle
      const results = await Promise.allSettled(
        toProcess.map(async (msg) => {
          // Dédup : si le Message-ID existe déjà dans Gmail, on récupère son ID
          // sans re-télécharger ni re-uploader. Évite les doublons après un reset.
          if (msg.internetMessageId) {
            const existingId = await gmailFindByMessageId(job.gohUpn!, msg.internetMessageId)
            if (existingId) {
              return { msg, result: { id: existingId }, dedup: true as const }
            }
          }

          const rawMime = await fetchOnelaMessageMime(job.onelaUserId, msg.id)
          const folder = msg.parentFolderId ? folderById.get(msg.parentFolderId) : undefined
          const folderLabels = folder ? await resolver.resolve(folder) : ['INBOX']
          const categoryLabels = msg.categories?.length
            ? await resolver.resolveCategories(msg.categories)
            : []
          const mergedLabels = [...new Set([...folderLabels, ...categoryLabels])]
          const finalLabels = msg.isDraft ? ['DRAFT'] : mergedLabels

          const result = await gmailImportMime({
            userEmail: job.gohUpn!,
            rawMime,
            labelIds: finalLabels,
            isDraft: msg.isDraft,
            isRead: msg.isRead,
          })
          return { msg, result, dedup: false as const }
        })
      )

      // Écrire les résultats en DB
      for (let i = 0; i < results.length; i++) {
        const msg = toProcess[i]!
        const res = results[i]!
        if (res.status === 'fulfilled') {
          const isRetry = errorSet.has(msg.id)
          try {
            await db.insert(migratedMessages).values({
              migrationId: job.id,
              graphMessageId: msg.id,
              internetMessageId: msg.internetMessageId ?? null,
              gmailMessageId: res.value.result.id,
              subject: sanitize(msg.subject),
              receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
              status: 'success',
            }).onDuplicateKeyUpdate({
              set: { gmailMessageId: res.value.result.id, status: 'success', subject: sanitize(msg.subject), receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null, errorDetails: null },
            })
          } catch (dbErr) {
            console.error(`[mail] DB write failed for success record ${msg.id}:`, dbErr instanceof Error ? dbErr.message : dbErr)
          }
          migrated++
          if (res.value.dedup) {
            dedupHits++
            if (dedupHits % 100 === 0) console.log(`[mail] ${job.id}: ${dedupHits} doublons détectés (Message-ID déjà présent dans Gmail)`)
          }
          if (isRetry) console.log(`[mail] retry OK: ${msg.id} (${msg.subject?.slice(0, 60)})`)
        } else {
          const errorDetails = sanitize(res.reason instanceof Error ? res.reason.message : String(res.reason), 2000) ?? 'unknown'
          try {
            await db.insert(migratedMessages).values({
              migrationId: job.id,
              graphMessageId: msg.id,
              internetMessageId: msg.internetMessageId ?? null,
              subject: sanitize(msg.subject),
              receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
              status: 'error',
              errorDetails,
            }).onDuplicateKeyUpdate({
              set: { status: 'error', errorDetails, subject: sanitize(msg.subject), receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null },
            })
          } catch (dbErr) {
            console.error(`[mail] DB write failed for error record ${msg.id}:`, dbErr instanceof Error ? dbErr.message : dbErr)
          }
          failed++
          console.warn(`[mail] msg ${msg.id} error:`, errorDetails.slice(0, 200))
        }
      }

      // Mettre à jour la progression après chaque batch
      await db.update(migrations)
        .set({ mailTotal: total, mailMigrated: migrated, mailFailed: failed })
        .where(eq(migrations.id, job.id))

      // Vérifier si l'utilisateur a demandé l'arrêt
      if (isStopRequested(job.id, 'mail')) {
        console.log(`[mail] ${job.id}: arrêt demandé — ${migrated} migrés, ${failed} erreurs`)
        clearStopSignal(job.id, 'mail')
        await db.update(migrations)
          .set({
            stepMailMigration: 'error',
            mailTotal: total, mailMigrated: migrated, mailFailed: failed,
            mailFinishedAt: new Date(),
            mailLastSyncAt: syncStartedAt,
            mailError: `Arrêt forcé par l'utilisateur (${migrated} migrés)`,
          })
          .where(eq(migrations.id, job.id))
        return
      }

      // Throttle adaptatif : ralentir si Graph throttle, accélérer sinon
      const had429 = results.some((r) => r.status === 'rejected' && r.reason?.message?.includes('429'))
      batchDelay = adaptiveThrottle(had429, batchDelay)
      if (batchDelay > 0) await new Promise((r) => setTimeout(r, batchDelay))

      batch = await collectBatch(msgIterator, MAIL_CONCURRENCY)
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

    console.log(`[mail] done ${job.id}: ${migrated}/${total} OK, ${failed} fail, ${dedupHits} dédup`)
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
    const evIterator = iterateOnelaEvents(job.onelaUserId, job.calLastSyncAt)
    let calBatchDelay = 500 // throttle adaptatif pour Google Calendar

    let evBatch = await collectBatch(evIterator, CAL_CONCURRENCY)
    while (evBatch.length > 0) {
      const toProcess = evBatch.filter((ev) => {
        if (!preCountSet) total++
        return !skipSet.has(ev.id)
      })

      const results = await Promise.allSettled(
        toProcess.map(async (ev) => {
          const result = await googleCalendarImportEvent(job.gohUpn!, ev)
          return { ev, result }
        })
      )

      for (let i = 0; i < results.length; i++) {
        const ev = toProcess[i]!
        const res = results[i]!
        if (res.status === 'fulfilled') {
          if (!res.value.result) {
            try {
              await db.insert(migratedEvents).values({
                migrationId: job.id, graphEventId: ev.id, iCalUid: ev.iCalUId ?? null,
                status: 'skipped', errorDetails: 'event sans start/end',
              }).onDuplicateKeyUpdate({ set: { status: 'skipped', errorDetails: 'event sans start/end' } })
            } catch { /* db write fail */ }
            continue
          }
          try {
            await db.insert(migratedEvents).values({
              migrationId: job.id, graphEventId: ev.id, iCalUid: ev.iCalUId ?? null,
              googleEventId: res.value.result.id, status: 'success',
            }).onDuplicateKeyUpdate({ set: { googleEventId: res.value.result.id, status: 'success', errorDetails: null } })
          } catch (dbErr) {
            console.error(`[calendar] DB write failed for ${ev.id}:`, dbErr instanceof Error ? dbErr.message : dbErr)
          }
          migrated++
        } else {
          const errorDetails = sanitize(res.reason instanceof Error ? res.reason.message : String(res.reason), 2000) ?? 'unknown'
          try {
            await db.insert(migratedEvents).values({
              migrationId: job.id, graphEventId: ev.id, iCalUid: ev.iCalUId ?? null,
              status: 'error', errorDetails,
            }).onDuplicateKeyUpdate({ set: { status: 'error', errorDetails } })
          } catch (dbErr) {
            console.error(`[calendar] DB write failed for error ${ev.id}:`, dbErr instanceof Error ? dbErr.message : dbErr)
          }
          failed++
          console.warn(`[calendar] event ${ev.id} error:`, errorDetails.slice(0, 200))
        }
      }

      await db.update(migrations)
        .set({ calTotal: total, calMigrated: migrated, calFailed: failed })
        .where(eq(migrations.id, job.id))

      if (isStopRequested(job.id, 'calendar')) {
        console.log(`[calendar] ${job.id}: arrêt demandé — ${migrated} migrés, ${failed} erreurs`)
        clearStopSignal(job.id, 'calendar')
        await db.update(migrations)
          .set({
            stepCalendarMigration: 'error',
            calTotal: total, calMigrated: migrated, calFailed: failed,
            calFinishedAt: new Date(), calLastSyncAt: calSyncStart,
            calError: `Arrêt forcé par l'utilisateur (${migrated} migrés)`,
          })
          .where(eq(migrations.id, job.id))
        return
      }

      // Throttle adaptatif : ralentir si Google rate-limit, accélérer sinon
      const calHad429 = results.some((r) => r.status === 'rejected' && r.reason?.message?.includes('403'))
        || results.some((r) => r.status === 'rejected' && r.reason?.message?.includes('429'))
      calBatchDelay = adaptiveThrottle(calHad429, calBatchDelay)
      if (calBatchDelay > 0) await new Promise((r) => setTimeout(r, calBatchDelay))

      evBatch = await collectBatch(evIterator, CAL_CONCURRENCY)
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
    const ctIterator = iterateOnelaContacts(job.onelaUserId, job.contactsLastSyncAt)
    let ctBatchDelay = 500 // throttle adaptatif pour Google People API

    let ctBatch = await collectBatch(ctIterator, CONTACTS_CONCURRENCY)
    while (ctBatch.length > 0) {
      const toProcess = ctBatch.filter((ct) => {
        if (!preCountSet) total++
        return !skipSet.has(ct.id)
      })

      const results = await Promise.allSettled(
        toProcess.map(async (ct) => {
          const result = await googlePeopleCreateContact(job.gohUpn!, ct)
          return { ct, result }
        })
      )

      for (let i = 0; i < results.length; i++) {
        const ct = toProcess[i]!
        const res = results[i]!
        if (res.status === 'fulfilled') {
          try {
            await db.insert(migratedContacts).values({
              migrationId: job.id, graphContactId: ct.id,
              googleResourceName: res.value.result.resourceName, status: 'success',
            }).onDuplicateKeyUpdate({ set: { googleResourceName: res.value.result.resourceName, status: 'success', errorDetails: null } })
          } catch (dbErr) {
            console.error(`[contacts] DB write failed for ${ct.id}:`, dbErr instanceof Error ? dbErr.message : dbErr)
          }
          migrated++
        } else {
          const errorDetails = sanitize(res.reason instanceof Error ? res.reason.message : String(res.reason), 2000) ?? 'unknown'
          try {
            await db.insert(migratedContacts).values({
              migrationId: job.id, graphContactId: ct.id,
              status: 'error', errorDetails,
            }).onDuplicateKeyUpdate({ set: { status: 'error', errorDetails } })
          } catch (dbErr) {
            console.error(`[contacts] DB write failed for error ${ct.id}:`, dbErr instanceof Error ? dbErr.message : dbErr)
          }
          failed++
          console.warn(`[contacts] ct ${ct.id} error:`, errorDetails.slice(0, 200))
        }
      }

      await db.update(migrations)
        .set({ contactsTotal: total, contactsMigrated: migrated, contactsFailed: failed })
        .where(eq(migrations.id, job.id))

      if (isStopRequested(job.id, 'contacts')) {
        console.log(`[contacts] ${job.id}: arrêt demandé — ${migrated} migrés, ${failed} erreurs`)
        clearStopSignal(job.id, 'contacts')
        await db.update(migrations)
          .set({
            stepContactsMigration: 'error',
            contactsTotal: total, contactsMigrated: migrated, contactsFailed: failed,
            contactsFinishedAt: new Date(), contactsLastSyncAt: ctSyncStart,
            contactsError: `Arrêt forcé par l'utilisateur (${migrated} migrés)`,
          })
          .where(eq(migrations.id, job.id))
        return
      }

      // Throttle adaptatif
      const ctHad429 = results.some((r) => r.status === 'rejected' && r.reason?.message?.includes('403'))
        || results.some((r) => r.status === 'rejected' && r.reason?.message?.includes('429'))
      ctBatchDelay = adaptiveThrottle(ctHad429, ctBatchDelay)
      if (ctBatchDelay > 0) await new Promise((r) => setTimeout(r, ctBatchDelay))

      ctBatch = await collectBatch(ctIterator, CONTACTS_CONCURRENCY)
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

// ── Re-labelliser les messages déjà migrés ─────────────────────────────────
// Parcourt les messages Graph, retrouve le gmailMessageId en DB, et applique les bons labels
// via Gmail messages.modify — SANS re-télécharger les MIME
const RELABEL_CONCURRENCY = 3

export async function relabelMail(migrationId: string): Promise<{ relabeled: number; skipped: number; errors: number; errorSamples: string[] }> {
  const [job] = await db.select().from(migrations).where(eq(migrations.id, migrationId))
  if (!job || !job.gohUpn) throw new Error('Migration introuvable ou gohUpn manquant')

  console.log(`[relabel] start ${job.id} (${job.onelaUpn} → ${job.gohUpn})`)

  // Charger les messages migrés avec succès (graphMessageId → gmailMessageId)
  const migratedRows = await db
    .select({ graphMessageId: migratedMessages.graphMessageId, gmailMessageId: migratedMessages.gmailMessageId })
    .from(migratedMessages)
    .where(and(eq(migratedMessages.migrationId, migrationId), eq(migratedMessages.status, 'success')))

  const graphToGmail = new Map<string, string>()
  for (const r of migratedRows) {
    if (r.gmailMessageId) graphToGmail.set(r.graphMessageId, r.gmailMessageId)
  }
  console.log(`[relabel] ${graphToGmail.size} messages migrés à re-labelliser`)

  if (graphToGmail.size === 0) return { relabeled: 0, skipped: 0, errors: 0, errorSamples: [] }

  // Construire le resolver de labels (avec la logique corrigée)
  const folders = await listOnelaFolders(job.onelaUserId)
  const folderById = new Map<string, GraphFolder>(folders.map((f) => [f.id, f]))
  const resolver = await buildLabelResolver(job.gohUpn, folders)

  let relabeled = 0
  let skipped = 0
  let errors = 0
  let processed = 0
  const errorSamples: string[] = [] // Garder les 20 premières erreurs pour le rapport
  const errorCounts = new Map<string, number>() // Compter les erreurs par type

  // Mettre à jour le statut en DB pour le suivi en temps réel
  const updateProgress = async () => {
    const msg = `Re-labellisation en cours… ${relabeled} OK, ${skipped} ignorés, ${errors} erreurs (${processed} parcourus)`
    await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, job.id))
  }

  // Itérer tous les messages Graph pour obtenir leur parentFolderId actuel
  const msgIterator = iterateOnelaMessages(job.onelaUserId)
  let batch = await collectBatch(msgIterator, RELABEL_CONCURRENCY)

  while (batch.length > 0) {
    const toProcess = batch.filter((msg) => graphToGmail.has(msg.id))

    if (toProcess.length > 0) {
      const results = await Promise.allSettled(
        toProcess.map(async (msg) => {
          const gmailId = graphToGmail.get(msg.id)!
          const folder = msg.parentFolderId ? folderById.get(msg.parentFolderId) : undefined
          const folderLabels = folder ? await resolver.resolve(folder) : ['INBOX']
          const categoryLabels = msg.categories?.length
            ? await resolver.resolveCategories(msg.categories)
            : []
          const targetLabels = [...new Set([...folderLabels, ...categoryLabels])]
          const finalLabels = msg.isDraft ? ['DRAFT'] : targetLabels

          // Ajouter les labels corrects, retirer INBOX si le message ne devrait pas y être
          const addLabels = finalLabels.filter((l) => l !== 'INBOX')
          const removeLabels: string[] = []

          if (!finalLabels.includes('INBOX') && addLabels.length > 0) {
            removeLabels.push('INBOX')
          }

          if (addLabels.length === 0 && removeLabels.length === 0) {
            return 'skipped' as const // Rien à changer (message déjà dans INBOX, pas de label custom)
          }

          await gmailModifyLabels({
            userEmail: job.gohUpn!,
            messageId: gmailId,
            addLabelIds: addLabels,
            removeLabelIds: removeLabels,
          })
          return 'relabeled' as const
        })
      )

      for (const res of results) {
        if (res.status === 'fulfilled') {
          if (res.value === 'skipped') skipped++
          else relabeled++
        } else {
          errors++
          const errMsg = res.reason instanceof Error ? res.reason.message : String(res.reason)
          // Catégoriser l'erreur
          const errType = errMsg.match(/\((\d{3})\)/)?.[1] ?? 'unknown'
          errorCounts.set(errType, (errorCounts.get(errType) ?? 0) + 1)
          // Garder un échantillon
          if (errorSamples.length < 20) {
            errorSamples.push(errMsg.slice(0, 200))
          }
          if (errors <= 3) console.warn(`[relabel] error:`, errMsg.slice(0, 200))
        }
      }
    }

    processed += batch.length
    if (processed % 500 === 0) {
      console.log(`[relabel] ${job.id}: ${processed} parcourus, ${relabeled} re-labellisés, ${skipped} ignorés, ${errors} erreurs`)
      await updateProgress()
    }

    // Vérifier signal d'arrêt
    if (isStopRequested(migrationId, 'mail')) {
      console.log(`[relabel] ${job.id}: arrêt demandé — ${relabeled} re-labellisés, ${errors} erreurs`)
      clearStopSignal(migrationId, 'mail')
      break
    }

    // Petit délai pour ne pas saturer les APIs
    await new Promise((r) => setTimeout(r, 300))
    batch = await collectBatch(msgIterator, RELABEL_CONCURRENCY)
  }

  // Log final détaillé
  const errorBreakdown = [...errorCounts.entries()].map(([type, count]) => `HTTP ${type}: ${count}`).join(', ')
  console.log(`[relabel] done ${job.id}: ${relabeled} re-labellisés, ${skipped} ignorés, ${errors} erreurs sur ${processed} parcourus`)
  if (errorBreakdown) console.log(`[relabel] erreurs détaillées: ${errorBreakdown}`)
  if (errorSamples.length > 0) console.log(`[relabel] exemples d'erreurs: ${errorSamples.slice(0, 3).join(' | ')}`)

  return { relabeled, skipped, errors, errorSamples }
}
