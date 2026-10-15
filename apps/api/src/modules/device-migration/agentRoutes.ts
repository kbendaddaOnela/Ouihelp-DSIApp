import { Hono } from 'hono'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { eq } from 'drizzle-orm'
import type {
  DeviceAgentCheckinResponse,
  DeviceAgentProfile,
  DeviceAgentReport,
  DeviceJoinType,
} from '@dsi-app/shared'
import { db } from '../../db/index'
import { deviceAgents, deviceMigrations, type DeviceAgentRow } from './schema'
import { normSerial } from './inventoryService'

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
  let report: DeviceAgentReport | null = null
  try {
    report = sanitizeReport(JSON.parse(body))
  } catch {
    report = null
  }
  if (!report) return c.json({ error: 'Bad Request', message: 'Rapport invalide' }, 400)

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

  const res: DeviceAgentCheckinResponse = {
    agentId: row.id,
    ...(issuedToken ? { deviceToken: issuedToken } : {}),
    nextCheckinMinutes: DEFAULT_CHECKIN_MINUTES,
  }
  return c.json(res)
})
