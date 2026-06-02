import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { db } from '../../db/index'
import { sharedMigrations, sharedMigratedMessages } from './schema'
import { listSharedMailboxes } from './exchangeService'
import { signalStopShared } from './worker'
import {
  allowExternalPostsOnGroup,
  enableCollaborativeInbox as enableCollabInboxOnGroup,
  getGroupSettings,
  silenceAllGroupMembers,
} from './googleGroupsService'
import {
  ensureBccTransportRule,
  deleteTransportRuleIfExists,
  getTransportRule,
  ruleNameFor,
  buildGoogleRoutingAddress,
} from './transportRuleService'
import type {
  SearchSharedMailboxesResponse,
  SharedMigrationHistoryResponse,
  CreateSharedMigrationRequest,
  SharedMigrationRecord,
} from '@dsi-app/shared'

export const sharedMailboxRouter = new Hono<{ Variables: RbacVariables }>()
sharedMailboxRouter.use('*', authMiddleware, loadUserRole)

function toRecord(m: typeof sharedMigrations.$inferSelect): SharedMigrationRecord {
  return {
    id: m.id,
    onelaUserId: m.onelaUserId,
    onelaUpn: m.onelaUpn,
    onelaEmail: m.onelaEmail,
    onelaDisplayName: m.onelaDisplayName,
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

// ── Historique ───────────────────────────────────────────────────────────────
sharedMailboxRouter.get('/history', requirePermission('migration:read'), async (c) => {
  const rows = await db.select().from(sharedMigrations).orderBy(desc(sharedMigrations.createdAt))
  return c.json<SharedMigrationHistoryResponse>({ migrations: rows.map(toRecord) })
})

// ── Création d'une migration ────────────────────────────────────────────────
sharedMailboxRouter.post('/', requirePermission('migration:write'), async (c) => {
  const body = await c.req.json<CreateSharedMigrationRequest>()
  if (!body.onelaEmail || !body.targetGroupEmail || !body.targetGroupName) {
    return c.json({ error: 'Champs requis manquants' }, 400)
  }
  const initiatedBy = c.get('dbUser').email
  const id = randomUUID()
  await db.insert(sharedMigrations).values({
    id,
    onelaUserId: body.onelaUserId,
    onelaUpn: body.onelaUpn,
    onelaEmail: body.onelaEmail,
    onelaDisplayName: body.onelaDisplayName,
    targetGroupEmail: body.targetGroupEmail.toLowerCase(),
    targetGroupName: body.targetGroupName,
    initiatedBy,
  })
  const [created] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  return c.json<SharedMigrationRecord>(toRecord(created!))
})

// ── Relancer (passer step_mail_import à pending) ────────────────────────────
sharedMailboxRouter.post('/:id/run', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  await db
    .update(sharedMigrations)
    .set({ stepMailImport: 'pending', mailError: null })
    .where(eq(sharedMigrations.id, id))
  const [updated] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  return c.json<SharedMigrationRecord>(toRecord(updated!))
})

// ── Arrêt forcé (l'utilisateur clique "Arrêter") ────────────────────────────
sharedMailboxRouter.post('/:id/stop', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  signalStopShared(id)
  return c.json({ ok: true })
})

// ── Suppression ──────────────────────────────────────────────────────────────
sharedMailboxRouter.delete('/:id', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  await db.delete(sharedMigratedMessages).where(eq(sharedMigratedMessages.sharedMigrationId, id))
  await db.delete(sharedMigrations).where(eq(sharedMigrations.id, id))
  return c.json({ ok: true })
})

// ── Dual delivery (Transport Rule Exchange : BCC vers Google Group) ─────────
// On utilise une Mail Flow Rule "BlindCopyTo" plutôt qu'un ForwardingSmtpAddress :
// les transport rules ne sont PAS impactées par le blocage anti-forward outbound
// (politique anti-phishing M365), contrairement aux forwards user-level.

/** GET : statut de la transport rule + permissions de post du groupe. */
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
      getGroupSettings(row.targetGroupEmail).catch((e) => {
        console.warn('[dual-delivery] getGroupSettings failed:', e instanceof Error ? e.message : e)
        return null
      }),
    ])
    const bccTo = rule?.BlindCopyTo?.[0] ?? null
    const expectedRouting = row.dualDeliveryBccAddress ?? buildGoogleRoutingAddress(row.targetGroupEmail)
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
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate)) {
        return c.json({ error: 'Adresse BCC invalide' }, 400)
      }
      bodyOverride = candidate
    }
  } catch {
    // Pas de body, on garde l'auto
  }

  try {
    // Priorité : override (body), puis valeur persistée, puis routage Google calculé
    const routingAddress: string =
      bodyOverride ?? row.dualDeliveryBccAddress ?? buildGoogleRoutingAddress(row.targetGroupEmail)

    await ensureBccTransportRule({
      targetMailbox: row.onelaUpn,
      bccAddress: routingAddress,
      description: `Dual delivery DSI App : BCC ${routingAddress} (vers groupe ${row.targetGroupEmail}) pour la BAL partagée ${row.onelaUpn}`,
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

/** POST : passe tous les membres en delivery_settings='NONE' (pas de fan-out). */
sharedMailboxRouter.post('/:id/group/silence-members', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  try {
    const result = await silenceAllGroupMembers(row.targetGroupEmail)
    return c.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/group/silence-members POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** POST : transforme le groupe en boîte de réception collaborative. */
sharedMailboxRouter.post('/:id/group/collaborative-inbox', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  try {
    const settings = await enableCollabInboxOnGroup(row.targetGroupEmail)
    return c.json({ ok: true, settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[shared-mailbox/group/collaborative-inbox POST]', msg)
    return c.json({ error: msg }, 500)
  }
})

/** POST : ouvre le groupe aux posts externes (ANYONE_CAN_POST). */
sharedMailboxRouter.post('/:id/group/allow-external', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharedMigrations).where(eq(sharedMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  try {
    const settings = await allowExternalPostsOnGroup(row.targetGroupEmail)
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
