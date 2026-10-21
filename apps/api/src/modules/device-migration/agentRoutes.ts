import { Hono } from 'hono'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { desc, eq, sql } from 'drizzle-orm'
import {
  MIGRATION_MAX_SNOOZES,
  MIGRATION_PROMPT_MESSAGE,
  MIGRATION_SNOOZE_MINUTES,
  type DeviceAgentApp,
  type DeviceAgentCheckinResponse,
  type DeviceAgentMigrationOrder,
  type DeviceAgentProfile,
  type DeviceAgentReport,
  type DeviceJoinType,
  type MigrationMode,
  type MigrationStatus,
} from '@dsi-app/shared'
import { db } from '../../db/index'
import {
  deviceAgents,
  deviceMigrationPackages,
  deviceMigrations,
  type DeviceAgentRow,
} from './schema'
import { normSerial } from './inventoryService'
import { appsToRemove, loadAppRules } from './appCatalog'
import { parseProfileMap } from './profileMapping'
import {
  ACTIVE_STATUSES,
  BREAKGLASS_USER,
  cleanupOnelaBeforeReset,
  finalizeAfterJoin,
  generateReportToken,
  recordStep,
  sha256 as hashToken,
} from './migrationService'

/**
 * Endpoint appelé par l'agent DSI des PC ONELA (hors authentification MSAL).
 *
 * Authentification :
 *  - 1er check-in : en-tête `X-Enrollment-Key` = DEVICE_AGENT_ENROLLMENT_KEY (clé commune,
 *    à considérer comme semi-publique : elle est dans le script déployé). Le serveur
 *    renvoie un jeton propre au poste.
 *  - check-ins suivants : `Authorization: Bearer <jeton>`.
 *
 * Lot 2 = remontée d'informations uniquement : la réponse ne contient aucune action.
 */
export const deviceAgentRouter = new Hono()

const MAX_BODY = 512 * 1024
const DEFAULT_CHECKIN_MINUTES = 240

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// ── Assainissement du rapport (entrée non fiable) ────────────────────────────

function str(v: unknown, max = 255): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

function bool(v: unknown): boolean {
  return v === true
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function isoOrNull(v: unknown): string | null {
  const s = str(v, 40)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const PROFILE_KINDS = new Set(['ad', 'entra', 'local', 'unknown'])

export function sanitizeReport(raw: unknown): DeviceAgentReport | null {
  const r = obj(raw)
  const machineGuid = str(r['machineGuid'], 64)
  const hostname = str(r['hostname'])
  if (!machineGuid || !/^[0-9a-f-]{32,40}$/i.test(machineGuid) || !hostname) return null
  const os = obj(r['os'])
  const domain = obj(r['domain'])
  const dsreg = obj(r['dsreg'])
  const mdm = obj(r['mdm'])
  const tpm = obj(r['tpm'])
  const bl = obj(r['bitlocker'])
  const net = obj(r['network'])
  const disk = obj(r['disk'])
  const profiles: DeviceAgentProfile[] = (Array.isArray(r['profiles']) ? r['profiles'] : [])
    .slice(0, 100)
    .map((p) => {
      const o = obj(p)
      const kind = str(o['kind'], 10)
      return {
        sid: str(o['sid'], 100) ?? '?',
        account: str(o['account']),
        upn: str(o['upn'])?.toLowerCase() ?? null,
        lastLogonTime: isoOrNull(o['lastLogonTime']),
        kind: (kind && PROFILE_KINDS.has(kind) ? kind : 'unknown') as DeviceAgentProfile['kind'],
        lastUseTime: isoOrNull(o['lastUseTime']),
        loaded: bool(o['loaded']),
        localDataMb: num(o['localDataMb']),
      }
    })
  const apps: DeviceAgentApp[] = (Array.isArray(r['apps']) ? r['apps'] : [])
    .slice(0, 600)
    .map((a) => {
      const o = obj(a)
      return {
        name: str(o['name']) ?? '',
        version: str(o['version'], 100),
        publisher: str(o['publisher']),
        uninstallable: bool(o['uninstallable']),
      }
    })
    .filter((a) => a.name)
  return {
    agentVersion: str(r['agentVersion'], 20) ?? '?',
    machineGuid: machineGuid.toLowerCase(),
    hostname,
    serialNumber: str(r['serialNumber'], 100),
    manufacturer: str(r['manufacturer']),
    model: str(r['model']),
    os: {
      caption: str(os['caption']),
      version: str(os['version'], 50),
      build: str(os['build'], 50),
      edition: str(os['edition'], 100),
    },
    domain: { partOfDomain: bool(domain['partOfDomain']), name: str(domain['name']) },
    dsreg: {
      azureAdJoined: bool(dsreg['azureAdJoined']),
      domainJoined: bool(dsreg['domainJoined']),
      workplaceJoined: bool(dsreg['workplaceJoined']),
      deviceId: str(dsreg['deviceId'], 36)?.toLowerCase() ?? null,
      tenantId: str(dsreg['tenantId'], 36)?.toLowerCase() ?? null,
      tenantName: str(dsreg['tenantName']),
    },
    mdm: {
      enrolled: bool(mdm['enrolled']),
      upn: str(mdm['upn']),
      gpoAutoEnroll: bool(mdm['gpoAutoEnroll']),
    },
    sccmClient: bool(r['sccmClient']),
    tpm: {
      present: bool(tpm['present']),
      ready: bool(tpm['ready']),
      version: str(tpm['version'], 50),
    },
    secureBoot: boolOrNull(r['secureBoot']),
    winreEnabled: boolOrNull(r['winreEnabled']),
    bitlocker: {
      protectionOn: boolOrNull(bl['protectionOn']),
      hasRecoveryPassword: boolOrNull(bl['hasRecoveryPassword']),
    },
    network: {
      ethernet: bool(net['ethernet']),
      wifi: bool(net['wifi']),
      ssid: str(net['ssid'], 64),
      wifiProfiles: (Array.isArray(net['wifiProfiles']) ? net['wifiProfiles'] : [])
        .map((w) => str(w, 64))
        .filter((w): w is string => !!w)
        .slice(0, 50),
    },
    disk: { freeGb: num(disk['freeGb']), totalGb: num(disk['totalGb']) },
    consoleUser: str(r['consoleUser']),
    lastBoot: isoOrNull(r['lastBoot']),
    profiles,
    profilesMeasuredAt: isoOrNull(r['profilesMeasuredAt']),
    ...(Array.isArray(r['apps']) ? { apps } : {}),
  }
}

// ── Rattachement à un poste de l'inventaire ──────────────────────────────────

function joinTypeFromReport(r: DeviceAgentReport): DeviceJoinType {
  const onela = process.env['ONELA_TENANT_ID']?.toLowerCase()
  const inOnela = r.dsreg.azureAdJoined && (!onela || r.dsreg.tenantId === onela)
  if (inOnela && r.dsreg.domainJoined) return 'hybrid'
  if (inOnela) return 'entra_joined'
  if (r.dsreg.domainJoined || r.domain.partOfDomain)
    return r.dsreg.workplaceJoined ? 'registered' : 'ad_only'
  return r.dsreg.workplaceJoined ? 'registered' : 'unknown'
}

/**
 * Retrouve le poste par n° de série, puis par deviceId Entra ONELA, sinon crée une
 * ligne (cas des PC uniquement AD, invisibles des API cloud). Une ligne créée par
 * l'agent et devenue orpheline (le poste a été retrouvé ailleurs) est supprimée.
 */
async function linkDevice(agent: DeviceAgentRow, r: DeviceAgentReport): Promise<string> {
  const serial = normSerial(r.serialNumber)
  const onela = process.env['ONELA_TENANT_ID']?.toLowerCase()
  const entraId =
    r.dsreg.deviceId && (!onela || r.dsreg.tenantId === onela) ? r.dsreg.deviceId : null

  let target: { id: string } | undefined
  if (serial)
    [target] = await db
      .select({ id: deviceMigrations.id })
      .from(deviceMigrations)
      .where(eq(deviceMigrations.serialNumber, serial))
  if (!target && entraId)
    [target] = await db
      .select({ id: deviceMigrations.id })
      .from(deviceMigrations)
      .where(eq(deviceMigrations.onelaEntraDeviceId, entraId))

  if (agent.deviceMigrationId && agent.deviceMigrationId !== target?.id) {
    const [prev] = await db
      .select()
      .from(deviceMigrations)
      .where(eq(deviceMigrations.id, agent.deviceMigrationId))
    if (prev && !target) return prev.id
    if (prev?.deviceKey.startsWith('agent:'))
      await db.delete(deviceMigrations).where(eq(deviceMigrations.id, prev.id))
  }
  if (target) return target.id

  const id = randomUUID()
  const now = new Date()
  await db.insert(deviceMigrations).values({
    id,
    deviceKey: serial ? `sn:${serial}` : `agent:${r.machineGuid}`,
    displayName: r.hostname,
    serialNumber: serial,
    manufacturer: r.manufacturer,
    model: r.model,
    osVersion: r.os.version,
    joinType: joinTypeFromReport(r),
    onelaEntraDeviceId: entraId,
    firstSeenAt: now,
    lastSeenAt: now,
  })
  return id
}

// ── Identité de l'agent ───────────────────────────────────────────────────────

/**
 * Identité d'un agent = MachineGuid + n° de série. Le MachineGuid seul ne suffit pas : il
 * est identique sur des PC clonés depuis un master non généralisé (sysprep), et le 2ᵉ PC
 * recevait alors un 409 « déjà enregistré » sans jamais apparaître dans l'inventaire.
 * Stockée dans la colonne machine_guid.
 */
function agentIdentity(r: DeviceAgentReport): string {
  return `${r.machineGuid}|${normSerial(r.serialNumber) ?? '-'}`
}

async function findAgent(r: DeviceAgentReport): Promise<DeviceAgentRow | undefined> {
  const identity = agentIdentity(r)
  const [agent] = await db.select().from(deviceAgents).where(eq(deviceAgents.machineGuid, identity))
  if (agent) return agent
  // Agents enregistrés avant ce correctif (clé = MachineGuid seul) : on reprend la ligne si
  // le n° de série concorde — c'est le même PC — et on la passe sur la nouvelle clé.
  const [legacy] = await db
    .select()
    .from(deviceAgents)
    .where(eq(deviceAgents.machineGuid, r.machineGuid))
  if (legacy && (legacy.serialNumber ?? null) === normSerial(r.serialNumber)) {
    await db
      .update(deviceAgents)
      .set({ machineGuid: identity })
      .where(eq(deviceAgents.id, legacy.id))
    return { ...legacy, machineGuid: identity }
  }
  return undefined
}

// ── Check-in ─────────────────────────────────────────────────────────────────

deviceAgentRouter.post('/checkin', async (c) => {
  const enrollmentKey = process.env['DEVICE_AGENT_ENROLLMENT_KEY']
  if (!enrollmentKey)
    return c.json(
      { error: 'Service Unavailable', message: 'Agent non configuré côté serveur' },
      503
    )

  const body = await c.req.text()
  if (body.length > MAX_BODY) return c.json({ error: 'Payload Too Large' }, 413)
  // Cause précise renvoyée à l'agent (écrite dans son agent.log) : sans elle, un 400 sur un
  // poste est indiagnosticable à distance
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const at = /position (\d+)/.exec(msg)?.[1]
    const around = at ? body.slice(Math.max(0, Number(at) - 60), Number(at) + 60) : ''
    console.warn(`[device-agent] rapport JSON illisible : ${msg} — ${around}`)
    return c.json(
      {
        error: 'Bad Request',
        message: `Rapport JSON illisible : ${msg}${around ? ` — près de « ${around} »` : ''}`,
      },
      400
    )
  }
  const report = sanitizeReport(parsed)
  if (!report) {
    const r = obj(parsed)
    const reason = !str(r['hostname'])
      ? 'hostname absent'
      : `machineGuid invalide (${JSON.stringify(r['machineGuid'] ?? null).slice(0, 80)})`
    console.warn(`[device-agent] rapport refusé : ${reason}`)
    return c.json({ error: 'Bad Request', message: `Rapport refusé : ${reason}` }, 400)
  }

  const agent = await findAgent(report)
  const bearer = c.req
    .header('Authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim()
  let issuedToken: string | undefined

  if (bearer) {
    if (!agent?.tokenHash || !safeEqual(sha256(bearer), agent.tokenHash)) {
      // L'agent efface alors son jeton et se ré-enrôle au passage suivant
      return c.json({ error: 'Unauthorized', message: 'Jeton inconnu ou réinitialisé' }, 401)
    }
  } else {
    const key = c.req.header('X-Enrollment-Key') ?? ''
    if (!safeEqual(key, enrollmentKey)) return c.json({ error: 'Unauthorized' }, 401)
    if (agent?.tokenHash) {
      return c.json(
        {
          error: 'Conflict',
          message: 'Poste déjà enregistré — réinitialiser l’agent dans la DSI App',
        },
        409
      )
    }
    issuedToken = randomBytes(32).toString('base64url')
  }

  const now = new Date()
  const ip =
    (c.req.header('x-forwarded-for') ?? '').split(',')[0]?.trim().replace(/:\d+$/, '') || null
  let row: DeviceAgentRow
  if (agent) {
    row = agent
  } else {
    row = {
      id: randomUUID(),
      machineGuid: agentIdentity(report),
      deviceMigrationId: null,
      tokenHash: null,
      hostname: null,
      serialNumber: null,
      agentVersion: null,
      report: null,
      remoteIp: null,
      firstCheckinAt: now,
      lastCheckinAt: now,
    }
    await db
      .insert(deviceAgents)
      .values({ id: row.id, machineGuid: row.machineGuid, firstCheckinAt: now, lastCheckinAt: now })
  }

  const deviceMigrationId = await linkDevice(row, report)
  await db
    .update(deviceAgents)
    .set({
      deviceMigrationId,
      ...(issuedToken ? { tokenHash: sha256(issuedToken) } : {}),
      hostname: report.hostname,
      serialNumber: normSerial(report.serialNumber),
      agentVersion: report.agentVersion,
      report: JSON.stringify(report),
      remoteIp: ip,
      lastCheckinAt: now,
    })
    .where(eq(deviceAgents.id, row.id))

  const migration = await migrationOrderFor(deviceMigrationId)
  const res: DeviceAgentCheckinResponse = {
    agentId: row.id,
    ...(issuedToken ? { deviceToken: issuedToken } : {}),
    // Bascule en cours : l'agent repasse plus souvent pour enchaîner les étapes
    nextCheckinMinutes:
      migration && migration.status !== 'cancelled'
        ? MIGRATION_CHECKIN_MINUTES
        : DEFAULT_CHECKIN_MINUTES,
    ...(migration ? { migration } : {}),
  }
  return c.json(res)
})

// ── Bascule (lot 3) ──────────────────────────────────────────────────────────

const MIGRATION_CHECKIN_MINUTES = 15
const CLEANUP_STALE_MS = 10 * 60_000
/**
 * Statuts pour lesquels l'agent agit encore. En réinstallation propre, la réinitialisation
 * efface l'agent juste après « ready ». En bascule en place l'agent survit et enchaîne les
 * étapes suivantes (transfert des profils, jonction) : il lui faut l'ordre jusqu'à « joining ».
 */
const AGENT_STATUSES = ['scheduled', 'staging', 'staged', 'cleanup', 'ready', 'cancelled']
const AGENT_INPLACE_STATUSES = [...AGENT_STATUSES, 'resetting', 'joining']

/**
 * Ordre de bascule à remettre à l'agent. Au 1er passage (« scheduled ») ou tant que l'agent
 * prépare (« staging »), un jeton de compte rendu est (ré)émis pour le nouveau Windows : seul
 * son hash est conservé.
 */
async function migrationOrderFor(deviceId: string): Promise<DeviceAgentMigrationOrder | null> {
  const [d] = await db.select().from(deviceMigrations).where(eq(deviceMigrations.id, deviceId))
  const mode: MigrationMode = d?.migrationMode === 'inplace' ? 'inplace' : 'reset'
  const statuses = mode === 'inplace' ? AGENT_INPLACE_STATUSES : AGENT_STATUSES
  if (!d?.migrationStatus || !statuses.includes(d.migrationStatus)) return null
  if (d.migrationStatus === 'cancelled') {
    return {
      status: 'cancelled',
      mode,
      packageSha256: '',
      ouihelpTenantId: '',
      breakglassUser: BREAKGLASS_USER,
      breakglassPassword: '',
      computerName: '',
      promptUser: false,
      promptMessage: '',
      snoozeMinutes: 0,
      maxSnoozes: 0,
      snoozeCount: 0,
      profileMap: [],
      removeProfiles: [],
      removeApps: [],
    }
  }
  const [pkg] = await db
    .select({ sha256: deviceMigrationPackages.sha256 })
    .from(deviceMigrationPackages)
    .where(eq(deviceMigrationPackages.active, 1))
    .orderBy(desc(deviceMigrationPackages.uploadedAt))
    .limit(1)
  if (!pkg) return null

  let reportToken: string | undefined
  let status = d.migrationStatus as MigrationStatus
  if (status === 'scheduled' || status === 'staging') {
    reportToken = generateReportToken()
    await db
      .update(deviceMigrations)
      .set({ migrationTokenHash: hashToken(reportToken) })
      .where(eq(deviceMigrations.id, deviceId))
    if (status === 'scheduled') {
      status = 'staging'
      await recordStep(
        deviceId,
        { step: 'ordre', status: 'info', source: 'serveur', message: 'Ordre transmis à l’agent' },
        { status }
      )
    }
  }
  let removeApps: string[] = []
  if (mode === 'inplace') {
    const [agent] = await db
      .select({ report: deviceAgents.report })
      .from(deviceAgents)
      .where(eq(deviceAgents.deviceMigrationId, deviceId))
      .orderBy(desc(deviceAgents.lastCheckinAt))
      .limit(1)
    const report = agent?.report ? (JSON.parse(agent.report) as DeviceAgentReport) : null
    removeApps = appsToRemove(report, await loadAppRules())
  }
  return {
    status,
    mode,
    packageSha256: pkg.sha256,
    ouihelpTenantId: (process.env['AZURE_TENANT_ID'] ?? '').toLowerCase(),
    breakglassUser: BREAKGLASS_USER,
    breakglassPassword: d.breakglassPassword ?? '',
    computerName: d.targetName ?? '',
    promptUser: d.migrationPromptUser === 1,
    promptMessage: MIGRATION_PROMPT_MESSAGE,
    snoozeMinutes: MIGRATION_SNOOZE_MINUTES,
    maxSnoozes: MIGRATION_MAX_SNOOZES,
    snoozeCount: d.migrationSnoozes,
    profileMap: parseProfileMap(d.migrationProfileMap)
      .filter((m) => m.action === 'migrate' && m.newSid && m.newUpn && m.newSam)
      .map((m) => ({
        oldSid: m.oldSid,
        oldUpn: m.oldUpn,
        newSid: m.newSid!,
        newUpn: m.newUpn!,
        newSam: m.newSam!,
      })),
    // Seuls les profils explicitement marqués « delete » à la programmation sont supprimés.
    removeProfiles: parseProfileMap(d.migrationProfileMap)
      .filter((m) => m.action === 'delete')
      .map((m) => ({ sid: m.oldSid, account: m.oldAccount, upn: m.oldUpn })),
    removeApps,
    ...(reportToken ? { reportToken } : {}),
  }
}

/** Agent authentifié par son jeton (endpoints de bascule) → poste rattaché. */
async function agentDevice(bearerHeader: string | undefined): Promise<string | null> {
  const bearer = bearerHeader?.replace(/^Bearer\s+/i, '').trim()
  if (!bearer) return null
  const [agent] = await db
    .select()
    .from(deviceAgents)
    .where(eq(deviceAgents.tokenHash, hashToken(bearer)))
  return agent?.deviceMigrationId ?? null
}

/**
 * Sondage léger : l'agent l'interroge souvent (quelques minutes) pour réagir vite à une
 * bascule programmée, sans envoyer son rapport d'inventaire complet. Renvoie l'ordre ou null.
 */
deviceAgentRouter.get('/order', async (c) => {
  const deviceId = await agentDevice(c.req.header('Authorization'))
  if (!deviceId) return c.json({ error: 'Unauthorized' }, 401)
  const migration = await migrationOrderFor(deviceId)
  return c.json({ migration: migration ?? null })
})

deviceAgentRouter.get('/migration', async (c) => {
  const deviceId = await agentDevice(c.req.header('Authorization'))
  if (!deviceId) return c.json({ error: 'Unauthorized' }, 401)
  const [d] = await db
    .select({
      status: deviceMigrations.migrationStatus,
      error: deviceMigrations.migrationError,
      updatedAt: deviceMigrations.migrationUpdatedAt,
    })
    .from(deviceMigrations)
    .where(eq(deviceMigrations.id, deviceId))
  // Retrait Autopilot ONELA lancé en arrière-plan : un recyclage du conteneur le tue sans
  // reprise. Sans nouvelle étape depuis 10 min, on le relance (opération idempotente).
  if (
    d?.status === 'cleanup' &&
    d.updatedAt &&
    Date.now() - d.updatedAt.getTime() > CLEANUP_STALE_MS
  ) {
    await recordStep(deviceId, {
      step: 'autopilot-onela',
      status: 'info',
      source: 'serveur',
      message: 'Retrait Autopilot ONELA relancé (aucune nouvelle depuis 10 min)',
    })
    cleanupOnelaBeforeReset(deviceId).catch((err) =>
      console.error('[device-migration] cleanup error:', err instanceof Error ? err.message : err)
    )
  }
  return c.json({ status: d?.status ?? null, error: d?.error ?? null })
})

/** PPKG actif, remis uniquement à l'agent d'un poste en cours de préparation. */
deviceAgentRouter.get('/migration/package', async (c) => {
  const deviceId = await agentDevice(c.req.header('Authorization'))
  if (!deviceId) return c.json({ error: 'Unauthorized' }, 401)
  const [d] = await db
    .select({ status: deviceMigrations.migrationStatus })
    .from(deviceMigrations)
    .where(eq(deviceMigrations.id, deviceId))
  if (d?.status !== 'staging')
    return c.json({ error: 'Forbidden', message: 'Aucune bascule en préparation' }, 403)
  const [pkg] = await db
    .select()
    .from(deviceMigrationPackages)
    .where(eq(deviceMigrationPackages.active, 1))
    .orderBy(desc(deviceMigrationPackages.uploadedAt))
    .limit(1)
  if (!pkg) return c.json({ error: 'Not Found', message: 'Aucun PPKG' }, 404)
  await recordStep(deviceId, {
    step: 'ppkg',
    status: 'info',
    source: 'serveur',
    message: `PPKG ${pkg.fileName} remis à l’agent`,
  })
  return c.body(Buffer.from(pkg.content, 'base64'), 200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
})

interface ProgressBody {
  step?: unknown
  status?: unknown
  message?: unknown
  /** Préparation terminée : empreinte matérielle jointe */
  staged?: unknown
  hardwareHash?: unknown
  /** Réinitialisation lancée */
  resetTriggered?: unknown
  /** Échec définitif côté agent (avant réinitialisation) */
  fatal?: unknown
  /** L'utilisateur a reporté la bascule (mode session ouverte) */
  snoozed?: unknown
  /** Bascule en place : le poste est joint à Ouihelp (constaté par l'agent après redémarrage) */
  joined?: unknown
}

deviceAgentRouter.post('/migration/progress', async (c) => {
  const deviceId = await agentDevice(c.req.header('Authorization'))
  if (!deviceId) return c.json({ error: 'Unauthorized' }, 401)
  const b = ((await c.req.json().catch(() => null)) ?? {}) as ProgressBody
  const [d] = await db
    .select({ status: deviceMigrations.migrationStatus })
    .from(deviceMigrations)
    .where(eq(deviceMigrations.id, deviceId))
  const current = d?.status as MigrationStatus | undefined
  if (!current || !ACTIVE_STATUSES.includes(current)) {
    return c.json({ error: 'Conflict', message: 'Aucune bascule en cours' }, 409)
  }
  const stepStatus = b.status === 'ok' || b.status === 'error' ? b.status : 'info'
  const step = {
    step: str(b.step, 40) ?? 'agent',
    status: stepStatus as 'ok' | 'error' | 'info',
    source: 'agent' as const,
    message: str(b.message, 1000) ?? '',
  }

  if (
    b.fatal === true &&
    ['staging', 'staged', 'ready', 'resetting', 'joining'].includes(current)
  ) {
    await recordStep(deviceId, step, { status: 'failed', error: step.message })
  } else if (b.joined === true && ['resetting', 'joining'].includes(current)) {
    // Bascule en place : l'agent (conservé) constate la jonction Ouihelp
    await recordStep(deviceId, step, { status: 'done', error: null })
    finalizeAfterJoin(deviceId).catch((err) =>
      console.error('[device-migration] finalize error:', err instanceof Error ? err.message : err)
    )
  } else if (b.snoozed === true) {
    // L'utilisateur a reporté : on compte, l'avertissement reviendra plus tard
    await db
      .update(deviceMigrations)
      .set({ migrationSnoozes: sql`${deviceMigrations.migrationSnoozes} + 1` })
      .where(eq(deviceMigrations.id, deviceId))
    await recordStep(deviceId, step)
  } else if (b.staged === true && current === 'staging') {
    const hash =
      typeof b.hardwareHash === 'string' && b.hardwareHash.length < 64_000 ? b.hardwareHash : null
    await db
      .update(deviceMigrations)
      .set({ hardwareHash: hash })
      .where(eq(deviceMigrations.id, deviceId))
    await recordStep(deviceId, step, { status: 'cleanup' })
    // Retrait d'Autopilot ONELA : peut prendre quelques minutes, l'agent interroge /migration
    cleanupOnelaBeforeReset(deviceId).catch((err) =>
      console.error('[device-migration] cleanup error:', err instanceof Error ? err.message : err)
    )
  } else if (b.resetTriggered === true && current === 'ready') {
    await recordStep(deviceId, step, { status: 'resetting' })
  } else {
    await recordStep(deviceId, step)
  }
  return c.json({ ok: true })
})

/**
 * Compte rendu du NOUVEAU Windows (l'agent a été effacé) : authentifié par le jeton de
 * compte rendu déposé dans C:\\DSI avant la réinitialisation.
 */
deviceAgentRouter.post('/migration/report', async (c) => {
  const token = c.req.header('X-Migration-Token')?.trim()
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const [d] = await db
    .select({ id: deviceMigrations.id, status: deviceMigrations.migrationStatus })
    .from(deviceMigrations)
    .where(eq(deviceMigrations.migrationTokenHash, hashToken(token)))
  if (!d) return c.json({ error: 'Unauthorized' }, 401)
  const status = d.status as MigrationStatus
  if (!['resetting', 'joining', 'ready', 'failed'].includes(status)) {
    return c.json({ error: 'Conflict', message: 'Bascule non attendue' }, 409)
  }
  const b = ((await c.req.json().catch(() => null)) ?? {}) as ProgressBody & { joined?: unknown }
  const step = {
    step: str(b.step, 40) ?? 'poste',
    status: (b.status === 'ok' || b.status === 'error' ? b.status : 'info') as
      | 'ok'
      | 'error'
      | 'info',
    source: 'poste' as const,
    message: str(b.message, 1000) ?? '',
  }
  if (b.joined === true) {
    await recordStep(d.id, step, { status: 'done', error: null })
    finalizeAfterJoin(d.id).catch((err) =>
      console.error('[device-migration] finalize error:', err instanceof Error ? err.message : err)
    )
  } else if (step.status === 'error') {
    await recordStep(d.id, step, { status: 'failed', error: step.message })
  } else {
    await recordStep(d.id, step, { status: 'joining' })
  }
  return c.json({ ok: true })
})
