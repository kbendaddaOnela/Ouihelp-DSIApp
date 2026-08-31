import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { db } from '../../db/index'
import { ximiMigrations, ximiMigratedItems } from './schema'
import { SOURCE, listAllSites, searchTargetGroups } from './graphService'
import { normalizeAlias } from './sharepointAdminService'
import { signalStopXimi } from './worker'
import { agencyOf, dynamicGroupNameFor } from './agencyMatch'
import type {
  XimiSourceSitesResponse,
  XimiTargetGroupsResponse,
  CreateXimiMigrationRequest,
  XimiMigrationRecord,
  XimiMigrationHistoryResponse,
  XimiMigrationErrorsResponse,
  XimiMappingResponse,
  XimiMappingRow,
  XimiChangedItem,
  XimiMigrationChangesResponse,
} from '@dsi-app/shared'

export const ximiMigrationRouter = new Hono<{ Variables: RbacVariables }>()
ximiMigrationRouter.use('*', authMiddleware, loadUserRole)

function toRecord(m: typeof ximiMigrations.$inferSelect): XimiMigrationRecord {
  return {
    id: m.id,
    label: m.label,
    sourceSiteUrl: m.sourceSiteUrl,
    sourceSiteId: m.sourceSiteId,
    sourceSiteName: m.sourceSiteName,
    sourceDriveId: m.sourceDriveId,
    sourceDriveName: m.sourceDriveName,
    targetSiteUrl: m.targetSiteUrl,
    targetSiteId: m.targetSiteId,
    targetSiteName: m.targetSiteName,
    targetSiteAlias: m.targetSiteAlias,
    targetDriveId: m.targetDriveId,
    siteStatus: m.siteStatus,
    siteError: m.siteError,
    dynamicGroupName: m.dynamicGroupName,
    dynamicGroupId: m.dynamicGroupId,
    permissionStatus: m.permissionStatus,
    permissionError: m.permissionError,
    status: m.status,
    analyzeOnly: m.analyzeOnly,
    totalItems: m.totalItems,
    migratedItems: m.migratedItems,
    updatedItems: m.updatedItems,
    deletedItems: m.deletedItems,
    movedItems: m.movedItems,
    failedItems: m.failedItems,
    skippedItems: m.skippedItems,
    scannedItems: m.scannedItems,
    totalBytes: m.totalBytes,
    migratedBytes: m.migratedBytes,
    processedBytes: m.processedBytes,
    hasDeltaToken: !!m.deltaToken,
    lastDeltaAt: m.lastDeltaAt ? m.lastDeltaAt.toISOString() : null,
    errorDetails: m.errorDetails,
    startedAt: m.startedAt ? m.startedAt.toISOString() : null,
    finishedAt: m.finishedAt ? m.finishedAt.toISOString() : null,
    archived: m.archived === 1,
    archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null,
    initiatedBy: m.initiatedBy,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }
}

// ── Sites disponibles sur le tenant ONELA ─────────────────────────────────────
// Chaque site est enrichi de l'agence déduite (→ groupe dynamique proposé) et du
// fait qu'une migration existe déjà : c'est ce qui permet de tout sélectionner
// d'un coup sans créer de doublon.
ximiMigrationRouter.get('/source-sites', requirePermission('migration:read'), async (c) => {
  const q = c.req.query('q')?.trim().toLowerCase() ?? ''
  try {
    const sites = await listAllSites(SOURCE)
    const existing = await db
      .select({ sourceSiteId: ximiMigrations.sourceSiteId })
      .from(ximiMigrations)
    const migratedIds = new Set(existing.map((e) => e.sourceSiteId))

    const filtered = q
      ? sites.filter(
          (s) =>
            (s.displayName ?? s.name).toLowerCase().includes(q) ||
            (s.webUrl ?? '').toLowerCase().includes(q),
        )
      : sites
    return c.json<XimiSourceSitesResponse>({
      scanned: sites.length,
      sites: filtered.map((s) => {
        const label = s.displayName ?? s.name
        const alias = s.webUrl ? (s.webUrl.split('/sites/')[1]?.split('/')[0] ?? null) : null
        return {
          id: s.id,
          name: s.name,
          displayName: s.displayName,
          webUrl: s.webUrl,
          alias,
          agencyTrigramme: agencyOf(label, alias)?.trigramme ?? null,
          alreadyMigrated: migratedIds.has(s.id),
        }
      }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ximi/source-sites]', msg)
    return c.json({ error: msg }, 500)
  }
})

// ── Groupes du tenant Ouihelp (recherche par préfixe) ─────────────────────────
ximiMigrationRouter.get('/target-groups', requirePermission('migration:read'), async (c) => {
  try {
    const groups = await searchTargetGroups(c.req.query('q') ?? '')
    return c.json<XimiTargetGroupsResponse>({ groups })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ximi/target-groups]', msg)
    return c.json({ error: msg }, 500)
  }
})

// ── Historique ────────────────────────────────────────────────────────────────
ximiMigrationRouter.get('/history', requirePermission('migration:read'), async (c) => {
  const archivedFlag = ['1', 'true'].includes(c.req.query('archived') ?? '') ? 1 : 0
  const rows = await db
    .select()
    .from(ximiMigrations)
    .where(eq(ximiMigrations.archived, archivedFlag))
    .orderBy(desc(ximiMigrations.createdAt))
  return c.json<XimiMigrationHistoryResponse>({
    migrations: rows.map(toRecord),
    total: rows.length,
  })
})

/** Insère une migration depuis une demande (partagé création simple / en lot). */
async function insertMigration(
  body: CreateXimiMigrationRequest,
  initiatedBy: string,
): Promise<string> {
  const id = randomUUID()
  const sourceLabel = body.sourceSiteName
  const sourceAlias = body.sourceSiteUrl.split('/sites/')[1]?.split('/')[0] ?? null
  const agency = agencyOf(sourceLabel, sourceAlias)
  // Le groupe dynamique est déduit de l'agence quand l'opérateur n'en impose pas :
  // c'est la règle métier (un site d'agence = le groupe dynamique de l'agence),
  // et la saisir 40 fois à la main serait une source d'erreurs.
  const groupName =
    body.dynamicGroupName?.trim() || (agency ? dynamicGroupNameFor(agency.trigramme) : null)
  const preexisting = !!body.existingTargetSiteUrl?.trim()

  await db.insert(ximiMigrations).values({
    id,
    label: body.label?.trim() || null,
    sourceSiteUrl: body.sourceSiteUrl,
    sourceSiteId: body.sourceSiteId,
    sourceSiteName: sourceLabel,
    targetSiteName: body.targetSiteTitle?.trim() || sourceLabel,
    targetSiteAlias: normalizeAlias(body.targetSiteAlias?.trim() || sourceAlias || sourceLabel),
    targetSiteUrl: preexisting ? body.existingTargetSiteUrl!.trim() : null,
    targetPreexisting: preexisting,
    dynamicGroupName: groupName,
    dynamicGroupId: body.dynamicGroupId?.trim() || null,
    // Sans groupe à appliquer, l'étape est « sans objet », pas « en attente ».
    permissionStatus: groupName ? 'pending' : 'skipped',
    analyzeOnly: body.analyzeOnly === true,
    initiatedBy,
  })
  return id
}

// ── Création (un site) ────────────────────────────────────────────────────────
ximiMigrationRouter.post('/', requirePermission('migration:write'), async (c) => {
  const body = await c.req.json<CreateXimiMigrationRequest>()
  if (!body.sourceSiteId || !body.sourceSiteUrl || !body.sourceSiteName) {
    return c.json({ error: 'Champs requis manquants (sourceSiteId, sourceSiteUrl, sourceSiteName)' }, 400)
  }
  const id = await insertMigration(body, c.get('dbUser').email)
  const [created] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id))
  return c.json<XimiMigrationRecord>(toRecord(created!))
})

// ── Création en lot ───────────────────────────────────────────────────────────
// Une agence = un site = une ligne. En créer 40 une par une depuis l'UI serait
// le vrai coût du module : ce endpoint prend la sélection entière.
ximiMigrationRouter.post('/bulk', requirePermission('migration:write'), async (c) => {
  const body = await c.req.json<{ sites: CreateXimiMigrationRequest[] }>()
  const list = Array.isArray(body.sites) ? body.sites : []
  if (list.length === 0) return c.json({ error: 'Aucun site fourni' }, 400)

  const email = c.get('dbUser').email
  const existing = await db
    .select({ sourceSiteId: ximiMigrations.sourceSiteId })
    .from(ximiMigrations)
  const known = new Set(existing.map((e) => e.sourceSiteId))

  const createdIds: string[] = []
  const skipped: string[] = []
  for (const site of list) {
    if (!site.sourceSiteId || !site.sourceSiteUrl || !site.sourceSiteName) continue
    // Idempotence : deux migrations sur le même site source dupliqueraient tout
    // le contenu dans deux sites cibles différents.
    if (known.has(site.sourceSiteId)) {
      skipped.push(site.sourceSiteName)
      continue
    }
    known.add(site.sourceSiteId)
    createdIds.push(await insertMigration(site, email))
  }
  return c.json({ created: createdIds.length, skipped })
})

// ── Relancer / reprendre ──────────────────────────────────────────────────────
ximiMigrationRouter.post('/:id/run', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  if (row.archived === 1) {
    return c.json({ error: 'Migration archivée — désarchive-la avant de la relancer' }, 409)
  }
  await db
    .update(ximiMigrations)
    .set({ status: 'pending', errorDetails: null })
    .where(eq(ximiMigrations.id, id))
  const [updated] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id))
  return c.json<XimiMigrationRecord>(toRecord(updated!))
})

// ── Lancer une passe sur toutes les migrations actives (synchro du jour J) ────
ximiMigrationRouter.post('/run-all', requirePermission('migration:write'), async (c) => {
  const rows = await db.select().from(ximiMigrations).where(eq(ximiMigrations.archived, 0))
  const eligible = rows.filter(
    (r) => r.status !== 'running' && r.status !== 'pending' && !r.analyzeOnly,
  )
  for (const r of eligible) {
    await db
      .update(ximiMigrations)
      .set({ status: 'pending', errorDetails: null })
      .where(eq(ximiMigrations.id, r.id))
  }
  // Le worker traite une migration à la fois : la file se vide séquentiellement.
  return c.json({ queued: eligible.length })
})

ximiMigrationRouter.post('/:id/pause', requirePermission('migration:write'), async (c) => {
  signalStopXimi(c.req.param('id'))
  return c.json({ ok: true })
})

// ── Débloquer un worker hung ──────────────────────────────────────────────────
ximiMigrationRouter.post('/:id/unstick', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  await db
    .update(ximiMigrations)
    .set({ status: 'error', errorDetails: 'Débloqué manuellement (worker hung)' })
    .where(eq(ximiMigrations.id, id))
  return c.json({ ok: true })
})

// ── Rejouer uniquement l'attribution des droits ───────────────────────────────
// L'attribution est non bloquante pendant le transfert : il faut donc pouvoir la
// reprendre seule, sans relancer une passe sur des dizaines de Go.
ximiMigrationRouter.post('/:id/retry-permissions', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const body: { dynamicGroupName?: string; dynamicGroupId?: string } = await c.req
    .json<{ dynamicGroupName?: string; dynamicGroupId?: string }>()
    .catch(() => ({}))
  const [row] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  if (!row.targetSiteUrl) {
    return c.json({ error: 'Le site cible n\'existe pas encore — lance d\'abord la migration' }, 409)
  }
  await db
    .update(ximiMigrations)
    .set({
      permissionStatus: 'pending',
      permissionError: null,
      ...(body.dynamicGroupName ? { dynamicGroupName: body.dynamicGroupName.trim() } : {}),
      // Un changement de nom de groupe doit invalider l'id résolu précédemment.
      ...(body.dynamicGroupName || body.dynamicGroupId
        ? { dynamicGroupId: body.dynamicGroupId?.trim() || null }
        : {}),
      status: 'pending',
    })
    .where(eq(ximiMigrations.id, id))
  const [updated] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id))
  return c.json<XimiMigrationRecord>(toRecord(updated!))
})

// ── Renommer ──────────────────────────────────────────────────────────────────
ximiMigrationRouter.patch('/:id', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ label?: string | null; targetSiteAlias?: string }>()
  const patch: Record<string, unknown> = {}
  if (typeof body.label === 'string') patch['label'] = body.label.trim().slice(0, 200) || null
  if (typeof body.targetSiteAlias === 'string') {
    const [row] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id))
    // Une fois le site créé, changer l'alias ne renommerait rien côté SharePoint :
    // ce serait un mensonge dans le tableau de mappage remis à Ximi.
    if (row?.targetSiteId) {
      return c.json({ error: 'Le site cible est déjà créé — son alias ne peut plus changer' }, 409)
    }
    patch['targetSiteAlias'] = normalizeAlias(body.targetSiteAlias)
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Rien à modifier' }, 400)
  await db.update(ximiMigrations).set(patch).where(eq(ximiMigrations.id, id))
  const [updated] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id)).limit(1)
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(toRecord(updated))
})

// ── Archiver / désarchiver ────────────────────────────────────────────────────
ximiMigrationRouter.post('/:id/archive', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (row.status === 'running' || row.status === 'pending') {
    return c.json({ error: "Migration en cours — mets-la en pause avant de l'archiver" }, 409)
  }
  await db
    .update(ximiMigrations)
    .set({ archived: 1, archivedAt: new Date() })
    .where(eq(ximiMigrations.id, id))
  const [updated] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id)).limit(1)
  return c.json(toRecord(updated!))
})

ximiMigrationRouter.post('/:id/unarchive', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  await db
    .update(ximiMigrations)
    .set({ archived: 0, archivedAt: null })
    .where(eq(ximiMigrations.id, id))
  const [updated] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id)).limit(1)
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(toRecord(updated))
})

// ── Suppression (du suivi seulement — ne touche PAS au site cible) ────────────
ximiMigrationRouter.delete('/:id', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  await db.delete(ximiMigratedItems).where(eq(ximiMigratedItems.migrationId, id))
  await db.delete(ximiMigrations).where(eq(ximiMigrations.id, id))
  return c.json({ ok: true })
})

// ── Erreurs détaillées ────────────────────────────────────────────────────────
ximiMigrationRouter.get('/:id/errors', requirePermission('migration:read'), async (c) => {
  const id = c.req.param('id')
  const rows = await db
    .select()
    .from(ximiMigratedItems)
    .where(eq(ximiMigratedItems.migrationId, id))
  const toItem = (r: (typeof rows)[number]) => ({
    id: r.id,
    spItemId: r.spItemId,
    name: r.name,
    spPath: r.spPath,
    isFolder: r.isFolder,
    sizeBytes: r.sizeBytes,
    errorDetails: r.errorDetails,
    createdAt: r.createdAt.toISOString(),
  })
  return c.json<XimiMigrationErrorsResponse>({
    errors: rows.filter((r) => r.status === 'error').map(toItem),
    skipped: rows.filter((r) => r.status === 'skipped').map(toItem),
  })
})

// ── Ce que la dernière passe a changé ─────────────────────────────────────────
// « 35 mis à jour » sans la liste est inexploitable le jour J : l'opérateur doit
// pouvoir vérifier ce qui a bougé — y compris les suppressions, qui sont la
// catégorie la plus sensible.
ximiMigrationRouter.get('/:id/changes', requirePermission('migration:read'), async (c) => {
  const id = c.req.param('id')
  const [job] = await db.select().from(ximiMigrations).where(eq(ximiMigrations.id, id)).limit(1)
  if (!job) return c.json({ error: 'Not Found' }, 404)

  const rows = await db
    .select()
    .from(ximiMigratedItems)
    .where(eq(ximiMigratedItems.migrationId, id))
  const runStart = job.startedAt

  const toItem = (r: (typeof rows)[number]): XimiChangedItem => ({
    id: r.id,
    name: r.name,
    spPath: r.spPath,
    sizeBytes: r.sizeBytes,
    spLastModified: r.spLastModified?.toISOString() ?? null,
    syncedAt: r.syncedAt?.toISOString() ?? null,
  })

  const touched = runStart
    ? rows.filter((r) => !r.isFolder && r.syncedAt && r.syncedAt >= runStart)
    : []
  const deleted = touched.filter((r) => r.status === 'deleted').map(toItem)
  // Un item en erreur a bien été TOUCHÉ par la passe, mais il n'a été ni créé ni
  // mis à jour côté cible : le lister comme tel donnerait une fausse assurance
  // le jour J. Il reste consultable via /errors.
  const alive = touched.filter((r) => r.status === 'success')
  const created = alive.filter((r) => r.createdAt >= runStart!).map(toItem)
  const updated = alive.filter((r) => r.createdAt < runStart!).map(toItem)

  const bySyncDesc = (a: XimiChangedItem, b: XimiChangedItem) =>
    (b.syncedAt ?? '').localeCompare(a.syncedAt ?? '')
  const CAP = 500
  return c.json<XimiMigrationChangesResponse>({
    runStartedAt: runStart?.toISOString() ?? null,
    createdCount: created.length,
    updatedCount: updated.length,
    // `movedItems` est un compteur de passe (pas un statut de ligne) : on le lit
    // sur la migration plutôt que de le recalculer depuis les lignes.
    movedCount: job.movedItems,
    deletedCount: deleted.length,
    truncated: created.length > CAP || updated.length > CAP,
    created: created.sort(bySyncDesc).slice(0, CAP),
    updated: updated.sort(bySyncDesc).slice(0, CAP),
    moved: [],
    deleted: deleted.sort(bySyncDesc).slice(0, CAP),
  })
})

// ── Tableau de mappage ONELA ↔ Ouihelp (livrable pour Ximi) ───────────────────

function buildMappingRows(rows: Array<typeof ximiMigrations.$inferSelect>): XimiMappingRow[] {
  return rows.map((m) => {
    const alias = m.sourceSiteUrl.split('/sites/')[1]?.split('/')[0] ?? null
    const agency = agencyOf(m.sourceSiteName, alias)
    return {
      migrationId: m.id,
      agency: agency?.name ?? m.label ?? m.sourceSiteName,
      sourceSiteName: m.sourceSiteName,
      sourceSiteId: m.sourceSiteId,
      sourceSiteUrl: m.sourceSiteUrl,
      targetSiteName: m.targetSiteName,
      targetSiteId: m.targetSiteId,
      targetSiteUrl: m.targetSiteUrl,
      dynamicGroupName: m.dynamicGroupName,
      permissionStatus: m.permissionStatus,
      status: m.status,
      filesMigrated: m.migratedItems,
      lastSyncAt: (m.lastDeltaAt ?? m.finishedAt)?.toISOString() ?? null,
    }
  })
}

ximiMigrationRouter.get('/mapping', requirePermission('migration:read'), async (c) => {
  const rows = await db.select().from(ximiMigrations).orderBy(desc(ximiMigrations.createdAt))
  return c.json<XimiMappingResponse>({
    rows: buildMappingRows(rows.filter((r) => !r.analyzeOnly)),
    generatedAt: new Date().toISOString(),
  })
})

/** Échappement CSV : guillemets doublés, champ cité dès qu'il contient un séparateur. */
function csvCell(value: string | number | null): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Le livrable remis à Ximi. Séparateur « ; » et BOM UTF-8 : c'est ce qu'attend
// Excel en configuration française — sans ça le fichier s'ouvre en une colonne
// et les accents sont cassés.
ximiMigrationRouter.get('/mapping/download', requirePermission('migration:read'), async () => {
  const rows = await db.select().from(ximiMigrations).orderBy(desc(ximiMigrations.createdAt))
  const mapping = buildMappingRows(rows.filter((r) => !r.analyzeOnly))
  const header = [
    'Agence',
    'Site ONELA (nom)',
    'Site ONELA (URL)',
    'Site ONELA (ID)',
    'Site Ouihelp (nom)',
    'Site Ouihelp (URL)',
    'Site Ouihelp (ID)',
    'Groupe dynamique',
    'Droits',
    'Statut migration',
    'Fichiers migrés',
    'Dernière synchro',
  ]
  const lines = [header.join(';')]
  for (const r of mapping) {
    lines.push(
      [
        csvCell(r.agency),
        csvCell(r.sourceSiteName),
        csvCell(r.sourceSiteUrl),
        csvCell(r.sourceSiteId),
        csvCell(r.targetSiteName),
        csvCell(r.targetSiteUrl),
        csvCell(r.targetSiteId),
        csvCell(r.dynamicGroupName),
        csvCell(r.permissionStatus),
        csvCell(r.status),
        csvCell(r.filesMigrated),
        csvCell(r.lastSyncAt),
      ].join(';'),
    )
  }
  const csv = `﻿${lines.join('\r\n')}\r\n`
  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="mappage-sharepoint-ximi-${stamp}.csv"`,
    },
  })
})
