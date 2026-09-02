import { Hono } from 'hono'
import { eq, desc, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { db } from '../../db/index'
import { sharedMigrations, sharedMigratedMessages, sharedMailboxDelegates } from './schema'
import { listSharedMailboxes, listMailboxFullAccessUsers } from './exchangeService'
import { signalStopShared, applyDelegates } from './worker'
import {
  allowExternalPostsOnGroup,
  enableCollaborativeInbox as enableCollabInboxOnGroup,
  getGroupSettings,
  silenceAllGroupMembers,
  addGroupAlias,
} from './googleGroupsService'
import {
  ensureBccTransportRule,
  deleteTransportRuleIfExists,
  getTransportRule,
  ruleNameFor,
  buildGoogleRoutingAddress,
} from './transportRuleService'
import {
  setupLabelForAllMembers,
  setupFilterForAllMembers,
  setupSendAsForAllMembers,
  ensureSendAs,
  setSendAsAsDefault,
} from './gmailUserSetupService'
import { addGoogleAlias } from '../migration/googleService'
import {
  searchGoogleUsers,
  removeGmailDelegate,
  listGmailDelegates,
  getGoogleUser,
  ensureGoogleUserName,
} from './googleUserService'
import { resolveOnelaUpnsToGoogle, normalizeDelegateEmail } from './delegateService'
import type {
  SearchSharedMailboxesResponse,
  SharedMigrationHistoryResponse,
  CreateSharedMigrationRequest,
  SharedMigrationRecord,
  SharedMailboxDelegate,
  DelegateCandidatesResponse,
  SearchGoogleUsersResponse,
} from '@dsi-app/shared'

export const sharedMailboxRouter = new Hono<{ Variables: RbacVariables }>()
sharedMailboxRouter.use('*', authMiddleware, loadUserRole)

function toDelegate(d: typeof sharedMailboxDelegates.$inferSelect): SharedMailboxDelegate {
  return {
    id: d.id,
    sharedMigrationId: d.sharedMigrationId,
    sourceUpn: d.sourceUpn,
    googleEmail: d.googleEmail,
    displayName: d.displayName,
    status: d.status,
    verificationStatus: d.verificationStatus,
    errorDetails: d.errorDetails,
    createdAt: d.createdAt.toISOString(),
  }
}

function toRecord(
  m: typeof sharedMigrations.$inferSelect,
  delegates: SharedMailboxDelegate[] = [],
): SharedMigrationRecord {
  return {
    id: m.id,
    mode: m.mode,
    onelaUserId: m.onelaUserId,
    onelaUpn: m.onelaUpn,
    onelaEmail: m.onelaEmail,
    onelaDisplayName: m.onelaDisplayName,
    targetUserEmail: m.targetUserEmail,
    targetUserAlias: m.targetUserAlias,
    targetDisplayName: m.targetDisplayName,
    targetUserId: m.targetUserId,
    targetPassword: m.targetPassword,
    stepCreateAccount: m.stepCreateAccount,
    createAccountError: m.createAccountError,
    stepLicense: m.stepLicense,
    licenseAckAt: m.licenseAckAt ? m.licenseAckAt.toISOString() : null,
    licenseAckBy: m.licenseAckBy,
    stepAliasSendAs: m.stepAliasSendAs,
    aliasSendAsError: m.aliasSendAsError,
    stepDelegates: m.stepDelegates,
    delegatesError: m.delegatesError,
    delegates,
    targetGroupEmail: m.targetGroupEmail,
    targetGroupName: m.targetGroupName,
    targetGroupId: m.targetGroupId,
    stepCreateGroup: m.stepCreateGroup,
    createGroupError: m.createGroupError,
    stepMailImport: m.stepMailImport,
    mailTotal: m.mailTotal,
    mailMigrated: m.mailMigrated,
    mailFailed: m.mailFailed,
    mailError: m.mailError,
    mailStartedAt: m.mailStartedAt ? m.mailStartedAt.toISOString() : null,
    mailFinishedAt: m.mailFinishedAt ? m.mailFinishedAt.toISOString() : null,
    mailLastSyncAt: m.mailLastSyncAt ? m.mailLastSyncAt.toISOString() : null,
    dualDeliveryBccAddress: m.dualDeliveryBccAddress ?? null,
    initiatedBy: m.initiatedBy,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }
}

/** Charge une migration + ses délégués, sérialisée pour le front. */
async function loadRecord(id: string): Promise<SharedMigrationRecord | null> {
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return null
  const delegates = await db
    .select()
    .from(sharedMailboxDelegates)
    .where(eq(sharedMailboxDelegates.sharedMigrationId, id))
  return toRecord(row, delegates.map(toDelegate))
}

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)

// ── Liste des boîtes partagées Exchange ─────────────────────────────────────
sharedMailboxRouter.get('/search', requirePermission('migration:read'), async (c) => {
  const q = c.req.query('q')?.trim()
  try {
    const mailboxes = await listSharedMailboxes(q)
    return c.json<SearchSharedMailboxesResponse>({
      mailboxes: mailboxes.map((m) => ({ ...m, itemCount: null })),
    })
  } catch (err) {
    console.error('[shared-mailbox/search]', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Échec de la recherche des boîtes partagées', details: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// ── Recherche d'un compte Google (choix manuel d'un délégué) ────────────────
sharedMailboxRouter.get('/google-users/search', requirePermission('migration:read'), async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q || q.length < 2) return c.json<SearchGoogleUsersResponse>({ users: [] })
  try {
    const users = await searchGoogleUsers(q)
    return c.json<SearchGoogleUsersResponse>({
      users: users.map((u) => ({
        id: u.id,
        primaryEmail: u.primaryEmail,
        displayName: u.displayName,
        suspended: u.suspended,
      })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/google-users/search]', msg)
    return c.json({ error: msg }, 500)
  }
})

// ── Historique ───────────────────────────────────────────────────────────────
sharedMailboxRouter.get('/history', requirePermission('migration:read'), async (c) => {
  const rows = await db.select().from(sharedMigrations).orderBy(desc(sharedMigrations.createdAt))
  const ids = rows.map((r) => r.id)
  const delegateRows = ids.length
    ? await db
        .select()
        .from(sharedMailboxDelegates)
        .where(inArray(sharedMailboxDelegates.sharedMigrationId, ids))
    : []
  const byMigration = new Map<string, SharedMailboxDelegate[]>()
  for (const d of delegateRows) {
    const list = byMigration.get(d.sharedMigrationId) ?? []
    list.push(toDelegate(d))
    byMigration.set(d.sharedMigrationId, list)
  }
  return c.json<SharedMigrationHistoryResponse>({
    migrations: rows.map((r) => toRecord(r, byMigration.get(r.id) ?? [])),
  })
})

// ── Création d'une migration (mode « compte Google classique ») ─────────────
// Le mode Google Group n'est plus proposé : les groupes ne sont pas exploitables
// au quotidien par les collaborateurs. On crée un vrai compte (licence Business
// Plus posée hors app) et on délègue aux personnes du service.
sharedMailboxRouter.post('/', requirePermission('migration:write'), async (c) => {
  const body = await c.req.json<CreateSharedMigrationRequest>()
  if (!body.onelaEmail || !body.targetUserEmail || !body.targetUserAlias || !body.targetDisplayName) {
    return c.json({ error: 'Champs requis manquants' }, 400)
  }
  const targetUserEmail = body.targetUserEmail.trim().toLowerCase()
  const targetUserAlias = body.targetUserAlias.trim().toLowerCase()
  if (!isEmail(targetUserEmail) || !isEmail(targetUserAlias)) {
    return c.json({ error: 'Adresse du compte cible ou de l’alias invalide' }, 400)
  }
  if (targetUserEmail === targetUserAlias) {
    return c.json(
      {
        error:
          'L’adresse primaire et l’alias doivent différer : primaire sur le domaine de transition ' +
          '(mig.onela.com), alias sur le domaine définitif (onela.com).',
      },
      400,
    )
  }

  const initiatedBy = c.get('dbUser').email
  const id = randomUUID()
  await db.insert(sharedMigrations).values({
    id,
    mode: 'account',
    onelaUserId: body.onelaUserId,
    onelaUpn: body.onelaUpn,
    onelaEmail: body.onelaEmail,
    onelaDisplayName: body.onelaDisplayName,
    targetUserEmail,
    targetUserAlias,
    targetDisplayName: body.targetDisplayName.trim(),
    dualDeliveryBccAddress: targetUserEmail,
    // Le mode groupe est hors sujet ici : on neutralise ses étapes.
    stepCreateGroup: 'skipped',
    initiatedBy,
  })

  // Délégués initiaux (adresses PRIMAIRES Google — cf. delegateService)
  const byEmail = new Map<string, { sourceUpn: string | null; displayName: string | null }>()
  for (const d of body.delegates ?? []) {
    const email = d.googleEmail?.trim().toLowerCase()
    if (!email || !isEmail(email) || byEmail.has(email)) continue
    byEmail.set(email, {
      sourceUpn: d.sourceUpn?.trim().toLowerCase() ?? null,
      displayName: d.displayName ?? null,
    })
  }
  if (byEmail.size > 0) {
    await db.insert(sharedMailboxDelegates).values(
      [...byEmail].map(([googleEmail, info]) => ({
        sharedMigrationId: id,
        googleEmail,
        sourceUpn: info.sourceUpn,
        displayName: info.displayName,
        status: 'pending' as const,
      })),
    )
  }

  const record = await loadRecord(id)
  return c.json<SharedMigrationRecord>(record!)
})

// ── Relancer (passer step_mail_import à pending) ────────────────────────────
sharedMailboxRouter.post('/:id/run', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  if (row.mode === 'account' && row.stepLicense !== 'success') {
    return c.json(
      {
        error:
          'La licence Business Plus doit d’abord être attribuée au compte cible, puis acquittée ' +
          '(bouton « Licence attribuée »).',
      },
      409,
    )
  }
  await db
    .update(sharedMigrations)
    .set({ stepMailImport: 'pending', mailError: null })
    .where(eq(sharedMigrations.id, id))
  return c.json<SharedMigrationRecord>((await loadRecord(id))!)
})

// ── Arrêt forcé (l'utilisateur clique "Arrêter") ────────────────────────────
sharedMailboxRouter.post('/:id/stop', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  signalStopShared(id)
  return c.json({ ok: true })
})

// ── Suppression ──────────────────────────────────────────────────────────────
// Ne supprime QUE le suivi côté application : le compte Google et sa licence
// restent en place (une suppression de compte se fait en console admin).
sharedMailboxRouter.delete('/:id', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  await db.delete(sharedMigratedMessages).where(eq(sharedMigratedMessages.sharedMigrationId, id))
  await db.delete(sharedMailboxDelegates).where(eq(sharedMailboxDelegates.sharedMigrationId, id))
  await db.delete(sharedMigrations).where(eq(sharedMigrations.id, id))
  return c.json({ ok: true })
})

// ── Étape licence (attribuée hors application) ──────────────────────────────

/** GET : état du compte Google cible (existence, OU, boîte Gmail provisionnée). */
sharedMailboxRouter.get('/:id/account', requirePermission('migration:read'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  if (!row.targetUserEmail) return c.json({ exists: false, mailboxReady: false })
  try {
    const user = await getGoogleUser(row.targetUserEmail)
    return c.json({
      exists: !!user,
      primaryEmail: user?.primaryEmail ?? null,
      orgUnitPath: user?.orgUnitPath ?? null,
      suspended: user?.suspended ?? null,
      aliases: user?.aliases ?? [],
      aliasPresent: !!user?.aliases.some((a) => a.toLowerCase() === row.targetUserAlias?.toLowerCase()),
      // isMailboxSetup ne passe à true qu'une fois Gmail provisionné, donc une
      // fois la licence Business Plus effectivement posée.
      mailboxReady: user?.isMailboxSetup ?? false,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/** POST : acquitte l'attribution de la licence et lance l'import mail. */
sharedMailboxRouter.post('/:id/license-ack', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  if (!row.targetUserEmail) return c.json({ error: 'Compte cible non défini' }, 400)

  // Garde-fou : on vérifie que Gmail est réellement provisionné avant d'acquitter,
  // sinon l'import repartirait en erreur immédiatement.
  try {
    const user = await getGoogleUser(row.targetUserEmail)
    if (!user) {
      return c.json({ error: `Le compte ${row.targetUserEmail} n’existe pas encore dans Google.` }, 409)
    }
    if (!user.isMailboxSetup) {
      return c.json(
        {
          error:
            `La boîte Gmail de ${row.targetUserEmail} n’est pas encore provisionnée. ` +
            `Attribue la licence Business Plus dans la console Google, puis réessaie ` +
            `(le provisionnement prend quelques minutes).`,
        },
        409,
      )
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }

  await db
    .update(sharedMigrations)
    .set({
      stepLicense: 'success',
      licenseAckAt: new Date(),
      licenseAckBy: c.get('dbUser').email,
      stepMailImport: 'pending',
      mailError: null,
    })
    .where(eq(sharedMigrations.id, id))
  return c.json<SharedMigrationRecord>((await loadRecord(id))!)
})

/** POST : (re)pose l'alias onela.com + l'identité « Envoyer en tant que » par défaut. */
sharedMailboxRouter.post('/:id/alias-send-as', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  if (!row.targetUserEmail || !row.targetUserAlias) {
    return c.json({ error: 'Compte cible non défini' }, 400)
  }
  try {
    const displayName = row.targetDisplayName ?? row.onelaDisplayName
    await ensureGoogleUserName(row.targetUserEmail, displayName)
    await addGoogleAlias(row.targetUserEmail, row.targetUserAlias)
    await ensureSendAs(row.targetUserEmail, row.targetUserAlias, displayName)
    await setSendAsAsDefault(row.targetUserEmail, row.targetUserAlias)
    await db
      .update(sharedMigrations)
      .set({ stepAliasSendAs: 'success', aliasSendAsError: null })
      .where(eq(sharedMigrations.id, id))
    return c.json<SharedMigrationRecord>((await loadRecord(id))!)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .update(sharedMigrations)
      .set({ stepAliasSendAs: 'error', aliasSendAsError: msg })
      .where(eq(sharedMigrations.id, id))
    return c.json({ error: msg }, 500)
  }
})

// ── Délégations Gmail ───────────────────────────────────────────────────────

/**
 * GET : candidats à la délégation, déduits des permissions FullAccess Exchange.
 *
 * Rappel : le compte Exchange (pnom@onela.com) et le compte Google
 * (prenom.nom@mig.onela.com + alias prenom.nom@onela.com) sont DEUX identités
 * distinctes — la résolution passe par le mapping établi lors des migrations
 * utilisateurs, avec repli sur l'annuaire Google.
 */
sharedMailboxRouter.get('/:id/delegate-candidates', requirePermission('migration:read'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  try {
    const upns = await listMailboxFullAccessUsers(row.onelaUpn)
    const resolved = await resolveOnelaUpnsToGoogle(upns)
    const existing = await db
      .select({ googleEmail: sharedMailboxDelegates.googleEmail })
      .from(sharedMailboxDelegates)
      .where(eq(sharedMailboxDelegates.sharedMigrationId, id))
    const existingSet = new Set(existing.map((e) => e.googleEmail.toLowerCase()))
    return c.json<DelegateCandidatesResponse>({
      candidates: resolved.map((r) => ({
        sourceUpn: r.sourceUpn,
        googleEmail: r.googleEmail,
        displayName: r.displayName,
        resolvedVia: r.resolvedVia,
        alreadyAdded: !!r.googleEmail && existingSet.has(r.googleEmail.toLowerCase()),
      })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/delegate-candidates]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** POST : ajoute un délégué (et pose la délégation immédiatement si possible). */
sharedMailboxRouter.post('/:id/delegates', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  const body = await c.req.json<{ googleEmail?: string; sourceUpn?: string | null }>()
  const raw = body.googleEmail?.trim().toLowerCase()
  if (!raw || !isEmail(raw)) return c.json({ error: 'Adresse du délégué invalide' }, 400)

  try {
    // On résout systématiquement vers l'adresse PRIMAIRE : un alias onela.com est
    // refusé par l'API de délégation Gmail.
    const { primaryEmail, displayName } = await normalizeDelegateEmail(raw)
    await db
      .insert(sharedMailboxDelegates)
      .values({
        sharedMigrationId: id,
        googleEmail: primaryEmail.toLowerCase(),
        sourceUpn: body.sourceUpn?.trim().toLowerCase() ?? null,
        displayName,
        status: 'pending',
      })
      .onDuplicateKeyUpdate({ set: { displayName } })

    // Si la boîte est déjà opérationnelle, on applique tout de suite
    if (row.targetUserEmail && row.stepLicense === 'success') {
      await applyDelegates(id)
    }
    return c.json<SharedMigrationRecord>((await loadRecord(id))!)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 400)
  }
})

/** DELETE : retire un délégué (côté Gmail puis en base). */
sharedMailboxRouter.delete('/:id/delegates/:delegateId', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const delegateId = Number(c.req.param('delegateId'))
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  const [d] = await db
    .select()
    .from(sharedMailboxDelegates)
    .where(eq(sharedMailboxDelegates.id, delegateId))
  if (!d || d.sharedMigrationId !== id) return c.json({ error: 'Délégué introuvable' }, 404)

  if (row.targetUserEmail) {
    try {
      await removeGmailDelegate(row.targetUserEmail, d.googleEmail)
    } catch (err) {
      // On remonte l'erreur : supprimer la ligne sans retirer la délégation
      // laisserait un accès invisible depuis l'application.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  }
  await db.delete(sharedMailboxDelegates).where(eq(sharedMailboxDelegates.id, delegateId))
  return c.json<SharedMigrationRecord>((await loadRecord(id))!)
})

/** POST : (re)applique toutes les délégations en attente ou en erreur. */
sharedMailboxRouter.post('/:id/delegates/apply', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  try {
    const result = await applyDelegates(id)
    return c.json({ ok: true, ...result, migration: await loadRecord(id) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg }, 500)
  }
})

/** GET : délégations réellement posées côté Gmail (vérification terrain). */
sharedMailboxRouter.get('/:id/delegates/live', requirePermission('migration:read'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  if (!row.targetUserEmail) return c.json({ delegates: [] })
  try {
    const delegates = await listGmailDelegates(row.targetUserEmail)
    return c.json({ delegates })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// ── Dual delivery (Transport Rule Exchange : BCC vers la cible Google) ───────
// On utilise une Mail Flow Rule "BlindCopyTo" plutôt qu'un ForwardingSmtpAddress :
// les transport rules ne sont PAS impactées par le blocage anti-forward outbound
// (politique anti-phishing M365), contrairement aux forwards user-level.
//
// Mode account : le BCC pointe sur l'adresse PRIMAIRE du compte, déjà sur
// mig.<domaine> — pas de boucle avec l'alias onela.com resté autoritatif côté
// Exchange. Mode group (legacy) : alias mig.<domaine> posé sur le groupe.

/** Adresse de routage attendue pour une migration donnée. */
function expectedRoutingFor(row: typeof sharedMigrations.$inferSelect): string {
  if (row.mode === 'account') {
    return row.dualDeliveryBccAddress ?? row.targetUserEmail ?? ''
  }
  return row.dualDeliveryBccAddress ?? buildGoogleRoutingAddress(row.targetGroupEmail ?? '')
}

/** GET : statut de la transport rule (+ réglages du groupe en mode legacy). */
sharedMailboxRouter.get('/:id/dual-delivery', requirePermission('migration:read'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  try {
    const ruleName = ruleNameFor(row.onelaUpn)
    const [rule, groupSettings] = await Promise.all([
      getTransportRule(ruleName).catch((e) => {
        console.warn('[dual-delivery] getTransportRule failed:', e instanceof Error ? e.message : e)
        return null
      }),
      row.mode === 'group' && row.targetGroupEmail
        ? getGroupSettings(row.targetGroupEmail).catch((e) => {
            console.warn('[dual-delivery] getGroupSettings failed:', e instanceof Error ? e.message : e)
            return null
          })
        : Promise.resolve(null),
    ])
    const bccTo = rule?.BlindCopyTo?.[0] ?? null
    const expectedRouting = expectedRoutingFor(row)
    return c.json({
      ruleName,
      ruleActive: !!rule && rule.State !== 'Disabled',
      ruleBccTo: bccTo,
      // L'adresse de routage Google attendue pour cette migration
      // (le BCC réel doit être cette valeur — sinon la règle est obsolète et à recréer)
      expectedRoutingAddress: expectedRouting,
      // Maintien rétro-compat avec le frontend existant :
      forwarding: {
        active: !!rule && rule.State !== 'Disabled' && bccTo === expectedRouting,
        forwardTo: bccTo,
      },
      groupPostPermission: groupSettings?.whoCanPostMessage ?? null,
      groupAllowsExternalPosts: groupSettings?.whoCanPostMessage === 'ANYONE_CAN_POST',
      groupCollaborativeInbox: groupSettings?.enableCollaborativeInbox === 'true',
      groupArchived: groupSettings?.isArchived === 'true',
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

/** POST : crée/met à jour la transport rule (BCC vers le routage Google).
 *  Body optionnel : { bccAddress?: string } pour override.
 */
sharedMailboxRouter.post('/:id/dual-delivery', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)

  let bodyOverride: string | undefined
  try {
    const body = (await c.req.json().catch(() => ({}))) as { bccAddress?: string }
    if (typeof body?.bccAddress === 'string' && body.bccAddress.trim().length > 0) {
      const candidate = body.bccAddress.trim().toLowerCase()
      if (!isEmail(candidate)) {
        return c.json({ error: 'Adresse BCC invalide' }, 400)
      }
      bodyOverride = candidate
    }
  } catch {
    // Pas de body, on garde l'auto
  }

  try {
    const routingAddress: string = bodyOverride ?? expectedRoutingFor(row)
    if (!routingAddress) return c.json({ error: 'Adresse de routage indéterminée' }, 400)

    // Mode legacy : l'alias mig.<domaine> doit exister sur le groupe.
    // Mode account : l'adresse primaire est déjà sur mig.<domaine>, rien à poser.
    if (row.mode === 'group' && row.targetGroupEmail) {
      try {
        await addGroupAlias(row.targetGroupEmail, routingAddress)
      } catch (e) {
        console.warn('[dual-delivery] addGroupAlias warning:', e instanceof Error ? e.message : e)
      }
    }

    await ensureBccTransportRule({
      targetMailbox: row.onelaUpn,
      bccAddress: routingAddress,
      description: `Dual delivery DSI App : BCC ${routingAddress} pour la BAL partagée ${row.onelaUpn}`,
    })

    // Persiste l'adresse choisie pour mémoire au prochain affichage
    await db
      .update(sharedMigrations)
      .set({ dualDeliveryBccAddress: routingAddress })
      .where(eq(sharedMigrations.id, id))

    return c.json({ ok: true, forwardTo: routingAddress })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/dual-delivery POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** DELETE : supprime la transport rule. */
sharedMailboxRouter.delete('/:id/dual-delivery', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  try {
    await deleteTransportRuleIfExists(row.onelaUpn)
    return c.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/dual-delivery DELETE]', msg)
    return c.json({ error: msg }, 500)
  }
})

// ── Routes legacy « Google Group » ──────────────────────────────────────────
// Conservées pour les migrations déjà réalisées en mode groupe. Elles refusent
// désormais les migrations en mode compte, où elles n'ont pas de sens.

/** Garde : la route ne s'applique qu'aux migrations legacy en mode groupe. */
async function requireGroupMode(id: string) {
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return { error: 'Migration introuvable', status: 404 as const, row: null }
  if (row.mode !== 'group' || !row.targetGroupEmail) {
    return {
      error: 'Action réservée aux anciennes migrations en mode Google Group',
      status: 409 as const,
      row: null,
    }
  }
  return { error: null, status: 200 as const, row }
}

/** POST : ajoute l'alias mig.<domain> au groupe (prérequis pour le dual delivery). */
sharedMailboxRouter.post('/:id/group/add-mig-alias', requirePermission('migration:write'), async (c) => {
  const guard = await requireGroupMode(c.req.param('id'))
  if (!guard.row) return c.json({ error: guard.error }, guard.status)
  try {
    const alias = buildGoogleRoutingAddress(guard.row.targetGroupEmail!)
    const result = await addGroupAlias(guard.row.targetGroupEmail!, alias)
    return c.json({ ok: true, alias, added: result.added })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/group/add-mig-alias POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** Crée un libellé du nom du groupe partagé sur le Gmail de chaque membre. */
sharedMailboxRouter.post('/:id/members/setup-label', requirePermission('migration:write'), async (c) => {
  const guard = await requireGroupMode(c.req.param('id'))
  if (!guard.row) return c.json({ error: guard.error }, guard.status)
  try {
    const result = await setupLabelForAllMembers(
      guard.row.targetGroupEmail!,
      guard.row.targetGroupName ?? guard.row.onelaDisplayName,
    )
    return c.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/members/setup-label POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** Crée un filtre Gmail "to:<sharedAddr> → label + archive" chez chaque membre. */
sharedMailboxRouter.post('/:id/members/setup-filter', requirePermission('migration:write'), async (c) => {
  const guard = await requireGroupMode(c.req.param('id'))
  if (!guard.row) return c.json({ error: guard.error }, guard.status)
  try {
    const result = await setupFilterForAllMembers(
      guard.row.targetGroupEmail!,
      guard.row.targetGroupEmail!,
      guard.row.targetGroupName ?? guard.row.onelaDisplayName,
    )
    return c.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/members/setup-filter POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** Ajoute une identité "Envoyer en tant que <sharedAddr>" pour chaque membre. */
sharedMailboxRouter.post('/:id/members/setup-send-as', requirePermission('migration:write'), async (c) => {
  const guard = await requireGroupMode(c.req.param('id'))
  if (!guard.row) return c.json({ error: guard.error }, guard.status)
  try {
    const result = await setupSendAsForAllMembers(
      guard.row.targetGroupEmail!,
      guard.row.targetGroupEmail!,
      guard.row.targetGroupName ?? guard.row.onelaDisplayName,
    )
    return c.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/members/setup-send-as POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** POST : passe tous les membres en delivery_settings='NONE' (pas de fan-out). */
sharedMailboxRouter.post('/:id/group/silence-members', requirePermission('migration:write'), async (c) => {
  const guard = await requireGroupMode(c.req.param('id'))
  if (!guard.row) return c.json({ error: guard.error }, guard.status)
  try {
    const result = await silenceAllGroupMembers(guard.row.targetGroupEmail!)
    return c.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/group/silence-members POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** POST : transforme le groupe en boîte de réception collaborative. */
sharedMailboxRouter.post('/:id/group/collaborative-inbox', requirePermission('migration:write'), async (c) => {
  const guard = await requireGroupMode(c.req.param('id'))
  if (!guard.row) return c.json({ error: guard.error }, guard.status)
  try {
    const settings = await enableCollabInboxOnGroup(guard.row.targetGroupEmail!)
    return c.json({ ok: true, settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/group/collaborative-inbox POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** POST : ouvre le groupe aux posts externes (ANYONE_CAN_POST). */
sharedMailboxRouter.post('/:id/group/allow-external', requirePermission('migration:write'), async (c) => {
  const guard = await requireGroupMode(c.req.param('id'))
  if (!guard.row) return c.json({ error: guard.error }, guard.status)
  try {
    const settings = await allowExternalPostsOnGroup(guard.row.targetGroupEmail!)
    return c.json({ ok: true, settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/group/allow-external POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

// ── Erreurs détaillées ───────────────────────────────────────────────────────
sharedMailboxRouter.get('/:id/errors', requirePermission('migration:read'), async (c) => {
  const id = c.req.param('id')
  const rows = await db
    .select()
    .from(sharedMigratedMessages)
    .where(eq(sharedMigratedMessages.sharedMigrationId, id))
  const errors = rows
    .filter((r) => r.status === 'error')
    .map((r) => ({
      id: r.id,
      graphId: r.graphMessageId,
      internetMessageId: r.internetMessageId,
      subject: r.subject,
      receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
      errorDetails: r.errorDetails,
      createdAt: r.createdAt.toISOString(),
    }))
  return c.json({ errors })
})
