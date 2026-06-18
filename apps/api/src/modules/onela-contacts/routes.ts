import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '../../db/index'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { onelaContacts } from './schema'
import { migrations } from '../migration/schema'
import { parseOnelaCsv, pushContactsToUser, type ParsedContact } from './service'

export const onelaContactsRouter = new Hono<{ Variables: RbacVariables }>()

onelaContactsRouter.use('*', authMiddleware, loadUserRole)

// ── Import du CSV ONELA → table onela_contacts ───────────────────────────────
onelaContactsRouter.post('/import', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const body = await c.req.json<{ csv: string }>()
  if (!body?.csv) return c.json({ error: 'csv manquant' }, 400)

  const { contacts, excluded, malformed } = parseOnelaCsv(body.csv)
  if (contacts.length === 0) {
    return c.json({ error: 'Aucun contact valide trouvé', excluded, malformed }, 400)
  }

  let inserted = 0
  let updated = 0
  for (const ct of contacts) {
    const existing = await db.select({ id: onelaContacts.id }).from(onelaContacts).where(eq(onelaContacts.email, ct.email)).limit(1)
    if (existing.length > 0) {
      await db.update(onelaContacts).set({
        givenName: ct.givenName, familyName: ct.familyName,
        organization: ct.organization, title: ct.title, phone: ct.phone,
      }).where(eq(onelaContacts.email, ct.email))
      updated++
    } else {
      await db.insert(onelaContacts).values({
        id: randomUUID(),
        givenName: ct.givenName, familyName: ct.familyName,
        organization: ct.organization, title: ct.title,
        email: ct.email, phone: ct.phone,
      })
      inserted++
    }
  }

  return c.json({ imported: contacts.length, inserted, updated, excluded, malformed })
})

// ── Nombre de contacts dans l'annuaire ───────────────────────────────────────
onelaContactsRouter.get('/stats', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(onelaContacts)
  return c.json({ count: Number(row?.count ?? 0) })
})

// ── Pousser l'annuaire dans les contacts Google d'un user (via sa migration) ──
onelaContactsRouter.post('/push/:migrationId', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [mig] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('migrationId')))
  if (!mig) return c.json({ error: 'Migration introuvable' }, 404)
  if (!mig.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)
  const gohUpn = mig.gohUpn

  const rows = await db.select().from(onelaContacts)
  if (rows.length === 0) {
    return c.json({ error: "L'annuaire ONELA est vide — importe d'abord le CSV" }, 400)
  }

  const contacts: ParsedContact[] = rows.map((r) => ({
    givenName: r.givenName, familyName: r.familyName,
    organization: r.organization, title: r.title,
    email: r.email, phone: r.phone,
  }))

  // Lancer en background — le push de ~500 contacts peut prendre une minute
  ;(async () => {
    try {
      const result = await pushContactsToUser(gohUpn, contacts)
      console.log(`[onela-contacts] push ${gohUpn}: ${result.created} créés, ${result.skipped} déjà présents, ${result.errors} erreurs sur ${result.total}`)
    } catch (err) {
      console.error(`[onela-contacts] push ${gohUpn} échoué:`, err instanceof Error ? err.message : String(err))
    }
  })().catch(() => { /* already logged */ })

  return c.json({ message: `Intégration de ${contacts.length} contacts ONELA lancée pour ${gohUpn}`, total: contacts.length }, 202)
})
