import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type {
  DeviceAgentReport,
  DeviceAgentSummary,
  DeviceEntraObject,
  DeviceLogon,
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
import { cachedUsers } from '../inventory/schema'
import {
  deviceAgents,
  deviceMigrations,
  type DeviceAgentRow,
  type DeviceMigrationRow,
} from './schema'
import {
  getLastSyncAt,
  getSyncState,
  startInventorySync,
  type StoredLogon,
} from './inventoryService'

export const deviceMigrationRouter = new Hono<{ Variables: RbacVariables }>()
deviceMigrationRouter.use('*', authMiddleware, loadUserRole)

const STALE_DAYS = 90
const AGENT_SILENT_MS = 24 * 3600_000
// Un PC vu par l'agent depuis moins de 7 jours est présent, même absent des API cloud (AD seul)
const AGENT_PRESENT_MS = 7 * 86_400_000

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

interface AgencyRef {
  byName: Map<string, { name: string; region: string }>
  byTrigramme: Map<string, { name: string; region: string }>
}

/**
 * Les PC ONELA sont nommés `TRIGRAMME-AAAAMMJJNN` (ex. AIX-2023101302) : le préfixe
 * donne l'agence même sans utilisateur principal. À défaut, agence de l'utilisateur.
 */
function resolveAgency(
  r: DeviceMigrationRow,
  ref: AgencyRef
): { agency: string | null; agencyFromName: boolean; region: string | null } {
  const prefix = r.displayName?.match(/^([A-Za-z]{2,5})-/)?.[1]?.toUpperCase()
  const fromName = prefix ? ref.byTrigramme.get(prefix) : undefined
  if (fromName) return { agency: fromName.name, agencyFromName: true, region: fromName.region }
  const office = r.onelaOfficeLocation?.trim() || null
  const fromUser = office ? ref.byName.get(office.toLowerCase()) : undefined
  return {
    agency: fromUser?.name ?? office,
    agencyFromName: false,
    region: fromUser?.region ?? null,
  }
}

function toAgentSummary(a: DeviceAgentRow | undefined): DeviceAgentSummary | null {
  if (!a?.report) return null
  let report: DeviceAgentReport
  try {
    report = JSON.parse(a.report) as DeviceAgentReport
  } catch {
    return null
  }
  const ouihelp = process.env['AZURE_TENANT_ID']?.toLowerCase()
  return {
    id: a.id,
    firstCheckinAt: a.firstCheckinAt.toISOString(),
    lastCheckinAt: a.lastCheckinAt.toISOString(),
    silent: Date.now() - a.lastCheckinAt.getTime() > AGENT_SILENT_MS,
    joinedToOuihelp: !!ouihelp && report.dsreg.azureAdJoined && report.dsreg.tenantId === ouihelp,
    report,
  }
}

// Comptes techniques (support, admin) : ils se connectent pour dépanner, ce ne sont pas
// les utilisateurs du poste. Testé sur la partie compte (après « \ », avant « @ »).
const TECHNICAL_ACCOUNT = /^(admin|adm[._-]|administrat|support)/i

function isTechnical(account: string): boolean {
  const local = account.split('\\').pop()!.split('@')[0]!
  return TECHNICAL_ACCOUNT.test(local)
}

/**
 * Connexions récentes du poste, toutes sources : Intune (usersLoggedOn) et agent (date de
 * chargement de chaque profil). Dédoublonnées par compte, la plus récente gagne.
 */
function buildLogons(
  r: DeviceMigrationRow,
  agent: DeviceAgentSummary | null,
  nameByUpn: Map<string, string>
): DeviceLogon[] {
  const all: DeviceLogon[] = []
  if (r.intuneLogons) {
    try {
      for (const l of JSON.parse(r.intuneLogons) as StoredLogon[]) {
        all.push({ account: l.upn, name: l.name, at: l.at, source: 'intune' })
      }
    } catch {
      // JSON illisible : on ignore la source
    }
  }
  for (const p of agent?.report.profiles ?? []) {
    if (p.kind === 'local' || !p.lastLogonTime) continue
    const account = p.upn?.toLowerCase() || p.account
    if (!account) continue
    all.push({
      account,
      name: nameByUpn.get(account.toLowerCase()) ?? null,
      at: p.lastLogonTime,
      source: 'agent',
    })
  }
  const byAccount = new Map<string, DeviceLogon>()
  for (const l of all) {
    if (isTechnical(l.account)) continue
    const key = l.account.toLowerCase()
    const prev = byAccount.get(key)
    if (!prev || (l.at ?? '') > (prev.at ?? ''))
      byAccount.set(key, { ...l, name: l.name ?? prev?.name ?? null })
  }
  return [...byAccount.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

function toRecord(
  r: DeviceMigrationRow,
  lastSyncAt: Date | null,
  agencyRef: AgencyRef,
  agentRow: DeviceAgentRow | undefined,
  nameByUpn: Map<string, string>
): DeviceMigrationRecord {
  const agent = toAgentSummary(agentRow)
  const recentLogons = buildLogons(r, agent, nameByUpn)
  const lastActivity = [r.onelaEntraLastSignIn, r.onelaIntuneLastSync].reduce<Date | null>(
    (max, v) => (v && (!max || v > max) ? v : max),
    null
  )
  // Une synchro peut durer quelques minutes : lastSeenAt = début de la synchro où le poste a été vu
  const seenInLastSync =
    !lastSyncAt ||
    r.lastSeenAt.getTime() >= lastSyncAt.getTime() ||
    (!!agentRow && Date.now() - agentRow.lastCheckinAt.getTime() < AGENT_PRESENT_MS)
  let state: DeviceMigrationState
  if (r.ouihelpIntuneId || r.ouihelpAutopilotId || agent?.joinedToOuihelp) state = 'migrated'
  else if (r.excluded) state = 'excluded'
  else if (!seenInLastSync) state = 'gone'
  // Un agent qui répond prouve que le PC sert encore, même sans activité Entra / Intune récente
  else if (
    (!agent || agent.silent) &&
    (!lastActivity || Date.now() - lastActivity.getTime() > STALE_DAYS * 86_400_000)
  )
    state = 'stale'
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
    lastUser: recentLogons[0] ?? null,
    recentLogons,
    onelaOfficeLocation: r.onelaOfficeLocation,
    onelaDepartment: r.onelaDepartment,
    ...resolveAgency(r, agencyRef),
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
    agent,
  }
}

// ── Inventaire complet (quelques centaines de postes : filtrage côté front) ──
deviceMigrationRouter.get('/devices', requirePermission('migration:read'), async (c) => {
  const [rows, lastSyncAt, agencyRows, agentRows, onelaUsers] = await Promise.all([
    db.select().from(deviceMigrations),
    getLastSyncAt(),
    db
      .select({ name: agencies.name, trigramme: agencies.trigramme, region: agencies.region })
      .from(agencies),
    db.select().from(deviceAgents),
    // Noms des comptes vus par l'agent (UPN seul) : cache utilisateurs du module inventaire
    db
      .select({ upn: cachedUsers.upn, displayName: cachedUsers.displayName })
      .from(cachedUsers)
      .where(eq(cachedUsers.source, 'onela')),
  ])
  const nameByUpn = new Map<string, string>()
  for (const u of onelaUsers) if (u.displayName) nameByUpn.set(u.upn.toLowerCase(), u.displayName)
  const agencyRef: AgencyRef = {
    byName: new Map(agencyRows.map((a) => [a.name.trim().toLowerCase(), a])),
    byTrigramme: new Map(agencyRows.map((a) => [a.trigramme.trim().toUpperCase(), a])),
  }
  // Plusieurs agents pour un poste (réinstallation de Windows) : le plus récent gagne
  const agentByDevice = new Map<string, DeviceAgentRow>()
  for (const a of agentRows) {
    if (!a.deviceMigrationId) continue
    const prev = agentByDevice.get(a.deviceMigrationId)
    if (!prev || a.lastCheckinAt > prev.lastCheckinAt) agentByDevice.set(a.deviceMigrationId, a)
  }
  const devices = rows
    .map((r) => toRecord(r, lastSyncAt, agencyRef, agentByDevice.get(r.id), nameByUpn))
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
  const body: DeviceMigrationListResponse = {
    devices,
    sync: getSyncState(),
    lastSyncAt: iso(lastSyncAt),
  }
  return c.json(body)
})

deviceMigrationRouter.get('/sync', requirePermission('migration:read'), async (c) => {
  return c.json({ sync: getSyncState(), lastSyncAt: iso(await getLastSyncAt()) })
})

deviceMigrationRouter.post('/sync', requirePermission('migration:write'), async (c) => {
  const started = startInventorySync()
  if (!started)
    return c.json({ error: 'Conflict', message: 'Une synchronisation est déjà en cours' }, 409)
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
  const [row] = await db
    .select({ id: deviceMigrations.id })
    .from(deviceMigrations)
    .where(eq(deviceMigrations.id, id))
  if (!row) return c.json({ error: 'Not Found', message: 'Poste introuvable' }, 404)
  await db
    .update(deviceMigrations)
    .set({ excluded: body.excluded ? 1 : 0, excludeReason: reason })
    .where(eq(deviceMigrations.id, id))
  return c.json({ ok: true })
})

// ── Réinitialisation de l'agent : efface son jeton, il se ré-enrôle au check-in suivant ──
deviceMigrationRouter.post(
  '/devices/:id/agent/reset',
  requirePermission('migration:write'),
  async (c) => {
    const id = c.req.param('id')
    const agents = await db
      .select({ id: deviceAgents.id })
      .from(deviceAgents)
      .where(eq(deviceAgents.deviceMigrationId, id))
    if (!agents.length)
      return c.json({ error: 'Not Found', message: 'Aucun agent rattaché à ce poste' }, 404)
    await db
      .update(deviceAgents)
      .set({ tokenHash: null })
      .where(eq(deviceAgents.deviceMigrationId, id))
    return c.json({ ok: true, reset: agents.length })
  }
)
