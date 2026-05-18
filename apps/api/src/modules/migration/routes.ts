import { Hono } from 'hono'
import { eq, desc, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { getDb } from '../../db/index'
import { migrations, migratedMessages, migratedEvents, migratedContacts, migrationTargets } from './schema'
import {
  searchOnelaUsers,
  createGohUser,
  setGohUserAttributes,
  checkGohUserExists,
} from './service'
import { googleUserExists, addGoogleAlias, moveUserToOu } from './googleService'
import { enqueueMailMigration, enqueueCalendarMigration, enqueueContactsMigration } from './mailWorker'
import type {
  SearchOnelaUsersResponse,
  MigrateUsersRequest,
  MigrateExistingRequest,
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
    const ext10 = `${firstName}.${lastName}@onela.fr`
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
      stepCalendarMigration: 'skipped',
      stepContactsMigration: 'skipped',
      stepGoogleAlias: 'skipped',
      stepOuMove: 'skipped',
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

      // Lier la cible de migration si elle existe
      await db.update(migrationTargets)
        .set({ status: 'in_progress', migrationId })
        .where(eq(migrationTargets.onelaUpn, u.onelaUpn))

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
    migrations: results.filter((r): r is NonNullable<typeof r> => r != null).map(serializeMigration),
  }
  return c.json(response, 201)
})

// ── Migration vers compte Google existant (sans création Entra GOH) ──────────
migrationRouter.post('/run-existing', requirePermission('migration:read'), async (c) => {
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

// ── Ajouter l'alias Google (manuel, après SCIM sync) ─────────────────────────
migrationRouter.post('/:id/google-alias', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration non réussie, impossible d\'ajouter l\'alias' }, 400)
  }

  // Vérifier que le compte Google existe (SCIM provisionné)
  const exists = await googleUserExists(row.gohUpn)
  if (!exists) {
    return c.json({ error: 'not_provisioned', message: `Le compte ${row.gohUpn} n'est pas encore disponible dans Google Workspace. Le SCIM sync peut prendre 5 à 40 minutes — réessaie dans quelques minutes.` }, 202)
  }

  // Alias : par défaut l'UPN ONELA, sinon override via body { alias }
  let aliasOverride: string | undefined
  try {
    const body = (await c.req.json<{ alias?: string }>().catch(() => ({}))) as { alias?: string }
    aliasOverride = body.alias?.trim()
  } catch { /* no body */ }
  const alias = aliasOverride || row.onelaUpn

  try {
    await addGoogleAlias(row.gohUpn, alias)
    await db.update(migrations)
      .set({ stepGoogleAlias: 'success', googleAliasError: null })
      .where(eq(migrations.id, row.id))
    const [updated] = await db.select().from(migrations).where(eq(migrations.id, row.id))
    if (!updated) return c.json({ error: 'Not Found' }, 404)
    return c.json(serializeMigration(updated))
  } catch (err) {
    const errorDetails = err instanceof Error ? err.message : String(err)
    await db.update(migrations)
      .set({ stepGoogleAlias: 'error', googleAliasError: errorDetails })
      .where(eq(migrations.id, row.id))
    return c.json({ error: 'Google alias error', message: errorDetails }, 502)
  }
})

// ── Déplacer le compte Google vers l'OU ONELA ────────────────────────────────
migrationRouter.post('/:id/move-ou', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé à cette migration' }, 400)

  const ouPath = process.env['GOOGLE_ONELA_OU_PATH'] ?? '/onela.com'

  await db.update(migrations).set({ stepOuMove: 'running', ouMoveError: null }).where(eq(migrations.id, row.id))

  try {
    await moveUserToOu(row.gohUpn, ouPath)
    await db.update(migrations).set({ stepOuMove: 'success' }).where(eq(migrations.id, row.id))
    const [updated] = await db.select().from(migrations).where(eq(migrations.id, row.id))
    if (!updated) return c.json({ error: 'Not Found' }, 404)
    return c.json(serializeMigration(updated))
  } catch (err) {
    const errorDetails = err instanceof Error ? err.message : String(err)
    await db.update(migrations).set({ stepOuMove: 'error', ouMoveError: errorDetails }).where(eq(migrations.id, row.id))
    return c.json({ error: 'Google move OU error', message: errorDetails }, 502)
  }
})

// ── Lancer la migration mail (worker en background) ──────────────────────────
migrationRouter.post('/:id/migrate-mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration de compte non réussie, mail impossible' }, 400)
  }
  if (row.stepMailMigration === 'running' || row.stepMailMigration === 'pending') {
    return c.json({ error: 'Migration mail déjà en cours' }, 409)
  }

  await enqueueMailMigration(id)
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated), 202)
})

// ── Lancer migration calendrier ──────────────────────────────────────────────
migrationRouter.post('/:id/migrate-calendar', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration de compte non réussie' }, 400)
  }
  if (row.stepCalendarMigration === 'running' || row.stepCalendarMigration === 'pending') {
    return c.json({ error: 'Migration calendrier déjà en cours' }, 409)
  }
  await enqueueCalendarMigration(id)
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated), 202)
})

// ── Lancer migration contacts ────────────────────────────────────────────────
migrationRouter.post('/:id/migrate-contacts', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration de compte non réussie' }, 400)
  }
  if (row.stepContactsMigration === 'running' || row.stepContactsMigration === 'pending') {
    return c.json({ error: 'Migration contacts déjà en cours' }, 409)
  }
  await enqueueContactsMigration(id)
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated), 202)
})

// ── Vérifier si le compte Google existe (SCIM provisionné) ──────────────────
migrationRouter.get('/:id/check-google', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ exists: false, email: null })
  const exists = await googleUserExists(row.gohUpn)
  return c.json({ exists, email: row.gohUpn })
})

// ── Archiver / désarchiver une migration ─────────────────────────────────────
migrationRouter.post('/:id/archive', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.update(migrations).set({ archived: 1, archivedAt: new Date() }).where(eq(migrations.id, id))
  // Passer la cible de migration en "done"
  await db.update(migrationTargets).set({ status: 'done' }).where(eq(migrationTargets.migrationId, id))
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

migrationRouter.post('/:id/unarchive', requirePermission('migration:write'), async (c) => {
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
migrationRouter.delete('/:id', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.delete(migratedMessages).where(eq(migratedMessages.migrationId, id))
  await db.delete(migratedEvents).where(eq(migratedEvents.migrationId, id))
  await db.delete(migratedContacts).where(eq(migratedContacts.migrationId, id))
  await db.delete(migrations).where(eq(migrations.id, id))
  return c.json({ deleted: id })
})

// ── Forcer l'arrêt d'une phase (running → error) ────────────────────────────
migrationRouter.post('/:id/stop/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  if (phase === 'mail' && (row.stepMailMigration === 'running' || row.stepMailMigration === 'pending')) {
    await db.update(migrations).set({
      stepMailMigration: 'error',
      mailError: 'Arrêt forcé par l\'utilisateur',
      mailFinishedAt: new Date(),
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar' && (row.stepCalendarMigration === 'running' || row.stepCalendarMigration === 'pending')) {
    await db.update(migrations).set({
      stepCalendarMigration: 'error',
      calError: 'Arrêt forcé par l\'utilisateur',
      calFinishedAt: new Date(),
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts' && (row.stepContactsMigration === 'running' || row.stepContactsMigration === 'pending')) {
    await db.update(migrations).set({
      stepContactsMigration: 'error',
      contactsError: 'Arrêt forcé par l\'utilisateur',
      contactsFinishedAt: new Date(),
    }).where(eq(migrations.id, id))
  } else {
    return c.json({ error: 'Phase non en cours' }, 400)
  }

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Réinitialiser une phase (pour re-migrer depuis 0 après suppression Google) ──
migrationRouter.post('/:id/reset/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  if (phase === 'mail') {
    await db.delete(migratedMessages).where(eq(migratedMessages.migrationId, id))
    await db.update(migrations).set({
      stepMailMigration: 'pending',
      mailTotal: 0, mailMigrated: 0, mailFailed: 0,
      mailError: null, mailLastSyncAt: null, mailStartedAt: null, mailFinishedAt: null,
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar') {
    await db.delete(migratedEvents).where(eq(migratedEvents.migrationId, id))
    await db.update(migrations).set({
      stepCalendarMigration: 'pending',
      calTotal: 0, calMigrated: 0, calFailed: 0,
      calError: null, calLastSyncAt: null, calStartedAt: null, calFinishedAt: null,
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts') {
    await db.delete(migratedContacts).where(eq(migratedContacts.migrationId, id))
    await db.update(migrations).set({
      stepContactsMigration: 'pending',
      contactsTotal: 0, contactsMigrated: 0, contactsFailed: 0,
      contactsError: null, contactsLastSyncAt: null, contactsStartedAt: null, contactsFinishedAt: null,
    }).where(eq(migrations.id, id))
  } else {
    return c.json({ error: 'Phase invalide' }, 400)
  }

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Erreurs détaillées par phase ─────────────────────────────────────────────
migrationRouter.get('/:id/errors/:phase', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')

  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)

  if (phase === 'mail') {
    const rows = await db.select({
      id: migratedMessages.id,
      graphId: migratedMessages.graphMessageId,
      internetMessageId: migratedMessages.internetMessageId,
      errorDetails: migratedMessages.errorDetails,
      createdAt: migratedMessages.createdAt,
    })
      .from(migratedMessages)
      .where(and(eq(migratedMessages.migrationId, id), eq(migratedMessages.status, 'error')))
      .orderBy(desc(migratedMessages.createdAt))
      .limit(limit)
    return c.json({ phase, errors: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) })
  }

  if (phase === 'calendar') {
    const rows = await db.select({
      id: migratedEvents.id,
      graphId: migratedEvents.graphEventId,
      iCalUid: migratedEvents.iCalUid,
      errorDetails: migratedEvents.errorDetails,
      createdAt: migratedEvents.createdAt,
    })
      .from(migratedEvents)
      .where(and(eq(migratedEvents.migrationId, id), eq(migratedEvents.status, 'error')))
      .orderBy(desc(migratedEvents.createdAt))
      .limit(limit)
    return c.json({ phase, errors: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) })
  }

  if (phase === 'contacts') {
    const rows = await db.select({
      id: migratedContacts.id,
      graphId: migratedContacts.graphContactId,
      errorDetails: migratedContacts.errorDetails,
      createdAt: migratedContacts.createdAt,
    })
      .from(migratedContacts)
      .where(and(eq(migratedContacts.migrationId, id), eq(migratedContacts.status, 'error')))
      .orderBy(desc(migratedContacts.createdAt))
      .limit(limit)
    return c.json({ phase, errors: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) })
  }

  return c.json({ error: 'Phase invalide (mail, calendar, contacts)' }, 400)
})

// ── Télécharger les erreurs en CSV ───────────────────────────────────────────
migrationRouter.get('/:id/errors/:phase/download', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')

  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  let rows: Array<{ graphId: string; refId: string | null; errorDetails: string | null; createdAt: Date }> = []

  if (phase === 'mail') {
    const data = await db.select({
      graphId: migratedMessages.graphMessageId,
      refId: migratedMessages.internetMessageId,
      errorDetails: migratedMessages.errorDetails,
      createdAt: migratedMessages.createdAt,
    }).from(migratedMessages)
      .where(and(eq(migratedMessages.migrationId, id), eq(migratedMessages.status, 'error')))
      .orderBy(desc(migratedMessages.createdAt))
    rows = data
  } else if (phase === 'calendar') {
    const data = await db.select({
      graphId: migratedEvents.graphEventId,
      refId: migratedEvents.iCalUid,
      errorDetails: migratedEvents.errorDetails,
      createdAt: migratedEvents.createdAt,
    }).from(migratedEvents)
      .where(and(eq(migratedEvents.migrationId, id), eq(migratedEvents.status, 'error')))
      .orderBy(desc(migratedEvents.createdAt))
    rows = data
  } else if (phase === 'contacts') {
    const data = await db.select({
      graphId: migratedContacts.graphContactId,
      refId: migratedContacts.googleResourceName,
      errorDetails: migratedContacts.errorDetails,
      createdAt: migratedContacts.createdAt,
    }).from(migratedContacts)
      .where(and(eq(migratedContacts.migrationId, id), eq(migratedContacts.status, 'error')))
      .orderBy(desc(migratedContacts.createdAt))
    rows = data
  } else {
    return c.json({ error: 'Phase invalide' }, 400)
  }

  // Construire le CSV
  const csvEscape = (s: string | null) => {
    if (!s) return ''
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const csvLines = ['graphId,referenceId,errorDetails,createdAt']
  for (const r of rows) {
    csvLines.push([
      csvEscape(r.graphId),
      csvEscape(r.refId),
      csvEscape(r.errorDetails),
      r.createdAt.toISOString(),
    ].join(','))
  }

  const filename = `errors-${phase}-${row.onelaUpn.replace('@', '_')}-${new Date().toISOString().slice(0, 10)}.csv`
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  return c.body(csvLines.join('\n'))
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
    mailStartedAt: m.mailStartedAt ? m.mailStartedAt.toISOString() : null,
    mailFinishedAt: m.mailFinishedAt ? m.mailFinishedAt.toISOString() : null,
    mailLastSyncAt: m.mailLastSyncAt ? m.mailLastSyncAt.toISOString() : null,
    calStartedAt: m.calStartedAt ? m.calStartedAt.toISOString() : null,
    calFinishedAt: m.calFinishedAt ? m.calFinishedAt.toISOString() : null,
    calLastSyncAt: m.calLastSyncAt ? m.calLastSyncAt.toISOString() : null,
    contactsStartedAt: m.contactsStartedAt ? m.contactsStartedAt.toISOString() : null,
    contactsFinishedAt: m.contactsFinishedAt ? m.contactsFinishedAt.toISOString() : null,
    contactsLastSyncAt: m.contactsLastSyncAt ? m.contactsLastSyncAt.toISOString() : null,
    archived: m.archived === 1,
    archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null,
  }
}
