import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { getDb } from '../../db/index'
import { migrations } from './schema'
import {
  searchOnelaUsers,
  createGohUser,
  setGohUserAttributes,
  checkGohUserExists,
} from './service'
import type {
  SearchOnelaUsersResponse,
  MigrateUsersRequest,
  MigrateUsersResponse,
  MigrationHistoryResponse,
} from '@dsi-app/shared'

export const migrationRouter = new Hono<{ Variables: RbacVariables }>()

migrationRouter.use('*', authMiddleware, loadUserRole)

// ── Recherche users ONELA ─────────────────────────────────────────────────────
migrationRouter.get('/search', requirePermission('migration:read'), async (c) => {
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
migrationRouter.post('/run', requirePermission('migration:read'), async (c) => {
  const body = await c.req.json<MigrateUsersRequest>()
  const initiatedBy = c.get('dbUser').email
  const db = getDb()

  const results = []

  for (const u of body.users) {
    const migrationId = randomUUID()

    // Générer UPN GOH : prenom.nom@mig.onela.com
    const firstName = u.givenName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '')
    const lastName = u.surname.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '')
    const gohUpn = `${firstName}.${lastName}@mig.onela.com`
    const onelaDomain = u.onelaEmail.split('@')[1] ?? 'onela.com'
    const ext10 = gohUpn
    const ext11 = `${firstName}.${lastName}@${onelaDomain}`
    const tempPassword = `Tmp-${Math.random().toString(36).slice(2, 8)}#Az1`

    // Insérer l'enregistrement de migration en DB
    await db.insert(migrations).values({
      id: migrationId,
      onelaUserId: u.onelaUserId,
      onelaUpn: u.onelaUpn,
      onelaDisplayName: u.onelaDisplayName,
      onelaEmail: u.onelaEmail,
      onelaDepartment: u.onelaDepartment,
      onelaJobTitle: u.onelaJobTitle,
      gohUpn,
      initiatedBy,
      stepCreateAccount: 'running',
      stepSetAttributes: 'pending',
      stepGroupMembership: 'pending',
      stepMailMigration: 'skipped',
    })

    try {
      // Étape 1 — Vérifier si le compte existe déjà
      const exists = await checkGohUserExists(gohUpn)
      if (exists) throw new Error(`Le compte ${gohUpn} existe déjà dans Entra GOH`)

      // Étape 1 — Créer le compte GOH
      const gohUser = await createGohUser({
        givenName: u.givenName,
        surname: u.surname,
        upn: gohUpn,
        displayName: u.onelaDisplayName,
        department: u.onelaDepartment,
        jobTitle: u.onelaJobTitle,
        tempPassword,
      })

      await db.update(migrations)
        .set({ gohUserId: gohUser.id, stepCreateAccount: 'success', stepSetAttributes: 'running' })
        .where(eq(migrations.id, migrationId))

      // Étape 2 — Poser extensionAttribute10 + 11
      // companyName="ONELA" est déjà posé à la création → groupe dynamique se déclenche
      await setGohUserAttributes(gohUser.id, ext10, ext11)

      // Générer le script PowerShell Exchange
      const psScript = [
        `# Forwarding Exchange ONELA → Google pour ${u.onelaDisplayName}`,
        `# À exécuter dans Exchange Online PowerShell`,
        `Connect-ExchangeOnline -UserPrincipalName admin@onelaservices.onmicrosoft.com -Device`,
        `Set-Mailbox -Identity "${u.onelaEmail}" \\`,
        `  -ForwardingSMTPAddress "${ext10}" \\`,
        `  -DeliverToMailboxAndForward $true`,
        `# Vérification`,
        `Get-Mailbox -Identity "${u.onelaEmail}" | Select ForwardingSMTPAddress, DeliverToMailboxAndForward`,
      ].join('\n')

      await db.update(migrations)
        .set({
          tempPassword,
          stepSetAttributes: 'success',
          stepGroupMembership: 'success',
          exchangePsScript: psScript,
        })
        .where(eq(migrations.id, migrationId))

      const [updated] = await db.select().from(migrations).where(eq(migrations.id, migrationId))
      results.push(updated)
    } catch (err) {
      const errorDetails = err instanceof Error ? err.message : String(err)
      await db.update(migrations)
        .set({
          stepCreateAccount: 'error',
          stepSetAttributes: 'error',
          stepGroupMembership: 'error',
          errorDetails,
        })
        .where(eq(migrations.id, migrationId))

      const [updated] = await db.select().from(migrations).where(eq(migrations.id, migrationId))
      results.push(updated)
    }
  }

  const response: MigrateUsersResponse = {
    migrations: results.map(serializeMigration),
  }
  return c.json(response, 201)
})

// ── Historique des migrations ─────────────────────────────────────────────────
migrationRouter.get('/history', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const page = Number(c.req.query('page') ?? 1)
  const limit = 50
  const offset = (page - 1) * limit

  const rows = await db.select().from(migrations).orderBy(desc(migrations.createdAt)).limit(limit).offset(offset)

  const response: MigrationHistoryResponse = {
    migrations: rows.map(serializeMigration),
    total: rows.length,
  }
  return c.json(response)
})

// ── Détail d'une migration ────────────────────────────────────────────────────
migrationRouter.get('/:id', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(row))
})

function serializeMigration(m: typeof migrations.$inferSelect) {
  return {
    ...m,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    tempPassword: m.tempPassword ?? null,
  }
}
