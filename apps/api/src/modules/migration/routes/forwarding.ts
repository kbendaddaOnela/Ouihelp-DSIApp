// Redirection Exchange ONELA → mig.onela.com (dual-delivery).
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { requirePermission } from '../../../middleware/rbac'
import type { RbacVariables } from '../../../middleware/rbac'
import { getDb } from '../../../db/index'
import { migrations } from '../schema'
import { setOnelaMailForwarding, removeOnelaMailForwarding, checkOnelaMailForwarding } from '../../../integrations/microsoft/tenantDirectory'

export const forwardingRoutes = new Hono<{ Variables: RbacVariables }>()

// ── Forwarding Exchange ONELA → mig.onela.com ──────────────────────────────
forwardingRoutes.post('/:id/forwarding', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte GOH' }, 400)

  try {
    await setOnelaMailForwarding(row.onelaUpn, row.gohUpn)
    return c.json({ success: true, forwardTo: row.gohUpn })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[forwarding] set error for ${row.onelaUpn}:`, msg)
    return c.json({ error: 'Forwarding error', message: msg }, 502)
  }
})

forwardingRoutes.delete('/:id/forwarding', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  try {
    await removeOnelaMailForwarding(row.onelaUpn)
    return c.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'Forwarding error', message: msg }, 502)
  }
})

forwardingRoutes.get('/:id/forwarding', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  try {
    const status = await checkOnelaMailForwarding(row.onelaUpn)
    return c.json(status)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'Check forwarding error', message: msg }, 502)
  }
})
