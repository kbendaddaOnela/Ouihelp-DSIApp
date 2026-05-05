import { Hono } from 'hono'
import { eq, and, like, or, desc } from 'drizzle-orm'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { getDb } from '../../db/index'
import { cachedUsers, cachedDevices } from './schema'
import { runSync, getSyncStats } from './syncService'

export const inventoryRouter = new Hono<{ Variables: RbacVariables }>()
inventoryRouter.use('*', authMiddleware, loadUserRole)

// ── Déclencher une sync manuelle ──────────────────────────────────────────────
inventoryRouter.post('/sync', requirePermission('inventory:read'), async (c) => {
  runSync().catch((err) => console.error('[inventory] sync error:', err instanceof Error ? err.message : err))
  return c.json({ started: true })
})

// ── Sync bloquante pour debug (retourne le résultat ou l'erreur) ──────────────
inventoryRouter.post('/sync/debug', requirePermission('inventory:read'), async (c) => {
  try {
    const result = await runSync()
    return c.json({ ok: true, ...result })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// ── Stats pour le dashboard ───────────────────────────────────────────────────
inventoryRouter.get('/stats', requirePermission('inventory:read'), async (c) => {
  const stats = await getSyncStats()
  return c.json(stats)
})

// ── Liste des users ───────────────────────────────────────────────────────────
inventoryRouter.get('/users', requirePermission('inventory:read'), async (c) => {
  const db = getDb()
  const source = c.req.query('source') as 'ouihelp' | 'onela' | 'google' | undefined
  const search = c.req.query('q')
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  const offset = Number(c.req.query('offset') ?? 0)

  const searchFilter = search
    ? or(like(cachedUsers.upn, `%${search}%`), like(cachedUsers.displayName, `%${search}%`))
    : undefined
  const sourceFilter = source ? eq(cachedUsers.source, source) : undefined

  const rows = await db.select().from(cachedUsers)
    .where(
      searchFilter && sourceFilter ? and(sourceFilter, searchFilter)
      : sourceFilter ?? searchFilter
    )
    .orderBy(cachedUsers.displayName)
    .limit(limit)
    .offset(offset)

  return c.json({ users: rows, limit, offset })
})

// ── Liste des devices ─────────────────────────────────────────────────────────
inventoryRouter.get('/devices', requirePermission('inventory:read'), async (c) => {
  const db = getDb()
  const source = c.req.query('source') as 'ouihelp' | 'onela' | undefined
  const compliance = c.req.query('compliance')
  const search = c.req.query('q')
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500)
  const offset = Number(c.req.query('offset') ?? 0)

  const filters = []
  if (source) filters.push(eq(cachedDevices.source, source))
  if (compliance) filters.push(eq(cachedDevices.complianceState, compliance as typeof cachedDevices.$inferSelect['complianceState']))
  if (search) filters.push(like(cachedDevices.deviceName, `%${search}%`))

  const rows = await db.select().from(cachedDevices)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(cachedDevices.lastSyncDateTime))
    .limit(limit)
    .offset(offset)

  return c.json({ devices: rows, limit, offset })
})
