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
} from '@dsi-app/shared'

export const sharepointMigrationRouter = new Hono<{ Variables: RbacVariables }>()
sharepointMigrationRouter.use('*', authMiddleware, loadUserRole)

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
    migrateVersions: m.migrateVersions,
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
sharepointMigrationRouter.get('/history', requirePermission('migration:read'), async (c) => {
  const rows = await db
    .select()
    .from(sharepointMigrations)
    .orderBy(desc(sharepointMigrations.createdAt))
  return c.json<SharepointMigrationHistoryResponse>({ migrations: rows.map(toRecord) })
})

// ── Création d'une migration ──────────────────────────────────────────────────
sharepointMigrationRouter.post('/', requirePermission('migration:write'), async (c) => {
  const body = await c.req.json<CreateSharepointMigrationRequest>()
  if (!body.siteId || !body.driveId || !body.gdSharedDriveId?.trim()) {
    return c.json({ error: 'Champs requis manquants (siteId, driveId, gdSharedDriveId)' }, 400)
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
    rootItemId: null,
    rootPath: displayPath,
    selectedRoots: roots.length > 0 ? JSON.stringify(roots) : null,
    gdSharedDriveId: body.gdSharedDriveId,
    gdSharedDriveName: body.gdSharedDriveName.trim(),
    migrateVersions: body.migrateVersions ?? true,
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
