import { Hono } from 'hono'
import { desc, eq, inArray } from 'drizzle-orm'
import type {
  DeviceAgentReport,
  DeviceAgentSummary,
  DeviceEntraObject,
  DeviceLogon,
  DeviceMigrationListResponse,
  DeviceMigrationRecord,
  DeviceMigrationState,
  UpdateDeviceMigrationRequest,
  MigrationPackageResponse,
  MigrationStatus,
  ScheduleMigrationRequest,
  UpdateTargetNameRequest,
  MigrationProfileMapping,
  MigrationProfilesResponse,
  DeviceAppCatalogResponse,
  UpdateAppRuleRequest,
} from '@dsi-app/shared'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { db } from '../../db/index'
import { agencies } from '../accounts/schema'
import { cachedUsers } from '../inventory/schema'
import { randomUUID, createHash } from 'crypto'
import {
  deviceAgents,
  deviceAppRules,
  deviceMigrationPackages,
  deviceMigrations,
  type DeviceAgentRow,
  type DeviceMigrationRow,
} from './schema'
import { resolveProfileMap } from './profileMapping'
import { buildAppCatalog } from './appCatalog'
import { autoTargetName, invalidComputerName, type AgencyCodes } from './naming'
import {
  ACTIVE_STATUSES,
  BREAKGLASS_USER,
  CANCELLABLE_STATUSES,
  generateBreakglassPassword,
  recordStep,
  toMigrationRun,
} from './migrationService'
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

interface AgencyRef extends AgencyCodes {
  byName: Map<string, { name: string; region: string }>
  byTrigramme: Map<string, { name: string; region: string }>
}

interface TargetNameInfo {
  name: string | null
  auto: boolean
  conflict: string | null
}

/**
 * Nom chez Ouihelp de chaque poste (saisi ou calculé) et détection des doublons. Les postes
 * exclus ne comptent pas ; un poste déjà basculé garde son nom (il est réellement pris).
 */
function computeTargetNames(
  rows: DeviceMigrationRow[],
  codes: AgencyCodes
): Map<string, TargetNameInfo> {
  const out = new Map<string, TargetNameInfo>()
  const owners = new Map<string, DeviceMigrationRow[]>()
  for (const r of rows) {
    const name = r.targetName ?? autoTargetName(r, codes)
    out.set(r.id, { name, auto: !r.targetName, conflict: null })
    if (name && !r.excluded) owners.set(name, [...(owners.get(name) ?? []), r])
  }
  for (const list of owners.values()) {
    if (list.length < 2) continue
    for (const r of list) {
      const other = list.find((o) => o.id !== r.id)!
      out.get(r.id)!.conflict = other.displayName ?? other.serialNumber ?? other.id
    }
  }
  return out
}

async function loadAgencyRef(): Promise<AgencyRef> {
  const agencyRows = await db
    .select({ name: agencies.name, trigramme: agencies.trigramme, region: agencies.region })
    .from(agencies)
  return {
    byName: new Map(agencyRows.map((a) => [a.name.trim().toLowerCase(), a])),
    byTrigramme: new Map(agencyRows.map((a) => [a.trigramme.trim().toUpperCase(), a])),
    trigrammeByName: new Map(
      agencyRows.map((a) => [a.name.trim().toLowerCase(), a.trigramme.trim().toUpperCase()])
    ),
  }
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
  nameByUpn: Map<string, string>,
  target: TargetNameInfo | undefined
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
  if (
    r.ouihelpIntuneId ||
    r.ouihelpAutopilotId ||
    agent?.joinedToOuihelp ||
    r.migrationStatus === 'done'
  )
    state = 'migrated'
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
    migration: toMigrationRun(r),
    targetName: target?.name ?? null,
    targetNameAuto: target?.auto ?? true,
    targetNameConflict: target?.conflict ?? null,
  }
}

// ── Inventaire complet (quelques centaines de postes : filtrage côté front) ──
deviceMigrationRouter.get('/devices', requirePermission('migration:read'), async (c) => {
  const [rows, lastSyncAt, agencyRef, agentRows, onelaUsers] = await Promise.all([
    db.select().from(deviceMigrations),
    getLastSyncAt(),
    loadAgencyRef(),
    db.select().from(deviceAgents),
    // Noms des comptes vus par l'agent (UPN seul) : cache utilisateurs du module inventaire
    db
      .select({ upn: cachedUsers.upn, displayName: cachedUsers.displayName })
      .from(cachedUsers)
      .where(eq(cachedUsers.source, 'onela')),
  ])
  const nameByUpn = new Map<string, string>()
  for (const u of onelaUsers) if (u.displayName) nameByUpn.set(u.upn.toLowerCase(), u.displayName)
  const targetNames = computeTargetNames(rows, agencyRef)
  // Plusieurs agents pour un poste (réinstallation de Windows) : le plus récent gagne
  const agentByDevice = new Map<string, DeviceAgentRow>()
  for (const a of agentRows) {
    if (!a.deviceMigrationId) continue
    const prev = agentByDevice.get(a.deviceMigrationId)
    if (!prev || a.lastCheckinAt > prev.lastCheckinAt) agentByDevice.set(a.deviceMigrationId, a)
  }
  const devices = rows
    .map((r) =>
      toRecord(r, lastSyncAt, agencyRef, agentByDevice.get(r.id), nameByUpn, targetNames.get(r.id))
    )
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

// ── Bascule (lot 3) ──────────────────────────────────────────────────────────

const MAX_PACKAGE_BYTES = 10 * 1024 * 1024

deviceMigrationRouter.get('/package', requirePermission('migration:read'), async (c) => {
  const [p] = await db
    .select()
    .from(deviceMigrationPackages)
    .where(eq(deviceMigrationPackages.active, 1))
    .orderBy(desc(deviceMigrationPackages.uploadedAt))
    .limit(1)
  const body: MigrationPackageResponse = {
    package: p
      ? {
          id: p.id,
          fileName: p.fileName,
          sizeBytes: p.sizeBytes,
          sha256: p.sha256,
          tokenExpiresAt: iso(p.tokenExpiresAt),
          uploadedBy: p.uploadedBy,
          uploadedAt: p.uploadedAt.toISOString(),
        }
      : null,
  }
  return c.json(body)
})

/** Téléversement du PPKG Ouihelp (multipart : file + tokenExpiresAt optionnel). Remplace l'actif. */
deviceMigrationRouter.post('/package', requirePermission('migration:write'), async (c) => {
  const form = await c.req.parseBody()
  const file = form['file']
  if (!(file instanceof File))
    return c.json({ error: 'Bad Request', message: 'Fichier « file » requis' }, 400)
  if (!file.name.toLowerCase().endsWith('.ppkg')) {
    return c.json({ error: 'Bad Request', message: 'Fichier .ppkg attendu' }, 400)
  }
  if (file.size === 0 || file.size > MAX_PACKAGE_BYTES) {
    return c.json({ error: 'Bad Request', message: 'Taille invalide (10 Mo maximum)' }, 400)
  }
  const bytes = Buffer.from(await file.arrayBuffer())
  const expiresRaw = typeof form['tokenExpiresAt'] === 'string' ? form['tokenExpiresAt'] : ''
  const expires = expiresRaw ? new Date(expiresRaw) : null
  const id = randomUUID()
  await db.update(deviceMigrationPackages).set({ active: 0 })
  await db.insert(deviceMigrationPackages).values({
    id,
    fileName: file.name.slice(0, 255),
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content: bytes.toString('base64'),
    tokenExpiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
    uploadedBy: c.get('dbUser').email,
    active: 1,
  })
  return c.json({ ok: true, id })
})

async function loadDevice(id: string): Promise<DeviceMigrationRow | undefined> {
  const [row] = await db.select().from(deviceMigrations).where(eq(deviceMigrations.id, id))
  return row
}

/** Dernier agent du poste (le plus récent s'il y en a plusieurs) et son rapport. */
async function latestAgent(
  id: string
): Promise<{ agent: DeviceAgentRow; report: DeviceAgentReport | null } | null> {
  const agents = await db.select().from(deviceAgents).where(eq(deviceAgents.deviceMigrationId, id))
  const agent = agents.sort((a, b) => b.lastCheckinAt.getTime() - a.lastCheckinAt.getTime())[0]
  if (!agent) return null
  let report: DeviceAgentReport | null = null
  try {
    report = agent.report ? (JSON.parse(agent.report) as DeviceAgentReport) : null
  } catch {
    report = null
  }
  return { agent, report }
}

function parseTargets(raw: unknown): Record<string, string | null> | null {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string | null> = {}
  for (const [sid, upn] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^S-1-[\d-]+$/.test(sid)) return null
    if (upn === null) out[sid] = null
    else if (typeof upn === 'string' && /^[^@\s]+@[^@\s]+$/.test(upn.trim())) out[sid] = upn.trim()
    else return null
  }
  return out
}

/** Aperçu des profils transférés (bascule en place), avec la saisie DSI éventuelle. */
deviceMigrationRouter.post(
  '/devices/:id/migration/profiles',
  requirePermission('migration:read'),
  async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { profileTargets?: unknown }
    const targets = parseTargets(body.profileTargets)
    if (!targets)
      return c.json({ error: 'Bad Request', message: 'profileTargets : SID → adresse ou null' }, 400)
    const a = await latestAgent(id)
    if (!a?.report)
      return c.json({ error: 'Not Found', message: 'Aucun rapport d’agent pour ce poste' }, 404)
    const body2: MigrationProfilesResponse = {
      profiles: await resolveProfileMap(a.report.profiles, targets),
    }
    return c.json(body2)
  }
)

/**
 * Programme une bascule. Garde-fous communs : PPKG actif, agent qui répond, n° de série connu,
 * nom Ouihelp valide et unique, aucune bascule en cours.
 *  - inplace : PC Entra Joined ou hybride ; chaque profil retenu doit avoir son compte Ouihelp.
 *  - reset   : PC Entra Joined, WinRE activé.
 */
deviceMigrationRouter.post(
  '/devices/:id/migration',
  requirePermission('migration:write'),
  async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as ScheduleMigrationRequest | null
    const mode = body?.mode
    if (mode !== 'reset' && mode !== 'inplace')
      return c.json({ error: 'Bad Request', message: 'Mode « inplace » ou « reset » attendu' }, 400)
    const targets = parseTargets(body?.profileTargets)
    if (!targets)
      return c.json({ error: 'Bad Request', message: 'profileTargets : SID → adresse ou null' }, 400)
    const d = await loadDevice(id)
    if (!d) return c.json({ error: 'Not Found', message: 'Poste introuvable' }, 404)

    const refuse = (message: string) => c.json({ error: 'Conflict', message }, 409)
    if (d.migrationStatus && ACTIVE_STATUSES.includes(d.migrationStatus as MigrationStatus)) {
      return refuse('Une bascule est déjà en cours pour ce poste')
    }
    if (mode === 'reset' && d.joinType !== 'entra_joined')
      return refuse('Réinstallation propre limitée aux PC Entra Joined')
    if (mode === 'inplace' && d.joinType !== 'entra_joined' && d.joinType !== 'hybrid')
      return refuse('Bascule en place limitée aux PC Entra Joined ou hybrides')
    if (!d.serialNumber)
      return refuse('N° de série inconnu : impossible de vérifier Autopilot ONELA')
    const [pkg] = await db
      .select({
        id: deviceMigrationPackages.id,
        tokenExpiresAt: deviceMigrationPackages.tokenExpiresAt,
      })
      .from(deviceMigrationPackages)
      .where(eq(deviceMigrationPackages.active, 1))
      .limit(1)
    if (!pkg) return refuse('Aucun PPKG Ouihelp téléversé')
    // Le jeton de jonction en bloc du PPKG a une durée de vie limitée (180 jours au plus).
    // Expiré, le poste quitte ONELA puis ne rejoint jamais Ouihelp : on refuse avant d'y toucher.
    if (pkg.tokenExpiresAt && pkg.tokenExpiresAt.getTime() < Date.now()) {
      return refuse(
        `Jeton du PPKG expiré le ${pkg.tokenExpiresAt.toLocaleDateString('fr-FR')} : téléverser un nouveau PPKG Ouihelp`
      )
    }
    const a = await latestAgent(id)
    if (!a || Date.now() - a.agent.lastCheckinAt.getTime() > 24 * 3600_000) {
      return refuse('Agent absent ou silencieux depuis plus de 24 h')
    }
    if (mode === 'reset' && a.report?.winreEnabled === false)
      return refuse('WinRE désactivé : réinitialisation impossible')

    let profileMap: MigrationProfileMapping[] = []
    if (mode === 'inplace') {
      if (!a.report) return refuse('Aucun rapport d’agent : profils inconnus')
      if (a.report.agentVersion.localeCompare('1.2.0', undefined, { numeric: true }) < 0)
        return refuse(`Agent ${a.report.agentVersion} trop ancien : la bascule en place demande l’agent 1.2.0`)
      profileMap = await resolveProfileMap(a.report.profiles, targets)
      const broken = profileMap.find((m) => m.error)
      if (broken)
        return refuse(`Profil ${broken.oldAccount ?? broken.oldSid} : ${broken.error}`)
      if (!profileMap.some((m) => m.newSid))
        return refuse('Aucun profil à transférer : choisir le compte Ouihelp d’au moins un profil')
    }

    const allRows = await db.select().from(deviceMigrations)
    const target = computeTargetNames(allRows, await loadAgencyRef()).get(id)
    if (!target?.name)
      return refuse('Nom Ouihelp impossible à déduire : saisir le nom du poste à la main')
    const invalid = invalidComputerName(target.name)
    if (invalid) return refuse(`Nom Ouihelp invalide (${target.name}) : ${invalid}`)
    if (target.conflict) return refuse(`Nom ${target.name} déjà attribué à ${target.conflict}`)

    const promptUser = body!.promptUser !== false
    const by = c.get('dbUser').email
    const now = new Date()
    const transferred = profileMap
      .filter((m) => m.newUpn)
      .map((m) => `${m.oldUpn ?? m.oldAccount} → ${m.newUpn}`)
      .join(', ')
    const what =
      mode === 'inplace'
        ? `Bascule en place programmée par ${by} — profils : ${transferred}`
        : `Réinstallation propre programmée par ${by}`
    await db
      .update(deviceMigrations)
      .set({
        // Nom figé à la programmation : il ne bouge plus si l'inventaire change pendant la bascule
        targetName: target.name,
        migrationStatus: 'scheduled',
        migrationMode: mode,
        migrationRequestedBy: by,
        migrationRequestedAt: now,
        migrationUpdatedAt: now,
        migrationError: null,
        migrationSteps: JSON.stringify([
          {
            at: now.toISOString(),
            step: 'programmation',
            status: 'info',
            source: 'dsi',
            message: `${what} — futur nom ${target.name}${promptUser ? ' — avec avertissement utilisateur' : ' — hors session'}`,
          },
        ]),
        migrationPromptUser: promptUser ? 1 : 0,
        migrationSnoozes: 0,
        migrationProfileMap: mode === 'inplace' ? JSON.stringify(profileMap) : null,
        breakglassPassword: generateBreakglassPassword(),
        migrationTokenHash: null,
        hardwareHash: null,
      })
      .where(eq(deviceMigrations.id, id))
    return c.json({ ok: true })
  }
)

/**
 * Bascule bloquée sur le poste (réinitialisation ratée, PC injoignable) : la DSI la marque en
 * échec pour pouvoir en reprogrammer une. Ne touche ni au poste ni aux tenants.
 */
deviceMigrationRouter.post(
  '/devices/:id/migration/abandon',
  requirePermission('migration:write'),
  async (c) => {
    const id = c.req.param('id')
    const d = await loadDevice(id)
    if (!d) return c.json({ error: 'Not Found', message: 'Poste introuvable' }, 404)
    if (!['cleanup', 'ready', 'resetting', 'joining'].includes(d.migrationStatus ?? '')) {
      return c.json({ error: 'Conflict', message: 'Rien à abandonner à ce stade' }, 409)
    }
    const msg = `Bascule abandonnée par ${c.get('dbUser').email} (poste à reprendre à la main)`
    await recordStep(
      id,
      { step: 'abandon', status: 'error', source: 'dsi', message: msg },
      { status: 'failed', error: msg }
    )
    return c.json({ ok: true })
  }
)

// ── Catalogue des applications (bascule en place) ──

deviceMigrationRouter.get('/apps', requirePermission('migration:read'), async (c) => {
  const body: DeviceAppCatalogResponse = { apps: await buildAppCatalog() }
  return c.json(body)
})

deviceMigrationRouter.put('/apps/rules', requirePermission('migration:write'), async (c) => {
  const body = (await c.req.json().catch(() => null)) as UpdateAppRuleRequest | null
  if (
    !body ||
    !Array.isArray(body.keys) ||
    body.keys.length === 0 ||
    body.keys.length > 500 ||
    !body.keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 255) ||
    (body.keep !== null && typeof body.keep !== 'boolean')
  ) {
    return c.json({ error: 'Bad Request', message: 'keys (1 à 500) et keep (booléen ou null) requis' }, 400)
  }
  if (body.keep === null) {
    await db.delete(deviceAppRules).where(inArray(deviceAppRules.appKey, body.keys))
  } else {
    const by = c.get('dbUser').email
    const now = new Date()
    for (const key of body.keys) {
      await db
        .insert(deviceAppRules)
        .values({ appKey: key, keep: body.keep ? 1 : 0, updatedBy: by, updatedAt: now })
        .onDuplicateKeyUpdate({ set: { keep: body.keep ? 1 : 0, updatedBy: by, updatedAt: now } })
    }
  }
  return c.json({ ok: true })
})

deviceMigrationRouter.post(
  '/devices/:id/migration/cancel',
  requirePermission('migration:write'),
  async (c) => {
    const id = c.req.param('id')
    const d = await loadDevice(id)
    if (!d) return c.json({ error: 'Not Found', message: 'Poste introuvable' }, 404)
    if (!CANCELLABLE_STATUSES.includes(d.migrationStatus as MigrationStatus)) {
      return c.json(
        {
          error: 'Conflict',
          message:
            'Annulation impossible à ce stade (Autopilot ONELA déjà modifié ou réinitialisation lancée)',
        },
        409
      )
    }
    await recordStep(
      id,
      {
        step: 'annulation',
        status: 'info',
        source: 'dsi',
        message: `Annulée par ${c.get('dbUser').email} — l’agent retirera ses fichiers au prochain passage`,
      },
      { status: 'cancelled' }
    )
    return c.json({ ok: true })
  }
)

/** Mot de passe du compte local de secours ; chaque consultation est tracée dans le journal. */
deviceMigrationRouter.get(
  '/devices/:id/migration/breakglass',
  requirePermission('migration:write'),
  async (c) => {
    const id = c.req.param('id')
    const d = await loadDevice(id)
    if (!d?.breakglassPassword)
      return c.json({ error: 'Not Found', message: 'Aucun mot de passe de secours' }, 404)
    await recordStep(id, {
      step: 'secours',
      status: 'info',
      source: 'dsi',
      message: `Mot de passe ${BREAKGLASS_USER} consulté par ${c.get('dbUser').email}`,
    })
    return c.json({ user: BREAKGLASS_USER, password: d.breakglassPassword })
  }
)

/** Nom du poste chez Ouihelp : saisie manuelle, ou null pour revenir au nom calculé. */
deviceMigrationRouter.patch(
  '/devices/:id/target-name',
  requirePermission('migration:write'),
  async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as UpdateTargetNameRequest | null
    if (!body || (body.name !== null && typeof body.name !== 'string')) {
      return c.json({ error: 'Bad Request', message: 'Champ « name » (texte ou null) requis' }, 400)
    }
    const d = await loadDevice(id)
    if (!d) return c.json({ error: 'Not Found', message: 'Poste introuvable' }, 404)
    if (d.migrationStatus && ACTIVE_STATUSES.includes(d.migrationStatus as MigrationStatus)) {
      return c.json({ error: 'Conflict', message: 'Bascule en cours : le nom est figé' }, 409)
    }
    const name = body.name === null ? null : body.name.trim().toUpperCase()
    if (name !== null) {
      const invalid = invalidComputerName(name)
      if (invalid) return c.json({ error: 'Bad Request', message: invalid }, 400)
      const codes = await loadAgencyRef()
      const taken = (await db.select().from(deviceMigrations)).find(
        (r) => r.id !== id && !r.excluded && (r.targetName ?? autoTargetName(r, codes)) === name
      )
      if (taken) {
        return c.json(
          {
            error: 'Conflict',
            message: `Nom déjà attribué à ${taken.displayName ?? taken.serialNumber}`,
          },
          409
        )
      }
    }
    await db.update(deviceMigrations).set({ targetName: name }).where(eq(deviceMigrations.id, id))
    return c.json({ ok: true })
  }
)
