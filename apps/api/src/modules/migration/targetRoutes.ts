import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { eq, sql, and, ne } from 'drizzle-orm'
import { getDb } from '../../db/index'
import { migrationTargets } from './schema'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'

export const migrationTargetsRouter = new Hono<{ Variables: RbacVariables }>()
migrationTargetsRouter.use('*', authMiddleware, loadUserRole)

// ── Import CSV ────────────────────────────────────────────────────────────────
// Colonnes acceptées (insensible à la casse) :
//   upn / onela_upn / email → onelaUpn
//   name / display_name / displayname / nom → displayName
//   department / departement / dept → department
//   office / bureau / site / localisation → office

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const rawHeaders = lines[0].split(';').length > 1
    ? lines[0].split(';')
    : lines[0].split(',')
  const headers = rawHeaders.map(normaliseHeader)

  const col = (keys: string[]): number =>
    headers.findIndex((h) => keys.includes(h))

  const upnIdx = col(['upn', 'onelaupn', 'email', 'userprincipalname'])
  const nameIdx = col(['name', 'displayname', 'nom', 'display_name'.replace('_', ''), 'displayname'])
  const deptIdx = col(['department', 'departement', 'dept'])
  const officeIdx = col(['office', 'bureau', 'site', 'localisation', 'location'])

  if (upnIdx === -1 || nameIdx === -1) return []

  const sep = lines[0].split(';').length > 1 ? ';' : ','
  return lines.slice(1).map((line) => {
    const cells = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''))
    return {
      onelaUpn: cells[upnIdx] ?? '',
      displayName: cells[nameIdx] ?? '',
      department: deptIdx !== -1 ? (cells[deptIdx] ?? '') : '',
      office: officeIdx !== -1 ? (cells[officeIdx] ?? '') : '',
    }
  }).filter((r) => r.onelaUpn)
}

migrationTargetsRouter.post('/import', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const body = await c.req.json<{ csv: string }>()
  const rows = parseCSV(body.csv)

  if (!rows.length) {
    return c.json({ error: 'CSV invalide ou vide — colonnes attendues : upn, displayName, department, office' }, 400)
  }

  let inserted = 0
  let updated = 0

  for (const row of rows) {
    const [existing] = await db
      .select({ id: migrationTargets.id })
      .from(migrationTargets)
      .where(eq(migrationTargets.onelaUpn, row.onelaUpn))

    if (existing) {
      await db.update(migrationTargets)
        .set({
          displayName: row.displayName,
          department: row.department || null,
          office: row.office || null,
        })
        .where(eq(migrationTargets.id, existing.id))
      updated++
    } else {
      await db.insert(migrationTargets).values({
        id: randomUUID(),
        onelaUpn: row.onelaUpn,
        displayName: row.displayName,
        department: row.department || null,
        office: row.office || null,
        status: 'pending',
      })
      inserted++
    }
  }

  return c.json({ imported: rows.length, inserted, updated })
})

// ── Stats globales ────────────────────────────────────────────────────────────
migrationTargetsRouter.get('/stats', requirePermission('migration:read'), async (c) => {
  const db = getDb()

  const [totals] = await db.select({
    total: sql<number>`COUNT(*)`,
    pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
    in_progress: sql<number>`SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END)`,
    done: sql<number>`SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)`,
  }).from(migrationTargets)

  const byDept = await db.select({
    department: migrationTargets.department,
    total: sql<number>`COUNT(*)`,
    done: sql<number>`SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)`,
    in_progress: sql<number>`SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END)`,
  })
    .from(migrationTargets)
    .groupBy(migrationTargets.department)
    .orderBy(sql`COUNT(*) DESC`)

  const byOffice = await db.select({
    office: migrationTargets.office,
    total: sql<number>`COUNT(*)`,
    done: sql<number>`SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)`,
    in_progress: sql<number>`SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END)`,
  })
    .from(migrationTargets)
    .groupBy(migrationTargets.office)
    .orderBy(sql`COUNT(*) DESC`)

  return c.json({
    totals: {
      total: Number(totals?.total ?? 0),
      pending: Number(totals?.pending ?? 0),
      in_progress: Number(totals?.in_progress ?? 0),
      done: Number(totals?.done ?? 0),
    },
    byDept: byDept.map((r) => ({
      department: r.department ?? '(sans département)',
      total: Number(r.total),
      done: Number(r.done),
      in_progress: Number(r.in_progress),
    })),
    byOffice: byOffice.map((r) => ({
      office: r.office ?? '(sans bureau)',
      total: Number(r.total),
      done: Number(r.done),
      in_progress: Number(r.in_progress),
    })),
  })
})

// ── Liste des cibles (pour debug/admin) ──────────────────────────────────────
migrationTargetsRouter.get('/', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const status = c.req.query('status')
  const rows = await db.select().from(migrationTargets)
    .where(status ? eq(migrationTargets.status, status as 'pending' | 'in_progress' | 'done') : undefined)
    .orderBy(migrationTargets.displayName)
    .limit(500)
  return c.json(rows)
})

// ── Réinitialiser la liste (admin) ────────────────────────────────────────────
migrationTargetsRouter.delete('/', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  // On ne supprime que les cibles sans migration en cours
  await db.delete(migrationTargets)
    .where(and(
      ne(migrationTargets.status, 'in_progress'),
      ne(migrationTargets.status, 'done'),
    ))
  return c.json({ ok: true })
})
