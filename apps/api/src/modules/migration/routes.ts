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
  setOnelaMailForwarding,
  removeOnelaMailForwarding,
  checkOnelaMailForwarding,
} from './service'
import { googleUserExists, addGoogleAlias, moveUserToOu } from './googleService'
import { ensureSendAs, setSendAsAsDefault } from '../shared-mailbox/gmailUserSetupService'
import { enqueueMailMigration, enqueueCalendarMigration, enqueueContactsMigration, signalStop, relabelMail } from './mailWorker'
import { gmailDedupeMailbox } from './mailService'
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
// Stratégie : on insère TOUS les records en pending immédiatement (synchrone, rapide),
// on répond 202 au front, puis on traite les étapes Graph en background (par user, en
// parallèle limité). Évite le timeout HTTP Azure (~230s) sur les gros lots.
migrationRouter.post('/run', requirePermission('migration:read'), async (c) => {
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

    // Générer UPN GOH : prenom.nom@mig.onela.com
    const firstName = u.givenName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '')
    const lastName = u.surname.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '')
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

// ── Provisioning Entra en background (séparé pour éviter le timeout HTTP) ────
// Chaque étape (create / setAttributes / link target) est tracée individuellement :
// si l'une échoue, seules les étapes effectivement échouées passent en 'error',
// pas les précédentes qui ont réussi.
async function provisionAccountBackground(params: {
  migrationId: string
  givenName: string
  surname: string
  gohUpn: string
  onelaEmail: string
  onelaUpn: string
  onelaDisplayName: string
  onelaDepartment: string | null
  onelaJobTitle: string | null
  tempPassword: string
  ext10: string
  ext11: string
}) {
  const db = getDb()
  const { migrationId, gohUpn, onelaUpn, onelaEmail, onelaDisplayName, onelaDepartment, onelaJobTitle, tempPassword, ext10, ext11, givenName, surname } = params

  // Relire l'état actuel pour ne re-faire que les étapes pas encore en success
  const [current] = await db.select().from(migrations).where(eq(migrations.id, migrationId))
  if (!current) {
    console.error(`[provisioning] ${migrationId} introuvable, abandon`)
    return
  }

  // ── Étape 1 : créer le compte GOH ──
  let gohUserId: string | null = current.gohUserId
  if (current.stepCreateAccount !== 'success') {
    await db.update(migrations).set({ stepCreateAccount: 'running' }).where(eq(migrations.id, migrationId))
    try {
      const exists = await checkGohUserExists(gohUpn)
      if (exists) throw new Error(`Le compte ${gohUpn} existe déjà dans Entra GOH`)
      const gohUser = await createGohUser({
        givenName, surname, upn: gohUpn, displayName: onelaDisplayName,
        department: onelaDepartment, jobTitle: onelaJobTitle, tempPassword,
      })
      gohUserId = gohUser.id
      await db.update(migrations)
        .set({ gohUserId, stepCreateAccount: 'success' })
        .where(eq(migrations.id, migrationId))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[provisioning] ${migrationId} create error:`, msg)
      await db.update(migrations)
        .set({ stepCreateAccount: 'error', errorDetails: msg })
        .where(eq(migrations.id, migrationId))
      return
    }
  }

  // ── Étape 2 : poser extensionAttribute10 + 11 ──
  if (current.stepSetAttributes !== 'success') {
    if (!gohUserId) {
      await db.update(migrations).set({ stepSetAttributes: 'error', errorDetails: 'gohUserId manquant' }).where(eq(migrations.id, migrationId))
      return
    }
    await db.update(migrations).set({ stepSetAttributes: 'running' }).where(eq(migrations.id, migrationId))
    try {
      await setGohUserAttributes(gohUserId, ext10, ext11)
      await db.update(migrations)
        .set({ stepSetAttributes: 'success' })
        .where(eq(migrations.id, migrationId))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[provisioning] ${migrationId} setAttributes error:`, msg)
      await db.update(migrations)
        .set({ stepSetAttributes: 'error', errorDetails: msg })
        .where(eq(migrations.id, migrationId))
      return
    }
  }

  // ── Étape 3 : groupe dynamique (auto-géré par companyName=ONELA, mais on le marque) ──
  // Génération du script PowerShell + liaison target → considérés comme l'étape 3
  if (current.stepGroupMembership !== 'success') {
    try {
      const psScript = [
        `# Forwarding Exchange ONELA → Google pour ${onelaDisplayName}`,
        `# À exécuter dans Exchange Online PowerShell`,
        `Connect-ExchangeOnline -UserPrincipalName admin@onelaservices.onmicrosoft.com -Device`,
        `Set-Mailbox -Identity "${onelaEmail}" \\`,
        `  -ForwardingSMTPAddress "${ext10}" \\`,
        `  -DeliverToMailboxAndForward $true`,
        `# Vérification`,
        `Get-Mailbox -Identity "${onelaEmail}" | Select ForwardingSMTPAddress, DeliverToMailboxAndForward`,
      ].join('\n')

      await db.update(migrations)
        .set({ stepGroupMembership: 'success', exchangePsScript: psScript })
        .where(eq(migrations.id, migrationId))

      await db.update(migrationTargets)
        .set({ status: 'in_progress', migrationId })
        .where(eq(migrationTargets.onelaUpn, onelaUpn))

      console.log(`[provisioning] ${migrationId} OK (${onelaUpn} → ${gohUpn})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[provisioning] ${migrationId} groupMembership error:`, msg)
      await db.update(migrations)
        .set({ stepGroupMembership: 'error', errorDetails: msg })
        .where(eq(migrations.id, migrationId))
    }
  }
}

// ── Retry du provisioning (pour les comptes qui ont échoué) ──────────────────
migrationRouter.post('/:id/retry-provisioning', requirePermission('migration:write'), async (c) => {
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

// ── Activer le nouveau format prenom.nom@onela.com (alias + send-as) ────────
// Le user a déjà l'alias legacy pnom@onela.com ; on ajoute ici l'alias
// prenom.nom@onela.com PLUS une identité "Envoyer en tant que" pour qu'il
// puisse communiquer en sortant avec le nouveau format dès la migration.
migrationRouter.post('/:id/activate-new-format', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé à cette migration' }, 400)

  // gohUpn = prenom.nom@mig.onela.com → alias = prenom.nom@onela.com
  const localPart = row.gohUpn.split('@')[0]
  if (!localPart) return c.json({ error: 'gohUpn invalide' }, 400)
  // Domaine cible : récupéré depuis onelaUpn (la BAL ONELA source)
  const targetDomain = row.onelaUpn.split('@')[1] ?? 'onela.com'
  const newAlias = `${localPart}@${targetDomain}`

  const result: {
    alias: string
    aliasAdded: boolean
    sendAsAdded: boolean
    setAsDefault: boolean
    warnings: string[]
  } = {
    alias: newAlias,
    aliasAdded: false,
    sendAsAdded: false,
    setAsDefault: false,
    warnings: [],
  }

  await db.update(migrations).set({ stepNewFormat: 'running', newFormatError: null }).where(eq(migrations.id, row.id))

  // 1. Ajouter l'alias sur le user Google (idempotent : 409 ignoré)
  try {
    await addGoogleAlias(row.gohUpn, newAlias)
    result.aliasAdded = true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('409')) {
      result.warnings.push(`Alias déjà présent`)
    } else {
      console.error('[activate-new-format] alias error:', msg)
      await db.update(migrations).set({ stepNewFormat: 'error', newFormatError: msg }).where(eq(migrations.id, row.id))
      return c.json({ error: 'alias', message: msg, ...result }, 502)
    }
  }

  // 2. Ajouter "Envoyer en tant que" sur le Gmail du user (idempotent)
  try {
    const sendAs = await ensureSendAs(row.gohUpn, newAlias, row.onelaDisplayName)
    result.sendAsAdded = sendAs.created
    if (!sendAs.created) result.warnings.push(`Send-as déjà présent`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[activate-new-format] sendas error:', msg)
    await db.update(migrations).set({ stepNewFormat: 'error', newFormatError: msg }).where(eq(migrations.id, row.id))
    return c.json({ error: 'sendas', message: msg, ...result }, 502)
  }

  // 3. Marquer cette identité comme adresse par défaut (PATCH isDefault: true)
  try {
    await setSendAsAsDefault(row.gohUpn, newAlias)
    result.setAsDefault = true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[activate-new-format] setDefault error:', msg)
    // Non bloquant : l'alias + send-as sont déjà ajoutés
    result.warnings.push(`Mise en défaut échouée : ${msg.slice(0, 200)}`)
  }

  // Étape considérée comme réussie même si setDefault a warningé
  await db.update(migrations).set({ stepNewFormat: 'success', newFormatError: null }).where(eq(migrations.id, row.id))

  return c.json({ ok: true, ...result })
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

// ── Re-labelliser les messages déjà migrés (corrige les labels sans re-migrer) ──
migrationRouter.post('/:id/relabel-mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)

  // Mettre un statut temporaire pour indiquer que c'est en cours
  await db.update(migrations).set({ mailError: 'Re-labellisation en cours…' }).where(eq(migrations.id, id))

  // Lancer en background (ne bloque pas la réponse HTTP)
  relabelMail(id)
    .then(async (result) => {
      let msg: string
      if (result.errors > 0) {
        const samples = result.errorSamples.length > 0
          ? ` — Ex: ${result.errorSamples[0]?.slice(0, 100)}`
          : ''
        msg = `Re-labellisation : ${result.relabeled} corrigés, ${result.skipped} ignorés, ${result.errors} erreurs${samples}`
      } else {
        msg = `Re-labellisation terminée : ${result.relabeled} corrigés, ${result.skipped} ignorés`
      }
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })
    .catch(async (err) => {
      const msg = `Re-labellisation échouée : ${err instanceof Error ? err.message : String(err)}`
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })

  return c.json({ message: 'Re-labellisation lancée en background' }, 202)
})

// ── Déduplication Gmail : nettoie les doublons par Message-ID ───────────────
// Scanne toute la mailbox, groupe par Message-ID RFC822 et envoie les doublons
// à la Corbeille (purge auto 30j, donc réversible si erreur).
migrationRouter.post('/:id/dedupe-mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)

  await db.update(migrations).set({ mailError: 'Déduplication Gmail en cours…' }).where(eq(migrations.id, id))

  gmailDedupeMailbox(row.gohUpn, async (scanned, removed) => {
    const msg = `Déduplication : ${scanned} scannés, ${removed} doublons supprimés…`
    await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
  })
    .then(async (result) => {
      const msg = `Déduplication terminée : ${result.duplicatesRemoved} doublons supprimés sur ${result.scanned} messages scannés${result.errors > 0 ? ` (${result.errors} erreurs)` : ''}`
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })
    .catch(async (err) => {
      const msg = `Déduplication échouée : ${err instanceof Error ? err.message : String(err)}`
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })

  return c.json({ message: 'Déduplication lancée en background' }, 202)
})

// ── Débloquer une phase coincée en 'running' sans worker actif (worker mort/hangé) ──
// Utilisé quand le bouton Pause ne répond plus (worker hung sur un appel Graph
// qui n'a jamais réveillé) ou après un crash silencieux du process Node.
// Force la phase en 'error' sans toucher au tracking → la reprise via "Reprendre"
// fonctionnera et le skipSet reprendra exactement au point d'arrêt.
migrationRouter.post('/:id/unstick/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  const stamp = new Date()
  if (phase === 'mail') {
    await db.update(migrations).set({
      stepMailMigration: 'error',
      mailError: `Déblocage manuel à ${row.mailMigrated}/${row.mailTotal} mails — clique "Reprendre" pour continuer`,
      mailFinishedAt: stamp,
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar') {
    await db.update(migrations).set({
      stepCalendarMigration: 'error',
      calError: `Déblocage manuel à ${row.calMigrated}/${row.calTotal} événements — clique "Reprendre" pour continuer`,
      calFinishedAt: stamp,
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts') {
    await db.update(migrations).set({
      stepContactsMigration: 'error',
      contactsError: `Déblocage manuel à ${row.contactsMigrated}/${row.contactsTotal} contacts — clique "Reprendre" pour continuer`,
      contactsFinishedAt: stamp,
    }).where(eq(migrations.id, id))
  } else {
    return c.json({ error: 'Phase invalide (mail, calendar, contacts)' }, 400)
  }

  // Best-effort : signaler le stop au cas où le worker reprend conscience
  signalStop(id, phase as 'mail' | 'calendar' | 'contacts')

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Forcer l'arrêt d'une phase (running → error) ────────────────────────────
migrationRouter.post('/:id/stop/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  if (phase === 'mail' && (row.stepMailMigration === 'running' || row.stepMailMigration === 'pending')) {
    // Signaler au worker de s'arrêter au prochain batch
    signalStop(id, 'mail')
    // Marquer immédiatement en DB pour le frontend
    await db.update(migrations).set({
      mailError: 'Arrêt en cours…',
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar' && (row.stepCalendarMigration === 'running' || row.stepCalendarMigration === 'pending')) {
    signalStop(id, 'calendar')
    await db.update(migrations).set({
      calError: 'Arrêt en cours…',
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts' && (row.stepContactsMigration === 'running' || row.stepContactsMigration === 'pending')) {
    signalStop(id, 'contacts')
    await db.update(migrations).set({
      contactsError: 'Arrêt en cours…',
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

  let rows: Array<{ graphId: string; refId: string | null; subject: string | null; receivedAt: Date | null; errorDetails: string | null; createdAt: Date }> = []

  if (phase === 'mail') {
    const data = await db.select({
      graphId: migratedMessages.graphMessageId,
      refId: migratedMessages.internetMessageId,
      subject: migratedMessages.subject,
      receivedAt: migratedMessages.receivedAt,
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
    rows = data.map((r) => ({ ...r, subject: null, receivedAt: null }))
  } else if (phase === 'contacts') {
    const data = await db.select({
      graphId: migratedContacts.graphContactId,
      refId: migratedContacts.googleResourceName,
      errorDetails: migratedContacts.errorDetails,
      createdAt: migratedContacts.createdAt,
    }).from(migratedContacts)
      .where(and(eq(migratedContacts.migrationId, id), eq(migratedContacts.status, 'error')))
      .orderBy(desc(migratedContacts.createdAt))
    rows = data.map((r) => ({ ...r, subject: null, receivedAt: null }))
  } else {
    return c.json({ error: 'Phase invalide' }, 400)
  }

  // Construire le CSV
  const csvEscape = (s: string | null) => {
    if (!s) return ''
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const csvLines = ['subject,receivedAt,graphId,referenceId,errorDetails,createdAt']
  for (const r of rows) {
    csvLines.push([
      csvEscape(r.subject),
      r.receivedAt ? r.receivedAt.toISOString() : '',
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

// ── Forwarding Exchange ONELA → mig.onela.com ──────────────────────────────
migrationRouter.post('/:id/forwarding', requirePermission('migration:write'), async (c) => {
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

migrationRouter.delete('/:id/forwarding', requirePermission('migration:write'), async (c) => {
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

migrationRouter.get('/:id/forwarding', requirePermission('migration:read'), async (c) => {
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
