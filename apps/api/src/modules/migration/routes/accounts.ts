// Comptes : recherche ONELA, lancement / reprise du provisioning Entra GOH, historique.
import { Hono } from 'hono'
import { eq, desc, and, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { requirePermission } from '../../../middleware/rbac'
import type { RbacVariables } from '../../../middleware/rbac'
import { getDb } from '../../../db/index'
import { migrations, migrationTargets } from '../schema'
import { searchOnelaUsers } from '../../../integrations/microsoft/tenantDirectory'
import { normalizeNamePart } from '../../../lib/names'
import type { SearchOnelaUsersResponse, MigrateUsersRequest, MigrateExistingRequest, MigrateUsersResponse, MigrationHistoryResponse, MigratedUpnsResponse } from '@dsi-app/shared'
import { provisionAccountBackground } from '../provisioning'
import { serializeMigration, serializeMigrationLight } from '../serializers'

export const accountRoutes = new Hono<{ Variables: RbacVariables }>()

// ── Recherche users ONELA ─────────────────────────────────────────────────────
accountRoutes.get('/search', requirePermission('migration:read'), async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q || q.length < 2) {
    return c.json<SearchOnelaUsersResponse>({ users: [] })
  }

  let graphUsers
  try {
    graphUsers = await searchOnelaUsers(q)
  } catch (err) {
    console.error('[migration/search] Graph error:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Graph error', message: err instanceof Error ? err.message : String(err) }, 502)
  }

  const users = graphUsers.map((u) => ({
    id: u.id,
    displayName: u.displayName,
    givenName: u.givenName ?? '',
    surname: u.surname ?? '',
    upn: u.userPrincipalName,
    email: u.mail ?? u.userPrincipalName,
    department: u.department ?? null,
    jobTitle: u.jobTitle ?? null,
    companyName: u.companyName ?? null,
  }))

  return c.json<SearchOnelaUsersResponse>({ users })
})

// ── Lancer la migration ───────────────────────────────────────────────────────
// Stratégie : on insère TOUS les records en pending immédiatement (synchrone, rapide),
// on répond 202 au front, puis on traite les étapes Graph en background (par user, en
// parallèle limité). Évite le timeout HTTP Azure (~230s) sur les gros lots.
accountRoutes.post('/run', requirePermission('migration:write'), async (c) => {
  const body = await c.req.json<MigrateUsersRequest>()
  const initiatedBy = c.get('dbUser').email
  const db = getDb()

  const inserted: Array<typeof migrations.$inferSelect> = []
  const skipped: Array<{ onelaUpn: string; reason: string; existingMigrationId: string }> = []

  for (const u of body.users) {
    // ── Idempotency : refuser si déjà une migration non-archivée pour ce user ──
    const existing = await db
      .select({ id: migrations.id })
      .from(migrations)
      .where(and(eq(migrations.onelaUserId, u.onelaUserId), eq(migrations.archived, 0)))
      .limit(1)
    if (existing.length > 0) {
      skipped.push({
        onelaUpn: u.onelaUpn,
        reason: 'Migration déjà en cours / existante pour ce compte (archive-la d\'abord pour relancer)',
        existingMigrationId: existing[0]!.id,
      })
      continue
    }

    const migrationId = randomUUID()

    // Générer UPN GOH : prenom.nom@mig.onela.com (tirets des noms composés conservés)
    const firstName = normalizeNamePart(u.givenName)
    const lastName = normalizeNamePart(u.surname)
    const gohUpn = `${firstName}.${lastName}@mig.onela.com`
    const onelaDomain = u.onelaEmail.split('@')[1] ?? 'onela.com'
    const ext10 = `${firstName}.${lastName}@onela.fr`
    const ext11 = `${firstName}.${lastName}@${onelaDomain}`
    const tempPassword = `Tmp-${Math.random().toString(36).slice(2, 8)}#Az1`

    // Insérer l'enregistrement avec stepCreateAccount='pending' (sera passé à 'running' par le job background)
    await db.insert(migrations).values({
      id: migrationId,
      onelaUserId: u.onelaUserId,
      onelaUpn: u.onelaUpn,
      onelaDisplayName: u.onelaDisplayName,
      onelaEmail: u.onelaEmail,
      onelaDepartment: u.onelaDepartment,
      onelaJobTitle: u.onelaJobTitle,
      gohUpn,
      tempPassword,
      initiatedBy,
      stepCreateAccount: 'pending',
      stepSetAttributes: 'pending',
      stepGroupMembership: 'pending',
      stepMailMigration: 'skipped',
      stepCalendarMigration: 'skipped',
      stepContactsMigration: 'skipped',
      stepGoogleAlias: 'skipped',
      stepOuMove: 'skipped',
    })

    const [row] = await db.select().from(migrations).where(eq(migrations.id, migrationId))
    if (row) inserted.push(row)

    // Lancer le provisioning en background (fire-and-forget)
    void provisionAccountBackground({
      migrationId,
      givenName: u.givenName,
      surname: u.surname,
      gohUpn,
      onelaEmail: u.onelaEmail,
      onelaUpn: u.onelaUpn,
      onelaDisplayName: u.onelaDisplayName,
      onelaDepartment: u.onelaDepartment,
      onelaJobTitle: u.onelaJobTitle,
      tempPassword,
      ext10,
      ext11,
    })
  }

  const response: MigrateUsersResponse & { skipped?: typeof skipped } = {
    migrations: inserted.map(serializeMigration),
    ...(skipped.length > 0 ? { skipped } : {}),
  }
  return c.json(response, 202)
})

// ── Retry du provisioning (pour les comptes qui ont échoué) ──────────────────
accountRoutes.post('/:id/retry-provisioning', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'gohUpn manquant — record corrompu' }, 400)

  // On ne relance que les étapes qui sont en 'error' ou 'pending', pas celles déjà 'success'
  const needsCreate = row.stepCreateAccount === 'error' || row.stepCreateAccount === 'pending'
  const needsAttrs = row.stepSetAttributes === 'error' || row.stepSetAttributes === 'pending'
  const needsGroup = row.stepGroupMembership === 'error' || row.stepGroupMembership === 'pending'

  if (!needsCreate && !needsAttrs && !needsGroup) {
    return c.json({ error: 'Toutes les étapes sont déjà en success ou skipped' }, 400)
  }

  // Reconstituer les inputs depuis le record
  const firstName = row.gohUpn.split('.')[0] ?? ''
  const lastName = (row.gohUpn.split('@')[0] ?? '').split('.').slice(1).join('.')
  const onelaDomain = row.onelaEmail.split('@')[1] ?? 'onela.com'
  const ext10 = `${firstName}.${lastName}@onela.fr`
  const ext11 = `${firstName}.${lastName}@${onelaDomain}`

  // Reset error fields avant retry
  await db.update(migrations).set({ errorDetails: null }).where(eq(migrations.id, row.id))

  void provisionAccountBackground({
    migrationId: row.id,
    givenName: firstName,
    surname: lastName,
    gohUpn: row.gohUpn,
    onelaEmail: row.onelaEmail,
    onelaUpn: row.onelaUpn,
    onelaDisplayName: row.onelaDisplayName,
    onelaDepartment: row.onelaDepartment,
    onelaJobTitle: row.onelaJobTitle,
    tempPassword: row.tempPassword ?? `Tmp-${Math.random().toString(36).slice(2, 8)}#Az1`,
    ext10, ext11,
  })

  return c.json({ message: 'Retry lancé en background', migrationId: row.id }, 202)
})

// ── Migration vers compte Google existant (sans création Entra GOH) ──────────
accountRoutes.post('/run-existing', requirePermission('migration:write'), async (c) => {
  const body = await c.req.json<MigrateExistingRequest>()
  const initiatedBy = c.get('dbUser').email
  const db = getDb()

  if (!body.targetGoogleEmail?.includes('@')) {
    return c.json({ error: 'targetGoogleEmail invalide' }, 400)
  }

  const migrationId = randomUUID()
  const now = new Date()

  // Insérer le record avec toutes les étapes Entra/compte marquées 'skipped'
  await db.insert(migrations).values({
    id: migrationId,
    onelaUserId: body.onelaUserId,
    onelaUpn: body.onelaUpn,
    onelaDisplayName: body.onelaDisplayName,
    onelaEmail: body.onelaEmail,
    onelaDepartment: body.onelaDepartment,
    onelaJobTitle: body.onelaJobTitle,
    gohUpn: body.targetGoogleEmail,
    initiatedBy,
    stepCreateAccount: 'skipped',
    stepSetAttributes: 'skipped',
    stepGroupMembership: 'skipped',
    stepGoogleAlias: 'skipped',
    stepMailMigration: 'skipped',
    stepCalendarMigration: 'skipped',
    stepContactsMigration: 'skipped',
    stepOuMove: 'skipped',
    createdAt: now,
    updatedAt: now,
  })

  // Lier la cible de migration si elle existe
  await db.update(migrationTargets)
    .set({ status: 'in_progress', migrationId })
    .where(eq(migrationTargets.onelaUpn, body.onelaUpn))

  const [row] = await db.select().from(migrations).where(eq(migrations.id, migrationId))
  if (!row) return c.json({ error: 'Erreur interne' }, 500)

  const response: MigrateUsersResponse = { migrations: [serializeMigration(row)] }
  return c.json(response, 201)
})

// ── Historique des migrations ─────────────────────────────────────────────────
// `archived=1` renvoie l'historique paginé, sinon les migrations actives.
// Les deux jeux sont filtrés côté SQL : sans ça, un lot d'archives récentes
// pouvait pousser des migrations actives hors de la page 1 et les faire
// disparaître de l'écran.
const HISTORY_MAX_LIMIT = 200

accountRoutes.get('/history', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const archivedFlag = ['1', 'true'].includes(c.req.query('archived') ?? '') ? 1 : 0
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const requestedLimit = Number(c.req.query('limit')) || (archivedFlag ? 50 : HISTORY_MAX_LIMIT)
  const limit = Math.min(HISTORY_MAX_LIMIT, Math.max(1, requestedLimit))
  const offset = (page - 1) * limit
  const where = eq(migrations.archived, archivedFlag)

  const [rows, countRows] = await Promise.all([
    db.select().from(migrations).where(where).orderBy(desc(migrations.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(migrations).where(where),
  ])

  const total = Number(countRows[0]?.n ?? rows.length)
  const response: MigrationHistoryResponse = {
    migrations: rows.map(serializeMigrationLight),
    total,
    page,
    limit,
    hasMore: offset + rows.length < total,
  }
  return c.json(response)
})

// ── UPN déjà migrés (badge « déjà migré » dans la recherche) ──────────────────
// Endpoint dédié : la liste des actives ne suffit plus pour ce test depuis que
// l'historique est paginé séparément.
accountRoutes.get('/migrated-upns', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const rows = await db
    .selectDistinct({ upn: migrations.onelaUpn })
    .from(migrations)
    .where(inArray(migrations.stepCreateAccount, ['success', 'skipped']))

  const response: MigratedUpnsResponse = { upns: rows.map((r) => r.upn) }
  return c.json(response)
})
