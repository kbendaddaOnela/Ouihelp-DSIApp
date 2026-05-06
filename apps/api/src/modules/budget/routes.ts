import { Hono } from 'hono'
import { eq, and, like, or, asc, gte, lte } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { getDb } from '../../db/index'
import { budgetItems } from './schema'

export const budgetRouter = new Hono<{ Variables: RbacVariables }>()
budgetRouter.use('*', authMiddleware, loadUserRole)

// ── Stats / récap ──────────────────────────────────────────────────────────────
budgetRouter.get('/stats', requirePermission('budget:read'), async (c) => {
  const db = getDb()
  const today = new Date().toISOString().slice(0, 10)
  const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)
  const in90 = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)

  const active = await db.select().from(budgetItems).where(eq(budgetItems.status, 'active'))
  const expiringSoon = await db.select().from(budgetItems)
    .where(and(
      or(eq(budgetItems.status, 'active'), eq(budgetItems.status, 'expiring_soon')),
      gte(budgetItems.contractEnd, today),
      lte(budgetItems.contractEnd, in90)
    ))
  const expired = await db.select().from(budgetItems).where(eq(budgetItems.status, 'expired'))

  // Calcul dépenses annualisées
  const toAnnual = (item: typeof active[number]) => {
    const amt = Number(item.amount)
    switch (item.billingCycle) {
      case 'monthly': return amt * 12
      case 'quarterly': return amt * 4
      case 'annual': return amt
      case 'one_time': return amt
    }
  }

  const allItems = await db.select().from(budgetItems)
  const activeItems = allItems.filter(i => i.status === 'active' || i.status === 'expiring_soon')
  const totalAnnual = activeItems.reduce((s, i) => s + toAnnual(i), 0)
  const totalMonthly = totalAnnual / 12

  // Par catégorie
  const byCategory: Record<string, number> = {}
  for (const item of activeItems) {
    const cat = item.category ?? 'other'
    byCategory[cat] = (byCategory[cat] ?? 0) + toAnnual(item)
  }

  // Contrats expirant dans 30j
  const expiring30 = expiringSoon.filter(i => i.contractEnd && i.contractEnd <= in30)

  return c.json({
    totalAnnual: Math.round(totalAnnual * 100) / 100,
    totalMonthly: Math.round(totalMonthly * 100) / 100,
    activeCount: active.length,
    expiringSoonCount: expiringSoon.length,
    expiring30Count: expiring30.length,
    expiredCount: expired.length,
    byCategory,
  })
})

// ── Liste des lignes budget ───────────────────────────────────────────────────
budgetRouter.get('/items', requirePermission('budget:read'), async (c) => {
  const db = getDb()
  const category = c.req.query('category') as typeof budgetItems.$inferSelect['category'] | undefined
  const status = c.req.query('status') as typeof budgetItems.$inferSelect['status'] | undefined
  const entity = c.req.query('entity') as typeof budgetItems.$inferSelect['billingEntity'] | undefined
  const search = c.req.query('q')

  const filters = []
  if (category) filters.push(eq(budgetItems.category, category))
  if (status) filters.push(eq(budgetItems.status, status))
  if (entity) filters.push(eq(budgetItems.billingEntity, entity))
  if (search) filters.push(or(
    like(budgetItems.name, `%${search}%`),
    like(budgetItems.vendor, `%${search}%`)
  ))

  const rows = await db.select().from(budgetItems)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(budgetItems.contractEnd))

  return c.json({ items: rows })
})

// ── Créer une ligne budget ────────────────────────────────────────────────────
budgetRouter.post('/items', requirePermission('budget:write'), async (c) => {
  const db = getDb()
  const body = await c.req.json()
  const id = randomUUID()
  const now = new Date()

  const status = computeStatus(body.contractEnd, body.status)
  const { quantity, unitCost, amount } = computeAmounts(body)

  await db.insert(budgetItems).values({
    id,
    name: body.name,
    vendor: body.vendor ?? null,
    category: body.category ?? 'other',
    quantity,
    unitCost,
    amount,
    currency: body.currency ?? 'EUR',
    billingCycle: body.billingCycle ?? 'annual',
    contractStart: body.contractStart ?? null,
    contractEnd: body.contractEnd ?? null,
    autoRenewal: body.autoRenewal ? 1 : 0,
    renewalAlertDays: body.renewalAlertDays ?? 60,
    status,
    billingEntity: body.billingEntity ?? null,
    notes: body.notes ?? null,
    createdAt: now,
    updatedAt: now,
  })

  const [row] = await db.select().from(budgetItems).where(eq(budgetItems.id, id))
  return c.json(row, 201)
})

// ── Modifier une ligne budget ─────────────────────────────────────────────────
budgetRouter.put('/items/:id', requirePermission('budget:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const body = await c.req.json()

  const status = computeStatus(body.contractEnd, body.status)
  const { quantity, unitCost, amount } = computeAmounts(body)

  await db.update(budgetItems).set({
    name: body.name,
    vendor: body.vendor ?? null,
    category: body.category ?? 'other',
    quantity,
    unitCost,
    amount,
    currency: body.currency ?? 'EUR',
    billingCycle: body.billingCycle ?? 'annual',
    contractStart: body.contractStart ?? null,
    contractEnd: body.contractEnd ?? null,
    autoRenewal: body.autoRenewal ? 1 : 0,
    renewalAlertDays: body.renewalAlertDays ?? 60,
    status,
    billingEntity: body.billingEntity ?? null,
    notes: body.notes ?? null,
    updatedAt: new Date(),
  }).where(eq(budgetItems.id, id))

  const [row] = await db.select().from(budgetItems).where(eq(budgetItems.id, id))
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

// ── Supprimer une ligne budget ────────────────────────────────────────────────
budgetRouter.delete('/items/:id', requirePermission('budget:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.delete(budgetItems).where(eq(budgetItems.id, id))
  return c.json({ deleted: true })
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function computeAmounts(body: Record<string, unknown>) {
  const quantity = Number(body.quantity ?? 1) || 1
  const unitCost = body.unitCost !== null && body.unitCost !== '' && body.unitCost !== undefined
    ? Number(body.unitCost)
    : null
  const amount = unitCost !== null
    ? String((quantity * unitCost).toFixed(2))
    : String(Number(body.amount ?? 0).toFixed(2))
  return { quantity, unitCost: unitCost !== null ? String(unitCost.toFixed(2)) : null, amount }
}

function computeStatus(
  contractEnd: string | null | undefined,
  explicitStatus: string | null | undefined
): 'active' | 'expiring_soon' | 'expired' | 'cancelled' {
  if (explicitStatus === 'cancelled') return 'cancelled'
  if (!contractEnd) return 'active'
  const today = new Date().toISOString().slice(0, 10)
  const in90 = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)
  if (contractEnd < today) return 'expired'
  if (contractEnd <= in90) return 'expiring_soon'
  return 'active'
}
