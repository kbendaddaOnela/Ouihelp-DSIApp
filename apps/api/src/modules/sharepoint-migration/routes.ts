import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { db } from '../../db/index'
import { sharepointMigrations, sharepointMigratedItems } from './schema'
import { resolveSiteByUrl, listChildren } from './sharepointService'
import { searchSharedDrives } from './googleDriveService'
import { signalStopSharepoint } from './worker'
import type {
  ResolveSiteResponse,
  BrowseResponse,
  SearchSharedDrivesResponse,
  CreateSharepointMigrationRequest,
  SharepointMigrationRecord,
  SharepointMigrationHistoryResponse,
  SharepointMigrationErrorsResponse,
  SharepointChangedItem,
  SharepointMigrationChangesResponse,
} from '@dsi-app/shared'

export const sharepointMigrationRouter = new Hono<{ Variables: RbacVariables }>()
sharepointMigrationRouter.use('*', authMiddleware, loadUserRole)

/** Parse le JSON analysis_result (tolérant). */
function parseAnalysis(raw: string | null): Array<{ name: string; files: number; bytes: number }> | null {
  if (!raw) return null
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return null
    return arr
      .filter((b) => b && typeof b.name === 'string')
      .map((b) => ({ name: b.name, files: Number(b.files) || 0, bytes: Number(b.bytes) || 0 }))
  } catch {
    return null
  }
}

/** Parse le JSON selected_roots (tolérant). */
function parseRoots(raw: string | null): Array<{ id: string; name: string }> {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string')
      .map((r) => ({ id: r.id, name: r.name }))
  } catch {
    return []
  }
}

function toRecord(m: typeof sharepointMigrations.$inferSelect): SharepointMigrationRecord {
  return {
    id: m.id,
    siteUrl: m.siteUrl,
    siteId: m.siteId,
    siteName: m.siteName,
    driveId: m.driveId,
    driveName: m.driveName,
    label: m.label,
    rootItemId: m.rootItemId,
    rootPath: m.rootPath,
    selectedRoots: parseRoots(m.selectedRoots),
    gdSharedDriveId: m.gdSharedDriveId,
    gdSharedDriveName: m.gdSharedDriveName,
    status: m.status,
    totalItems: m.totalItems,
    migratedItems: m.migratedItems,
    failedItems: m.failedItems,
    skippedItems: m.skippedItems,
    totalBytes: m.totalBytes,
    migratedBytes: m.migratedBytes,
    processedBytes: m.processedBytes,
    updatedItems: m.updatedItems,
    scannedItems: m.scannedItems,
    archived: m.archived === 1,
    archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null,
    migrateVersions: m.migrateVersions,
    maxVersions: m.maxVersions,
    analyzeOnly: m.analyzeOnly,
    analysisResult: parseAnalysis(m.analysisResult),
    errorDetails: m.errorDetails,
    startedAt: m.startedAt ? m.startedAt.toISOString() : null,
    finishedAt: m.finishedAt ? m.finishedAt.toISOString() : null,
    initiatedBy: m.initiatedBy,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }
}

// ── Résolution d'une URL de site SharePoint → site + bibliothèques ───────────
sharepointMigrationRouter.get('/resolve-site', requirePermission('migration:read'), async (c) => {
  const url = c.req.query('url')?.trim()
  if (!url) return c.json({ error: 'Paramètre "url" requis' }, 400)
  try {
    const { site, drives } = await resolveSiteByUrl(url)
    return c.json<ResolveSiteResponse>({
      site: {
        id: site.id,
        name: site.name,
        displayName: site.displayName,
        webUrl: site.webUrl,
      },
      drives,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[sharepoint/resolve-site]', msg)
    return c.json({ error: msg }, 500)
  }
})

// ── Navigation dans une bibliothèque (choix du dossier à migrer) ─────────────
sharepointMigrationRouter.get('/browse', requirePermission('migration:read'), async (c) => {
  const driveId = c.req.query('driveId')?.trim()
  const itemId = c.req.query('itemId')?.trim() || null
  if (!driveId) return c.json({ error: 'Paramètre "driveId" requis' }, 400)
  try {
    const items = await listChildren(driveId, itemId)
    return c.json<BrowseResponse>({
      folderPath: null,
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        isFolder: i.isFolder,
        size: i.size,
        childCount: i.childCount,
        webUrl: i.webUrl,
      })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[sharepoint/browse]', msg)
    return c.json({ error: msg }, 500)
  }
})

// ── Recherche de Shared Drives Google (créés manuellement par l'admin) ───────
sharepointMigrationRouter.get('/search-drives', requirePermission('migration:read'), async (c) => {
  const q = c.req.query('q')?.trim() ?? null
  try {
    const drives = await searchSharedDrives(q)
    return c.json<SearchSharedDrivesResponse>({ drives })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[sharepoint/search-drives]', msg)
    return c.json({ error: msg }, 500)
  }
})

// ── Historique ────────────────────────────────────────────────────────────────
// `archived=1` renvoie l'historique, sinon les migrations actives. Le filtre est
// fait en SQL : la liste active ne doit pas se diluer au fil des passes delta.
sharepointMigrationRouter.get('/history', requirePermission('migration:read'), async (c) => {
  const archivedFlag = ['1', 'true'].includes(c.req.query('archived') ?? '') ? 1 : 0
  const rows = await db
    .select()
    .from(sharepointMigrations)
    .where(eq(sharepointMigrations.archived, archivedFlag))
    .orderBy(desc(sharepointMigrations.createdAt))
  return c.json<SharepointMigrationHistoryResponse>({
    migrations: rows.map(toRecord),
    total: rows.length,
  })
})

// ── Création d'une migration ──────────────────────────────────────────────────
sharepointMigrationRouter.post('/', requirePermission('migration:write'), async (c) => {
  const body = await c.req.json<CreateSharepointMigrationRequest>()
  const analyzeOnly = body.analyzeOnly === true
  if (!body.siteId || !body.driveId) {
    return c.json({ error: 'Champs requis manquants (siteId, driveId)' }, 400)
  }
  // Le Shared Drive cible n'est requis que si on transfère réellement
  if (!analyzeOnly && !body.gdSharedDriveId?.trim()) {
    return c.json({ error: 'Champs requis manquants (gdSharedDriveId)' }, 400)
  }
  const initiatedBy = c.get('dbUser').email
  const id = randomUUID()
  // Dossiers sélectionnés (chacun recréé à la racine). Vide = bibliothèque entière.
  const roots = (body.selectedRoots ?? []).filter((r) => r?.id && r?.name)
  const displayPath = roots.length > 0 ? roots.map((r) => r.name).join(', ') : null
  await db.insert(sharepointMigrations).values({
    id,
    siteUrl: body.siteUrl,
    siteId: body.siteId,
    siteName: body.siteName,
    driveId: body.driveId,
    driveName: body.driveName,
    label: body.label?.trim() || null,
    rootItemId: null,
    rootPath: displayPath,
    selectedRoots: roots.length > 0 ? JSON.stringify(roots) : null,
    gdSharedDriveId: body.gdSharedDriveId?.trim() || null,
    gdSharedDriveName: body.gdSharedDriveName?.trim() || `Analyse — ${body.driveName}`,
    migrateVersions: body.migrateVersions ?? true,
    maxVersions: Number.isFinite(body.maxVersions) ? Number(body.maxVersions) : 5,
    analyzeOnly,
    initiatedBy,
  })
  const [created] = await db.select().from(sharepointMigrations).where(eq(sharepointMigrations.id, id))
  return c.json<SharepointMigrationRecord>(toRecord(created!))
})

// ── Relancer / reprendre (status → pending) ───────────────────────────────────
sharepointMigrationRouter.post('/:id/run', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharepointMigrations).where(eq(sharepointMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  // Le worker ignore les archivées : sans ce garde-fou, le job resterait en
  // 'pending' pour toujours sans que rien ne le traite.
  if (row.archived === 1) {
    return c.json({ error: 'Migration archivée — désarchive-la avant de la relancer' }, 409)
  }
  await db
    .update(sharepointMigrations)
    .set({ status: 'pending', errorDetails: null })
    .where(eq(sharepointMigrations.id, id))
  const [updated] = await db.select().from(sharepointMigrations).where(eq(sharepointMigrations.id, id))
  return c.json<SharepointMigrationRecord>(toRecord(updated!))
})

// ── Mettre en pause (arrêt propre) ────────────────────────────────────────────
sharepointMigrationRouter.post('/:id/pause', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  signalStopSharepoint(id)
  return c.json({ ok: true })
})

// ── Débloquer un worker hung (force status='error' sans perdre le tracking) ──
sharepointMigrationRouter.post('/:id/unstick', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select().from(sharepointMigrations).where(eq(sharepointMigrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  await db
    .update(sharepointMigrations)
    .set({ status: 'error', errorDetails: 'Débloqué manuellement (worker hung)' })
    .where(eq(sharepointMigrations.id, id))
  return c.json({ ok: true })
})

// ── Suppression ───────────────────────────────────────────────────────────────
sharepointMigrationRouter.delete('/:id', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  await db.delete(sharepointMigratedItems).where(eq(sharepointMigratedItems.migrationId, id))
  await db.delete(sharepointMigrations).where(eq(sharepointMigrations.id, id))
  return c.json({ ok: true })
})

// ── Renommer (libellé libre) ──────────────────────────────────────────────────
// Purement cosmétique : aucun impact sur le transfert ni sur l'idempotence.
sharepointMigrationRouter.patch('/:id', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ label?: string | null }>()
  // Chaîne vide = retour au libellé par défaut (nom du Shared Drive), pas une erreur.
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 200) || null : null
  await db
    .update(sharepointMigrations)
    .set({ label })
    .where(eq(sharepointMigrations.id, id))
  const [updated] = await db
    .select()
    .from(sharepointMigrations)
    .where(eq(sharepointMigrations.id, id))
    .limit(1)
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(toRecord(updated))
})

// ── Archiver / désarchiver ────────────────────────────────────────────────────
// Une migration archivée sort de la liste active ET du polling du worker.
// On refuse d'archiver un run en cours : il continuerait en arrière-plan sans
// être visible nulle part.
sharepointMigrationRouter.post('/:id/archive', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const [row] = await db
    .select()
    .from(sharepointMigrations)
    .where(eq(sharepointMigrations.id, id))
    .limit(1)
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (row.status === 'running' || row.status === 'pending') {
    return c.json(
      { error: 'Migration en cours — mets-la en pause avant de l\'archiver' },
      409,
    )
  }
  await db
    .update(sharepointMigrations)
    .set({ archived: 1, archivedAt: new Date() })
    .where(eq(sharepointMigrations.id, id))
  const [updated] = await db
    .select()
    .from(sharepointMigrations)
    .where(eq(sharepointMigrations.id, id))
    .limit(1)
  return c.json(toRecord(updated!))
})

sharepointMigrationRouter.post('/:id/unarchive', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  await db
    .update(sharepointMigrations)
    .set({ archived: 0, archivedAt: null })
    .where(eq(sharepointMigrations.id, id))
  const [updated] = await db
    .select()
    .from(sharepointMigrations)
    .where(eq(sharepointMigrations.id, id))
    .limit(1)
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(toRecord(updated))
})

// ── Erreurs détaillées ────────────────────────────────────────────────────────
sharepointMigrationRouter.get('/:id/errors', requirePermission('migration:read'), async (c) => {
  const id = c.req.param('id')
  const rows = await db
    .select()
    .from(sharepointMigratedItems)
    .where(eq(sharepointMigratedItems.migrationId, id))
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
  const errors = rows.filter((r) => r.status === 'error').map(toItem)
  const skipped = rows.filter((r) => r.status === 'skipped').map(toItem)
  return c.json<SharepointMigrationErrorsResponse>({ errors, skipped })
})

// ── Ce que la dernière passe a changé ─────────────────────────────────────────
// Sur une passe delta, « 35 mis à jour » sans la liste est inexploitable :
// l'opérateur doit pouvoir vérifier CE QUI a bougé avant de valider.
sharepointMigrationRouter.get('/:id/changes', requirePermission('migration:read'), async (c) => {
  const id = c.req.param('id')
  const [job] = await db
    .select()
    .from(sharepointMigrations)
    .where(eq(sharepointMigrations.id, id))
    .limit(1)
  if (!job) return c.json({ error: 'Not Found' }, 404)

  const rows = await db
    .select()
    .from(sharepointMigratedItems)
    .where(eq(sharepointMigratedItems.migrationId, id))

  const runStart = job.startedAt
  const toItem = (r: (typeof rows)[number]): SharepointChangedItem => ({
    id: r.id,
    name: r.name,
    spPath: r.spPath,
    sizeBytes: r.sizeBytes,
    spLastModified: r.spLastModified?.toISOString() ?? null,
    syncedAt: r.syncedAt?.toISOString() ?? null,
  })

  // Touché par cette passe = syncedAt >= début du run. Créé pendant cette passe
  // = la ligne elle-même est née pendant le run (createdAt >= début du run).
  const touched = runStart
    ? rows.filter((r) => !r.isFolder && r.syncedAt && r.syncedAt >= runStart)
    : []
  const created = touched.filter((r) => r.createdAt >= runStart!).map(toItem)
  const updated = touched.filter((r) => r.createdAt < runStart!).map(toItem)

  const bySyncDesc = (a: SharepointChangedItem, b: SharepointChangedItem) =>
    (b.syncedAt ?? '').localeCompare(a.syncedAt ?? '')
  // Une PREMIÈRE migration a des dizaines de milliers de « créés » : on plafonne
  // la réponse (les compteurs restent exacts). Une passe delta, elle, tient
  // largement sous la limite — c'est le cas d'usage visé.
  const CAP = 500
  return c.json<SharepointMigrationChangesResponse>({
    runStartedAt: runStart?.toISOString() ?? null,
    createdCount: created.length,
    updatedCount: updated.length,
    truncated: created.length > CAP || updated.length > CAP,
    created: created.sort(bySyncDesc).slice(0, CAP),
    updated: updated.sort(bySyncDesc).slice(0, CAP),
  })
})
