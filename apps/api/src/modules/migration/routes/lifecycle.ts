// Cycle de vie d'une migration : archivage, suppression, détail.
// ⚠️ Monté EN DERNIER : `GET /:id` capturerait sinon les routes statiques (`/history`, `/live-stats`…).
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { requirePermission } from '../../../middleware/rbac'
import type { RbacVariables } from '../../../middleware/rbac'
import { getDb } from '../../../db/index'
import { migrations, migratedMessages, migratedEvents, migratedContacts, migrationTargets } from '../schema'
import { serializeMigration } from '../serializers'

export const lifecycleRoutes = new Hono<{ Variables: RbacVariables }>()

// ── Archiver / désarchiver une migration ─────────────────────────────────────
lifecycleRoutes.post('/:id/archive', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.update(migrations).set({ archived: 1, archivedAt: new Date() }).where(eq(migrations.id, id))
  // Passer la cible de migration en "done"
  await db.update(migrationTargets).set({ status: 'done' }).where(eq(migrationTargets.migrationId, id))
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

lifecycleRoutes.post('/:id/unarchive', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.update(migrations).set({ archived: 0, archivedAt: null }).where(eq(migrations.id, id))
  // Remettre la cible en "in_progress"
  await db.update(migrationTargets).set({ status: 'in_progress' }).where(eq(migrationTargets.migrationId, id))
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Supprimer une migration (cascade : messages/events/contacts trackés) ────
lifecycleRoutes.delete('/:id', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.delete(migratedMessages).where(eq(migratedMessages.migrationId, id))
  await db.delete(migratedEvents).where(eq(migratedEvents.migrationId, id))
  await db.delete(migratedContacts).where(eq(migratedContacts.migrationId, id))
  await db.delete(migrations).where(eq(migrations.id, id))
  return c.json({ deleted: id })
})

// ── Détail d'une migration ────────────────────────────────────────────────────
lifecycleRoutes.get('/:id', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(row))
})
