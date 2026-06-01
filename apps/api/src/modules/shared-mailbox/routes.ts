import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { db } from '../../db/index'
import { sharedMigrations, sharedMigratedMessages } from './schema'
import { listSharedMailboxes } from './exchangeService'
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

// ── Suppression ──────────────────────────────────────────────────────────────
sharedMailboxRouter.delete('/:id', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  await db.delete(sharedMigratedMessages).where(eq(sharedMigratedMessages.sharedMigrationId, id))
  await db.delete(sharedMigrations).where(eq(sharedMigrations.id, id))
  return c.json({ ok: true })
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
