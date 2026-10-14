import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type {
  DeviceEntraObject,
  DeviceMigrationListResponse,
  DeviceMigrationRecord,
  DeviceMigrationState,
  UpdateDeviceMigrationRequest,
} from '@dsi-app/shared'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { db } from '../../db/index'
import { agencies } from '../accounts/schema'
import { deviceMigrations, type DeviceMigrationRow } from './schema'
import { getLastSyncAt, getSyncState, startInventorySync } from './inventoryService'

export const deviceMigrationRouter = new Hono<{ Variables: RbacVariables }>()
deviceMigrationRouter.use('*', authMiddleware, loadUserRole)

const STALE_DAYS = 90

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null
}

function parseEntraObjects(raw: string | null): DeviceEntraObject[] {
  if (!raw) return []
  try {
    return JSON.parse(raw) as DeviceEntraObject[]
  } catch {
    return []
  }
}

function toRecord(r: DeviceMigrationRow, lastSyncAt: Date | null, regionByAgency: Map<string, string>): DeviceMigrationRecord {
  const lastActivity = [r.onelaEntraLastSignIn, r.onelaIntuneLastSync].reduce<Date | null>(
    (max, v) => (v && (!max || v > max) ? v : max),
    null,
  )
  // Une synchro peut durer quelques minutes : lastSeenAt = début de la synchro où le poste a été vu
  const seenInLastSync = !lastSyncAt || r.lastSeenAt.getTime() >= lastSyncAt.getTime()
  let state: DeviceMigrationState
  if (r.ouihelpIntuneId || r.ouihelpAutopilotId) state = 'migrated'
  else if (r.excluded) state = 'excluded'
  else if (!seenInLastSync) state = 'gone'
  else if (!lastActivity || Date.now() - lastActivity.getTime() > STALE_DAYS * 86_400_000) state = 'stale'
  else state = 'to_migrate'

  return {
    id: r.id,
    deviceKey: r.deviceKey,
    displayName: r.displayName,
    serialNumber: r.serialNumber,
    manufacturer: r.manufacturer,
    model: r.model,
    osVersion: r.osVersion,
    joinType: r.joinType,
    state,
    lastActivityAt: iso(lastActivity),
    onelaEntraDeviceId: r.onelaEntraDeviceId,
    onelaEntraObjects: parseEntraObjects(r.onelaEntraObjects),
    onelaIntuneId: r.onelaIntuneId,
    onelaIntuneLastSync: iso(r.onelaIntuneLastSync),
    onelaManagementAgent: r.onelaManagementAgent,
    onelaAutopilotId: r.onelaAutopilotId,
    onelaAutopilotGroupTag: r.onelaAutopilotGroupTag,
    onelaUserUpn: r.onelaUserUpn,
    onelaUserName: r.onelaUserName,
    onelaOfficeLocation: r.onelaOfficeLocation,
    onelaDepartment: r.onelaDepartment,
    region: r.onelaOfficeLocation ? regionByAgency.get(r.onelaOfficeLocation.trim().toLowerCase()) ?? null : null,
    isEncrypted: r.isEncrypted == null ? null : r.isEncrypted === 1,
    freeStorageGb: r.freeStorageGb,
    totalStorageGb: r.totalStorageGb,
    bitlockerKeysOnela: r.bitlockerKeysOnela,
    ouihelpIntuneId: r.ouihelpIntuneId,
    ouihelpEntraDeviceId: r.ouihelpEntraDeviceId,
    ouihelpAutopilotId: r.ouihelpAutopilotId,
    ouihelpLastSync: iso(r.ouihelpLastSync),
    ouihelpUserUpn: r.ouihelpUserUpn,
    excluded: r.excluded === 1,
    excludeReason: r.excludeReason,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  }
}

// ── Inventaire complet (quelques centaines de postes : filtrage côté front) ──
deviceMigrationRouter.get('/devices', requirePermission('migration:read'), async (c) => {
  const [rows, lastSyncAt, agencyRows] = await Promise.all([
    db.select().from(deviceMigrations),
    getLastSyncAt(),
    db.select({ name: agencies.name, region: agencies.region }).from(agencies),
  ])
  const regionByAgency = new Map(agencyRows.map((a) => [a.name.trim().toLowerCase(), a.region]))
  const devices = rows
    .map((r) => toRecord(r, lastSyncAt, regionByAgency))
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
  const body: DeviceMigrationListResponse = { devices, sync: getSyncState(), lastSyncAt: iso(lastSyncAt) }
  return c.json(body)
})

deviceMigrationRouter.get('/sync', requirePermission('migration:read'), async (c) => {
  return c.json({ sync: getSyncState(), lastSyncAt: iso(await getLastSyncAt()) })
})

deviceMigrationRouter.post('/sync', requirePermission('migration:write'), async (c) => {
  const started = startInventorySync()
  if (!started) return c.json({ error: 'Conflict', message: 'Une synchronisation est déjà en cours' }, 409)
  return c.json({ started: true }, 202)
})

// ── Exclusion manuelle (PC rebut, prêt, poste partagé hors périmètre…) ──
deviceMigrationRouter.patch('/devices/:id', requirePermission('migration:write'), async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as UpdateDeviceMigrationRequest | null
  if (!body || typeof body.excluded !== 'boolean') {
    return c.json({ error: 'Bad Request', message: 'Champ « excluded » (booléen) requis' }, 400)
  }
  const reason = body.excluded ? (body.excludeReason ?? '').trim().slice(0, 255) || null : null
  const [row] = await db.select({ id: deviceMigrations.id }).from(deviceMigrations).where(eq(deviceMigrations.id, id))
  if (!row) return c.json({ error: 'Not Found', message: 'Poste introuvable' }, 404)
  await db
    .update(deviceMigrations)
    .set({ excluded: body.excluded ? 1 : 0, excludeReason: reason })
    .where(eq(deviceMigrations.id, id))
  return c.json({ ok: true })
})
