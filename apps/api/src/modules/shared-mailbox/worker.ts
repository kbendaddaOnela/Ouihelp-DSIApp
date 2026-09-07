// Worker in-process pour migrer une boîte aux lettres PARTAGÉE Exchange.
//
// Deux modes (colonne `mode`) :
//  - `account` (courant)  : compte Google classique + licence Business Plus
//                           (attribuée hors app) + délégations Gmail. Les mails
//                           sont importés dans la boîte Gmail du compte, avec
//                           les dossiers Exchange convertis en libellés — même
//                           traitement que pour un utilisateur nominatif.
//  - `group`  (legacy)    : archive d'un Google Group via Groups Migration API.
//                           Conservé pour relancer les migrations déjà faites.
//
// Polling 5s sur step_mail_import='pending'. Une seule migration partagée à la
// fois (les BAL partagées sont peu nombreuses, pas besoin de concurrence).

import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index'
import {
  sharedMigrations,
  sharedMigratedMessages,
  sharedMailboxDelegates,
  type SharedMigration,
} from './schema'
import {
  countOnelaMessages,
  iterateOnelaMessages,
  fetchOnelaMessageMime,
  listOnelaFolders,
  buildLabelResolver,
  gmailImportMime,
  gmailFindByMessageId,
  fetchOnelaMessageMeta,
  type GraphFolder,
  type GraphMessageMeta,
} from '../migration/mailService'
import { addGoogleAlias } from '../migration/googleService'
import { ensureGoogleGroup, archiveMessageToGroup, addGroupAlias } from './googleGroupsService'
import { ensureBccTransportRule, buildGoogleRoutingAddress } from './transportRuleService'
import { ensureSendAs, setSendAsAsDefault } from './gmailUserSetupService'
import {
  ensureSharedGoogleAccount,
  ensureGmailDelegate,
  ensureGoogleUserName,
  strongRandomPassword,
  waitForMailboxSetup,
} from './googleUserService'

// eslint-disable-next-line no-control-regex
const sanitize = (s: string | undefined | null, maxLen = 500): string | null =>
  s ? s.replace(/[\u{10000}-\u{10FFFF}]/gu, '').slice(0, maxLen) || null : null

const POLL_INTERVAL_MS = 5000
/** Mode group : la Groups Migration API throttle très vite. */
const GROUP_BATCH_SIZE = 2
/** Mode account : même concurrence que la migration d'un utilisateur nominatif. */
const ACCOUNT_BATCH_SIZE = 4
const HEARTBEAT_MS = 60_000
const ORPHAN_STALE_MS = 15 * 60 * 1000

const RUNNING = new Set<string>()
const STOP_SIGNALS = new Set<string>()

/** Demande l'arrêt propre d'une migration en cours (vérifié entre deux batches). */
export function signalStopShared(id: string) {
  STOP_SIGNALS.add(id)
}

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
  // Les migrations archivées sortent du polling : sinon un import relancé
  // tournerait en arrière-plan sans être visible dans la liste active.
  const all = await db.select().from(sharedMigrations).where(eq(sharedMigrations.archived, 0))

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
  const run = next.mode === 'account' ? processAccountMailbox(next) : processGroupMailbox(next)
  run
    .catch((err) => console.error(`[shared-mailbox-worker] ${next.id} fatal:`, err))
    .finally(() => RUNNING.delete(next.id))
}

// ═══════════════════════════════════════════════════════════════════════════
// MODE « COMPTE GOOGLE CLASSIQUE »
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pose les délégations Gmail en attente sur la boîte cible.
 * Exporté : la route « Appliquer les délégations » l'appelle aussi directement
 * quand l'admin ajoute quelqu'un après coup.
 */
export async function applyDelegates(
  migrationId: string,
): Promise<{ total: number; applied: number; failed: number }> {
  const [job] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, migrationId))
  if (!job) throw new Error('Migration introuvable')
  if (!job.targetUserEmail) throw new Error('Compte Google cible non défini')

  const rows = await db
    .select()
    .from(sharedMailboxDelegates)
    .where(eq(sharedMailboxDelegates.sharedMigrationId, migrationId))

  await db
    .update(sharedMigrations)
    .set({ stepDelegates: 'running', delegatesError: null })
    .where(eq(sharedMigrations.id, migrationId))

  let applied = 0
  let failed = 0
  for (const d of rows) {
    try {
      const r = await ensureGmailDelegate(job.targetUserEmail, d.googleEmail)
      await db
        .update(sharedMailboxDelegates)
        .set({
          status: 'success',
          verificationStatus: r.verificationStatus ?? null,
          errorDetails: null,
        })
        .where(eq(sharedMailboxDelegates.id, d.id))
      applied++
      if (r.created) {
        console.log(
          `[shared] délégation ${d.googleEmail} → ${job.targetUserEmail} posée (verification=${r.verificationStatus ?? 'inconnu'})`,
        )
      }
    } catch (err) {
      const msg = sanitize(err instanceof Error ? err.message : String(err), 2000) ?? 'unknown'
      await db
        .update(sharedMailboxDelegates)
        .set({ status: 'error', errorDetails: msg })
        .where(eq(sharedMailboxDelegates.id, d.id))
      failed++
      console.warn(`[shared] délégation ${d.googleEmail} échouée:`, msg.slice(0, 200))
    }
  }

  await db
    .update(sharedMigrations)
    .set({
      stepDelegates: rows.length === 0 ? 'skipped' : failed === 0 ? 'success' : 'error',
      delegatesError: failed > 0 ? `${failed} délégation(s) en erreur` : null,
    })
    .where(eq(sharedMigrations.id, migrationId))

  return { total: rows.length, applied, failed }
}

/**
 * Reprise ciblée des seuls messages en erreur.
 *
 * Pourquoi une fonction dédiée plutôt que « Resynchroniser » : la resynchro
 * repart en balayage complet de la boîte (le delta est désactivé dès qu'il
 * reste des erreurs) — soit 17 000 messages parcourus pour en rejouer 5. Ici on
 * ne touche qu'aux lignes en erreur.
 *
 * Contrairement à la reprise du module migration (qui verse tout dans INBOX),
 * on relit les métadonnées Graph du message pour lui rendre ses libellés
 * d'origine : sur quelques messages le coût est négligeable.
 *
 * S'inscrit dans RUNNING : le détecteur d'orphelins ne touche donc pas au job,
 * et le worker ne démarre pas d'import concurrent pendant la reprise.
 */
export async function retryFailedMessages(
  migrationId: string,
): Promise<{ total: number; recovered: number; stillFailed: number; skipped: number }> {
  const [job] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, migrationId))
  if (!job) throw new Error('Migration introuvable')
  if (job.mode !== 'account' || !job.targetUserEmail) {
    throw new Error('Reprise disponible uniquement pour les migrations vers un compte Google')
  }
  if (RUNNING.has(migrationId)) throw new Error('Un traitement est déjà en cours sur cette migration')

  const mailbox = job.targetUserEmail
  const failed = await db
    .select()
    .from(sharedMigratedMessages)
    .where(
      and(
        eq(sharedMigratedMessages.sharedMigrationId, migrationId),
        eq(sharedMigratedMessages.status, 'error'),
      ),
    )
  if (failed.length === 0) return { total: 0, recovered: 0, stillFailed: 0, skipped: 0 }

  RUNNING.add(migrationId)
  const stopHeartbeat = startHeartbeat(migrationId)
  let recovered = 0
  let stillFailed = 0
  let skipped = 0
  try {
    await db
      .update(sharedMigrations)
      .set({ stepMailImport: 'running', mailError: `Reprise des erreurs : 0/${failed.length}…` })
      .where(eq(sharedMigrations.id, migrationId))

    const folders = await listOnelaFolders(job.onelaUserId)
    const folderById = new Map<string, GraphFolder>(folders.map((f) => [f.id, f]))
    const resolver = await buildLabelResolver(mailbox, folders)

    for (const row of failed) {
      try {
        const meta = await fetchOnelaMessageMeta(job.onelaUserId, row.graphMessageId)
        if (!meta) {
          // Message supprimé côté Exchange depuis le run initial : ce n'est plus
          // un échec, on le sort du décompte pour ne pas bloquer l'étape.
          await db
            .update(sharedMigratedMessages)
            .set({ status: 'skipped', errorDetails: 'Message absent d’Exchange (supprimé depuis)' })
            .where(eq(sharedMigratedMessages.id, row.id))
          skipped++
          continue
        }

        let gmailId: string | null = meta.internetMessageId
          ? await gmailFindByMessageId(mailbox, meta.internetMessageId)
          : null
        if (!gmailId) {
          const rawMime = await fetchOnelaMessageMime(job.onelaUserId, row.graphMessageId)
          const folder = meta.parentFolderId ? folderById.get(meta.parentFolderId) : undefined
          const folderLabels = folder ? await resolver.resolve(folder) : ['INBOX']
          const categoryLabels = meta.categories?.length
            ? await resolver.resolveCategories(meta.categories)
            : []
          const labels = meta.isDraft ? ['DRAFT'] : [...new Set([...folderLabels, ...categoryLabels])]
          const res = await gmailImportMime({
            userEmail: mailbox,
            rawMime,
            labelIds: labels,
            isDraft: meta.isDraft,
            isRead: meta.isRead,
          })
          gmailId = res.id
        }

        await db
          .update(sharedMigratedMessages)
          .set({ status: 'success', gmailMessageId: gmailId, errorDetails: null })
          .where(eq(sharedMigratedMessages.id, row.id))
        recovered++
      } catch (err) {
        const errorDetails =
          sanitize(err instanceof Error ? err.message : String(err), 2000) ?? 'unknown'
        await db
          .update(sharedMigratedMessages)
          .set({ errorDetails })
          .where(eq(sharedMigratedMessages.id, row.id))
        stillFailed++
        console.warn(`[shared/retry] ${row.graphMessageId} échoue encore:`, errorDetails.slice(0, 200))
      }

      await db
        .update(sharedMigrations)
        .set({
          mailError: `Reprise des erreurs : ${recovered + stillFailed + skipped}/${failed.length} (${recovered} OK, ${stillFailed} échec)…`,
        })
        .where(eq(sharedMigrations.id, migrationId))
      await new Promise((r) => setTimeout(r, 300))
    }

    // Compteurs recalculés depuis la base : source de vérité unique
    const all = await db
      .select({ status: sharedMigratedMessages.status })
      .from(sharedMigratedMessages)
      .where(eq(sharedMigratedMessages.sharedMigrationId, migrationId))
    const migrated = all.filter((r) => r.status === 'success').length
    const remaining = all.filter((r) => r.status === 'error').length

    await db
      .update(sharedMigrations)
      .set({
        stepMailImport: remaining === 0 ? 'success' : 'error',
        mailMigrated: migrated,
        mailFailed: remaining,
        mailFinishedAt: new Date(),
        mailError:
          remaining === 0
            ? null
            : `${remaining} message(s) encore en erreur après reprise (${recovered} récupérés)`,
      })
      .where(eq(sharedMigrations.id, migrationId))

    console.log(
      `[shared/retry] ${migrationId}: ${recovered} récupérés, ${stillFailed} en échec, ${skipped} ignorés`,
    )
    return { total: failed.length, recovered, stillFailed, skipped }
  } finally {
    stopHeartbeat()
    RUNNING.delete(migrationId)
  }
}

async function processAccountMailbox(job: SharedMigration) {
  console.log(`[shared/account] start ${job.id} (${job.onelaEmail} → ${job.targetUserEmail})`)
  const stopHeartbeat = startHeartbeat(job.id)
  try {
    if (!job.targetUserEmail || !job.targetUserAlias) {
      await db
        .update(sharedMigrations)
        .set({ stepMailImport: 'error', mailError: 'Compte Google cible non défini' })
        .where(eq(sharedMigrations.id, job.id))
      return
    }

    // ── 1) Compte Google ──────────────────────────────────────────────────
    let password = job.targetPassword
    if (job.stepCreateAccount !== 'success') {
      await db
        .update(sharedMigrations)
        .set({ stepCreateAccount: 'running', createAccountError: null })
        .where(eq(sharedMigrations.id, job.id))
      try {
        password = password ?? strongRandomPassword()
        const { user, created } = await ensureSharedGoogleAccount({
          primaryEmail: job.targetUserEmail,
          displayName: job.targetDisplayName ?? job.onelaDisplayName,
          password,
        })
        console.log(
          `[shared/account] compte ${user.primaryEmail} ${created ? 'créé' : 'déjà existant'} (OU ${user.orgUnitPath})`,
        )
        await db
          .update(sharedMigrations)
          .set({
            stepCreateAccount: 'success',
            targetUserId: user.id,
            // On ne conserve le mot de passe que si c'est nous qui l'avons posé
            targetPassword: created ? password : job.targetPassword,
            createAccountError: null,
            // L'adresse primaire est déjà sur mig.<domaine> → c'est la cible du BCC
            dualDeliveryBccAddress: job.dualDeliveryBccAddress ?? job.targetUserEmail,
          })
          .where(eq(sharedMigrations.id, job.id))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await db
          .update(sharedMigrations)
          .set({
            stepCreateAccount: 'error',
            createAccountError: msg,
            stepMailImport: 'error',
            mailError: 'Création du compte Google échouée',
          })
          .where(eq(sharedMigrations.id, job.id))
        return
      }
    }

    // ── 2) Licence Business Plus : hors application ───────────────────────
    // Sans licence, la boîte Gmail n'existe pas : l'import et la délégation
    // échoueraient avec des erreurs peu lisibles. On met la migration en attente
    // jusqu'à l'acquittement depuis l'UI (POST /:id/license-ack).
    if (job.stepLicense !== 'success') {
      await db
        .update(sharedMigrations)
        .set({
          stepMailImport: 'skipped',
          mailError:
            `En attente de la licence Business Plus sur ${job.targetUserEmail} ` +
            `(à attribuer dans la console Google, puis « Licence attribuée » dans l'app).`,
        })
        .where(eq(sharedMigrations.id, job.id))
      console.log(`[shared/account] ${job.id} en attente de licence`)
      return
    }

    const mailboxReady = await waitForMailboxSetup(job.targetUserEmail)
    if (!mailboxReady) {
      await db
        .update(sharedMigrations)
        .set({
          stepMailImport: 'error',
          mailError:
            `La boîte Gmail de ${job.targetUserEmail} n'est pas encore provisionnée. ` +
            `Vérifie que la licence Business Plus est bien attribuée, puis relance.`,
        })
        .where(eq(sharedMigrations.id, job.id))
      return
    }

    // ── 3) Alias onela.com + « Envoyer en tant que » par défaut ───────────
    if (job.stepAliasSendAs !== 'success') {
      await db
        .update(sharedMigrations)
        .set({ stepAliasSendAs: 'running', aliasSendAsError: null })
        .where(eq(sharedMigrations.id, job.id))
      try {
        const displayName = job.targetDisplayName ?? job.onelaDisplayName
        // Le nom du compte est ce que voient les délégués dans leur sélecteur
        // de compte : on le réaligne à chaque passage (idempotent).
        const renamed = await ensureGoogleUserName(job.targetUserEmail, displayName)
        if (renamed.updated) console.log(`[shared/account] nom du compte → « ${renamed.fullName} »`)
        await addGoogleAlias(job.targetUserEmail, job.targetUserAlias)
        await ensureSendAs(job.targetUserEmail, job.targetUserAlias, displayName)
        // L'adresse visible en émission doit être l'adresse historique du service
        await setSendAsAsDefault(job.targetUserEmail, job.targetUserAlias)
        await db
          .update(sharedMigrations)
          .set({ stepAliasSendAs: 'success', aliasSendAsError: null })
          .where(eq(sharedMigrations.id, job.id))
        console.log(`[shared/account] alias + send-as ${job.targetUserAlias} OK`)
      } catch (err) {
        // Non bloquant pour l'import : l'alias peut être reposé via le bouton dédié
        const msg = err instanceof Error ? err.message : String(err)
        await db
          .update(sharedMigrations)
          .set({ stepAliasSendAs: 'error', aliasSendAsError: msg })
          .where(eq(sharedMigrations.id, job.id))
        console.warn(`[shared/account] alias/send-as échoué (non bloquant):`, msg)
      }
    }

    // Dual delivery : BCC de la BAL Exchange vers l'adresse primaire du compte
    // (déjà sur mig.<domaine>, donc pas de boucle avec l'alias onela.com).
    try {
      await ensureBccTransportRule({
        targetMailbox: job.onelaUpn,
        bccAddress: job.targetUserEmail,
        description: `Dual delivery DSI App : BCC ${job.targetUserEmail} pour la BAL partagée ${job.onelaUpn}`,
      })
      console.log(`[shared/account] transport rule : ${job.onelaUpn} → BCC ${job.targetUserEmail}`)
    } catch (e) {
      console.warn(
        `[shared/account] auto-création transport rule échouée (à refaire via le bouton):`,
        e instanceof Error ? e.message : e,
      )
    }

    // ── 4) Import des mails dans la boîte Gmail ───────────────────────────
    await importMailToGmail(job)

    // ── 5) Délégations Gmail ──────────────────────────────────────────────
    try {
      const r = await applyDelegates(job.id)
      console.log(`[shared/account] délégations : ${r.applied}/${r.total} OK, ${r.failed} en erreur`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await db
        .update(sharedMigrations)
        .set({ stepDelegates: 'error', delegatesError: msg })
        .where(eq(sharedMigrations.id, job.id))
      console.warn(`[shared/account] délégations échouées:`, msg)
    }
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

/**
 * Import Exchange → Gmail de la boîte partagée.
 *
 * Même logique que la migration d'un utilisateur nominatif : dossiers Exchange
 * convertis en libellés Gmail, dédup par Message-ID, reprise idempotente via
 * shared_migrated_messages, delta via mailLastSyncAt.
 */
async function importMailToGmail(job: SharedMigration) {
  const mailbox = job.targetUserEmail!

  const already = await db
    .select({
      graphMessageId: sharedMigratedMessages.graphMessageId,
      status: sharedMigratedMessages.status,
    })
    .from(sharedMigratedMessages)
    .where(eq(sharedMigratedMessages.sharedMigrationId, job.id))
  const skipSet = new Set(
    already.filter((r) => r.status === 'success' || r.status === 'skipped').map((r) => r.graphMessageId),
  )
  const alreadySuccess = already.filter((r) => r.status === 'success').length
  const hasErrorRecords = already.some((r) => r.status === 'error')

  // Delta : uniquement si le run précédent est totalement propre. Sinon on
  // rebalaye tout pour retenter les messages en erreur.
  const useDelta = !hasErrorRecords && !!job.mailLastSyncAt
  const since: Date | null = useDelta ? new Date(job.mailLastSyncAt!) : null

  console.log(
    `[shared/account] ${useDelta ? 'delta' : 'resume'} ${job.id}: ${alreadySuccess} OK déjà importés` +
      (useDelta ? ` ; delta depuis ${since!.toISOString()}` : ` ; ${skipSet.size} à skipper`),
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

  const folders = await listOnelaFolders(job.onelaUserId)
  const folderById = new Map<string, GraphFolder>(folders.map((f) => [f.id, f]))
  const resolver = await buildLabelResolver(mailbox, folders)

  const syncStartedAt = new Date()
  // En balayage complet, le pré-compte porte sur TOUTE la boîte (déjà migrés
  // compris) ; en delta il ne porte que sur les nouveaux → on ajoute l'existant.
  let expectedTotal = alreadySuccess
  try {
    const counted = await countOnelaMessages(job.onelaUserId, since, folders, syncStartedAt)
    expectedTotal = useDelta ? alreadySuccess + counted : counted
    await db
      .update(sharedMigrations)
      .set({ mailTotal: expectedTotal })
      .where(eq(sharedMigrations.id, job.id))
  } catch (err) {
    console.warn('[shared/account] pre-count failed:', err instanceof Error ? err.message : err)
  }

  let migrated = alreadySuccess
  let failed = 0
  let skipped = 0
  let dedupHits = 0
  const iter = iterateOnelaMessages(job.onelaUserId, since, syncStartedAt)
  let buffer: GraphMessageMeta[] = []

  /** Renvoie true si du travail réseau a été fait (pour décider du sleep). */
  const flush = async (batch: GraphMessageMeta[]): Promise<boolean> => {
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
    if (toProcess.length === 0) return false

    const results = await Promise.allSettled(
      toProcess.map(async (msg) => {
        // Dédup : le dual delivery a pu déjà livrer le message dans la boîte
        if (msg.internetMessageId) {
          const existingId = await gmailFindByMessageId(mailbox, msg.internetMessageId)
          if (existingId) return { gmailId: existingId, dedup: true as const }
        }
        const rawMime = await fetchOnelaMessageMime(job.onelaUserId, msg.id)
        const folder = msg.parentFolderId ? folderById.get(msg.parentFolderId) : undefined
        const folderLabels = folder ? await resolver.resolve(folder) : ['INBOX']
        const categoryLabels = msg.categories?.length
          ? await resolver.resolveCategories(msg.categories)
          : []
        const merged = [...new Set([...folderLabels, ...categoryLabels])]
        const finalLabels = msg.isDraft ? ['DRAFT'] : merged
        const res = await gmailImportMime({
          userEmail: mailbox,
          rawMime,
          labelIds: finalLabels,
          isDraft: msg.isDraft,
          isRead: msg.isRead,
        })
        return { gmailId: res.id, dedup: false as const }
      }),
    )

    for (let i = 0; i < results.length; i++) {
      const msg = toProcess[i]!
      const res = results[i]!
      const base = {
        sharedMigrationId: job.id,
        graphMessageId: msg.id,
        internetMessageId: msg.internetMessageId ?? null,
        subject: sanitize(msg.subject),
        receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : null,
      }
      if (res.status === 'fulfilled') {
        await db
          .insert(sharedMigratedMessages)
          .values({ ...base, gmailMessageId: res.value.gmailId, status: 'success' })
          .onDuplicateKeyUpdate({
            set: { gmailMessageId: res.value.gmailId, status: 'success', errorDetails: null },
          })
        migrated++
        if (res.value.dedup) dedupHits++
      } else {
        const errorDetails =
          sanitize(res.reason instanceof Error ? res.reason.message : String(res.reason), 2000) ?? 'unknown'
        await db
          .insert(sharedMigratedMessages)
          .values({ ...base, status: 'error', errorDetails })
          .onDuplicateKeyUpdate({ set: { status: 'error', errorDetails } })
        failed++
        console.warn(`[shared/account] msg ${msg.id} error:`, errorDetails.slice(0, 200))
      }
    }

    await db
      .update(sharedMigrations)
      .set({
        mailMigrated: migrated,
        mailFailed: failed,
        mailTotal: Math.max(expectedTotal, migrated + failed),
      })
      .where(eq(sharedMigrations.id, job.id))
    return true
  }

  let stoppedByUser = false
  for await (const msg of iter) {
    buffer.push(msg)
    if (buffer.length >= ACCOUNT_BATCH_SIZE) {
      const didWork = await flush(buffer)
      buffer = []
      if (STOP_SIGNALS.has(job.id)) {
        stoppedByUser = true
        break
      }
      if (didWork) await new Promise((r) => setTimeout(r, 300))
    }
  }
  if (!stoppedByUser && buffer.length > 0) await flush(buffer)

  if (stoppedByUser) {
    STOP_SIGNALS.delete(job.id)
    // On n'avance PAS mailLastSyncAt : la reprise repart en balayage complet et
    // le skipSet évite de réimporter ce qui est déjà passé.
    await db
      .update(sharedMigrations)
      .set({
        stepMailImport: 'error',
        mailFinishedAt: new Date(),
        mailError: `Arrêt forcé par l'utilisateur (${migrated} migrés)`,
      })
      .where(eq(sharedMigrations.id, job.id))
    console.log(`[shared/account] stopped ${job.id}: ${migrated} OK avant arrêt`)
    return
  }

  const success = failed === 0
  await db
    .update(sharedMigrations)
    .set({
      stepMailImport: success ? 'success' : 'error',
      mailFinishedAt: new Date(),
      mailLastSyncAt: syncStartedAt,
      mailError: failed > 0 ? `${failed} message(s) en erreur` : null,
    })
    .where(eq(sharedMigrations.id, job.id))

  console.log(
    `[shared/account] done ${job.id}: ${migrated} OK, ${failed} fail, ${skipped} skip, ${dedupHits} dédup`,
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// MODE « GOOGLE GROUP » (legacy — plus proposé à la création)
// ═══════════════════════════════════════════════════════════════════════════

async function processGroupMailbox(job: SharedMigration) {
  console.log(`[shared/group] start ${job.id} (${job.onelaEmail} → ${job.targetGroupEmail})`)
  const stopHeartbeat = startHeartbeat(job.id)
  try {
    if (!job.targetGroupEmail) {
      await db
        .update(sharedMigrations)
        .set({ stepMailImport: 'error', mailError: 'Groupe cible non défini' })
        .where(eq(sharedMigrations.id, job.id))
      return
    }
    const groupEmail = job.targetGroupEmail

    // 1) Garantir l'existence du groupe Google
    if (job.stepCreateGroup !== 'success') {
      await db
        .update(sharedMigrations)
        .set({ stepCreateGroup: 'running', createGroupError: null })
        .where(eq(sharedMigrations.id, job.id))
      try {
        const group = await ensureGoogleGroup({
          email: groupEmail,
          name: job.targetGroupName ?? job.onelaDisplayName,
        })

        // Auto-provision pour le dual delivery : alias @mig.<domain> + transport rule.
        // Best-effort : si une étape échoue (permission, doublon, etc.), on log mais
        // on n'arrête pas la migration. L'utilisateur peut re-tenter via les boutons.
        const routingAddress = buildGoogleRoutingAddress(groupEmail)
        try {
          const aliasResult = await addGroupAlias(groupEmail, routingAddress)
          console.log(
            `[shared/group] alias ${routingAddress} ${aliasResult.added ? 'ajouté' : 'déjà présent'} sur ${groupEmail}`,
          )
        } catch (e) {
          console.warn(
            `[shared/group] auto-add alias ${routingAddress} a échoué (à refaire manuellement):`,
            e instanceof Error ? e.message : e,
          )
        }
        try {
          await ensureBccTransportRule({
            targetMailbox: job.onelaUpn,
            bccAddress: routingAddress,
            description: `Dual delivery DSI App : BCC ${routingAddress} (vers groupe ${groupEmail}) pour la BAL partagée ${job.onelaUpn}`,
          })
          console.log(`[shared/group] transport rule activée : ${job.onelaUpn} → BCC ${routingAddress}`)
        } catch (e) {
          console.warn(
            `[shared/group] auto-création transport rule a échoué (à refaire manuellement):`,
            e instanceof Error ? e.message : e,
          )
        }

        await db
          .update(sharedMigrations)
          .set({
            stepCreateGroup: 'success',
            targetGroupId: group.id,
            createGroupError: null,
            dualDeliveryBccAddress: routingAddress,
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
    const hasErrorRecords = already.some((r) => r.status === 'error')

    // Delta sync : si tout est OK (aucune erreur) ET on a un mailLastSyncAt
    // → on ne demande à Graph QUE les mails postérieurs (sinon on rescanne tout
    // pour rattraper les erreurs antérieures).
    const useDelta = !hasErrorRecords && !!job.mailLastSyncAt
    const since: Date | null = useDelta ? new Date(job.mailLastSyncAt!) : null

    console.log(
      `[shared/group] ${useDelta ? 'delta' : 'resume'} ${job.id}: ${alreadySuccess} OK déjà importés` +
        (useDelta ? ` ; delta depuis ${since!.toISOString()}` : ` ; ${skipSet.size} à skipper`),
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
      console.warn('[shared/group] pre-count failed:', err instanceof Error ? err.message : err)
    }

    let migrated = alreadySuccess
    let failed = 0
    let skipped = 0
    const syncStartedAt = new Date()
    const iter = iterateOnelaMessages(job.onelaUserId, since)
    let buffer: GraphMessageMeta[] = []

    /** Renvoie true si du travail réseau a été fait (pour décider du sleep). */
    const flush = async (batch: typeof buffer): Promise<boolean> => {
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

      // Si tout le batch est skippé (resume sans delta), pas d'appel API
      if (toProcess.length === 0) return false
      const results = await Promise.allSettled(
        toProcess.map(async (msg) => {
          const rawMime = await fetchOnelaMessageMime(job.onelaUserId, msg.id)
          await archiveMessageToGroup({ groupEmail, rawMime })
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
          console.warn(`[shared/group] msg ${msg.id} error:`, errorDetails.slice(0, 200))
        }
      }

      await db
        .update(sharedMigrations)
        .set({ mailMigrated: migrated, mailFailed: failed })
        .where(eq(sharedMigrations.id, job.id))
      return true
    }

    let stoppedByUser = false
    for await (const msg of iter) {
      buffer.push(msg)
      if (buffer.length >= GROUP_BATCH_SIZE) {
        const didWork = await flush(buffer)
        buffer = []
        if (STOP_SIGNALS.has(job.id)) {
          stoppedByUser = true
          break
        }
        // Délai anti-throttle uniquement si on a vraiment appelé une API
        if (didWork) await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (!stoppedByUser && buffer.length > 0) await flush(buffer)

    if (stoppedByUser) {
      STOP_SIGNALS.delete(job.id)
      await db
        .update(sharedMigrations)
        .set({
          stepMailImport: 'error',
          mailFinishedAt: new Date(),
          mailError: `Arrêt forcé par l'utilisateur (${migrated} migrés)`,
        })
        .where(eq(sharedMigrations.id, job.id))
      console.log(`[shared/group] stopped ${job.id}: ${migrated}/${total} OK avant arrêt`)
      return
    }

    const success = failed === 0
    await db
      .update(sharedMigrations)
      .set({
        stepMailImport: success ? 'success' : 'error',
        mailFinishedAt: new Date(),
        // On avance mailLastSyncAt même si quelques messages ont échoué :
        // ils sont en DB avec status='error' et seront retentés en mode
        // resume (non-delta) au prochain Resync, donc on ne les rate pas.
        mailLastSyncAt: syncStartedAt,
        mailError: failed > 0 ? `${failed} message(s) en erreur` : null,
      })
      .where(eq(sharedMigrations.id, job.id))

    console.log(`[shared/group] done ${job.id}: ${migrated}/${total} OK, ${failed} fail, ${skipped} skip`)
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
