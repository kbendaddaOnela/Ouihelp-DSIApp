import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import type { DeviceEntraObject, DeviceJoinType, DeviceMigrationSyncState } from '@dsi-app/shared'
import { db } from '../../db/index'
import { syncStatus } from '../inventory/schema'
import { getMsToken, ouihelpCreds, onelaCreds } from '../inventory/syncService'
import { deviceMigrations, type DeviceMigrationRow, type NewDeviceMigrationRow } from './schema'

/**
 * Inventaire consolidé des postes ONELA (lot 1, lecture seule côté tenants).
 *
 * Sources ONELA : objets Entra (trustType → type de jonction), Intune (n° de série,
 * utilisateur principal), Autopilot, métadonnées des clés BitLocker. Sources Ouihelp :
 * Intune + Autopilot, rapprochés par n° de série pour savoir quels PC ont déjà basculé.
 *
 * Chaque source est best-effort : une permission manquante produit un avertissement et
 * la synchro continue sans elle. Seule l'absence simultanée d'Entra ET d'Intune ONELA
 * est bloquante (on n'aurait alors aucun poste).
 *
 * Permissions applicatives attendues :
 *   ONELA   : Device.Read.All, DeviceManagementManagedDevices.Read.All,
 *             DeviceManagementServiceConfig.Read.All, User.Read.All, BitLockerKey.ReadBasic.All
 *   Ouihelp : DeviceManagementManagedDevices.Read.All, DeviceManagementServiceConfig.Read.All
 */

const SYNC_STATUS_ID = 'device-migration'
const GRAPH = 'https://graph.microsoft.com/v1.0'

// ── Graph : pagination + retry 429/5xx ───────────────────────────────────────

class GraphError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

async function graphGetAll<T>(
  token: string,
  url: string,
  label: string,
  headers: Record<string, string> = {}
): Promise<T[]> {
  const out: T[] = []
  let next: string | undefined = url
  while (next) {
    let res: Response | undefined
    for (let attempt = 1; attempt <= 5; attempt++) {
      res = await fetch(next, { headers: { Authorization: `Bearer ${token}`, ...headers } })
      if (res.status !== 429 && res.status < 500) break
      const retryAfter = Number(res.headers.get('Retry-After') ?? 0)
      await new Promise((r) => setTimeout(r, Math.max(retryAfter * 1000, 1500 * attempt)))
    }
    if (!res!.ok) {
      const body = (await res!.text()).slice(0, 300)
      throw new GraphError(res!.status, `${label} (${res!.status}) : ${body}`)
    }
    const data = (await res!.json()) as { value: T[]; '@odata.nextLink'?: string }
    out.push(...data.value)
    next = data['@odata.nextLink']
  }
  return out
}

// ── Types Graph ──────────────────────────────────────────────────────────────

interface EntraDevice {
  id: string
  deviceId: string
  displayName: string | null
  operatingSystem: string | null
  operatingSystemVersion: string | null
  trustType: string | null
  accountEnabled: boolean
  approximateLastSignInDateTime: string | null
  registrationDateTime: string | null
  isManaged: boolean | null
  manufacturer: string | null
  model: string | null
}

interface IntuneDevice {
  id: string
  deviceName: string | null
  serialNumber: string | null
  manufacturer: string | null
  model: string | null
  osVersion: string | null
  azureADDeviceId: string | null
  userPrincipalName: string | null
  userDisplayName: string | null
  lastSyncDateTime: string | null
  managementAgent: string | null
  isEncrypted: boolean | null
  freeStorageSpaceInBytes: number | null
  totalStorageSpaceInBytes: number | null
}

interface AutopilotDevice {
  id: string
  serialNumber: string | null
  groupTag: string | null
  azureActiveDirectoryDeviceId: string | null
  manufacturer: string | null
  model: string | null
}

interface EntraUser {
  userPrincipalName: string
  displayName: string | null
  officeLocation: string | null
  department: string | null
}

interface BitlockerKeyMeta {
  id: string
  deviceId: string | null
}

const ENTRA_SELECT =
  'id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,accountEnabled,approximateLastSignInDateTime,registrationDateTime,isManaged,manufacturer,model'
const INTUNE_SELECT =
  'id,deviceName,serialNumber,manufacturer,model,osVersion,azureADDeviceId,userPrincipalName,userDisplayName,lastSyncDateTime,managementAgent,isEncrypted,freeStorageSpaceInBytes,totalStorageSpaceInBytes'

// Intune renvoie un GUID nul quand le PC n'a pas d'objet Entra
const NULL_GUID = '00000000-0000-0000-0000-000000000000'

function cleanGuid(id: string | null | undefined): string | null {
  if (!id || id === NULL_GUID) return null
  return id.toLowerCase()
}

// N° de série inexploitables (PC assemblés, BIOS non renseigné) : on ne s'en sert pas
// comme clé, sinon tous ces PC fusionneraient en un seul poste.
const JUNK_SERIALS = new Set([
  'TO BE FILLED BY O.E.M.',
  'DEFAULT STRING',
  'SYSTEM SERIAL NUMBER',
  'NONE',
  'N/A',
  'NA',
  '0',
  '00000000',
  '0123456789',
  '123456789',
  'INVALID',
  'NOT APPLICABLE',
  'NOT SPECIFIED',
])

export function normSerial(s: string | null | undefined): string | null {
  const v = (s ?? '').trim().toUpperCase()
  if (v.length < 4 || JUNK_SERIALS.has(v) || /^0+$/.test(v)) return null
  return v
}

function isWindowsClient(os: string | null | undefined): boolean {
  const v = (os ?? '').toLowerCase()
  return v.startsWith('windows') && !v.includes('server')
}

function toDate(s: string | null | undefined): Date | null {
  if (!s || s.startsWith('0001-')) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

const TRUST_PRIORITY: Record<string, number> = { AzureAd: 3, ServerAd: 2, Workplace: 1 }

function joinTypeOf(trustType: string | null | undefined): DeviceJoinType {
  if (trustType === 'AzureAd') return 'entra_joined'
  if (trustType === 'ServerAd') return 'hybrid'
  if (trustType === 'Workplace') return 'registered'
  return 'unknown'
}

// ── État de synchro (en mémoire ; lastSyncAt persisté dans sync_status) ──────

const syncState: DeviceMigrationSyncState = {
  running: false,
  step: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  warnings: [],
  sources: {},
}

export function getSyncState(): DeviceMigrationSyncState {
  return { ...syncState, warnings: [...syncState.warnings], sources: { ...syncState.sources } }
}

export async function getLastSyncAt(): Promise<Date | null> {
  const [row] = await db.select().from(syncStatus).where(eq(syncStatus.id, SYNC_STATUS_ID))
  return row?.lastSyncAt ?? null
}

/** Lance la synchro en arrière-plan. Retourne false si une synchro tourne déjà. */
export function startInventorySync(): boolean {
  if (syncState.running) return false
  runInventorySync().catch((err) =>
    console.error('[device-migration] sync error:', err instanceof Error ? err.message : err)
  )
  return true
}

/** Lit une source ; en cas d'échec, note un avertissement et renvoie null. */
async function optional<T>(label: string, fn: () => Promise<T[]>): Promise<T[] | null> {
  syncState.step = label
  try {
    const rows = await fn()
    syncState.sources[label] = rows.length
    return rows
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const hint =
      err instanceof GraphError && err.status === 403 ? ' — permission applicative manquante ?' : ''
    syncState.warnings.push(`${label} non lu${hint} (${msg})`)
    console.warn(`[device-migration] ${label} : ${msg}`)
    return null
  }
}

// ── Consolidation ────────────────────────────────────────────────────────────

/** Poste en cours de consolidation (avant écriture). */
interface Draft {
  serial: string | null
  entra: EntraDevice[]
  intune: IntuneDevice | null
  autopilot: AutopilotDevice | null
}

function draftName(d: Draft): string | null {
  return d.intune?.deviceName ?? d.entra[0]?.displayName ?? null
}

export function consolidate(
  entra: EntraDevice[],
  intune: IntuneDevice[],
  autopilot: AutopilotDevice[]
): Draft[] {
  const drafts: Draft[] = []
  const bySerial = new Map<string, Draft>()
  const byEntraId = new Map<string, Draft>()
  const entraById = new Map(entra.map((e) => [e.deviceId.toLowerCase(), e]))
  const attached = new Set<string>()

  const attachEntra = (d: Draft, deviceId: string | null) => {
    if (!deviceId || attached.has(deviceId)) return
    // Indexé même sans objet Entra lisible : 2 inscriptions Intune du même PC sans
    // n° de série fiable doivent quand même fusionner.
    if (!byEntraId.has(deviceId)) byEntraId.set(deviceId, d)
    const obj = entraById.get(deviceId)
    if (!obj) return
    d.entra.push(obj)
    attached.add(deviceId)
  }

  // 1. Intune = source la plus riche (n° de série, utilisateur, stockage)
  for (const m of intune) {
    const serial = normSerial(m.serialNumber)
    const aad = cleanGuid(m.azureADDeviceId)
    const existing = (serial && bySerial.get(serial)) || (aad && byEntraId.get(aad)) || null
    // Un même PC peut avoir 2 inscriptions Intune (réinscription) : on garde la plus récente
    if (existing) {
      if (
        (toDate(m.lastSyncDateTime)?.getTime() ?? 0) >
        (toDate(existing.intune?.lastSyncDateTime)?.getTime() ?? 0)
      ) {
        existing.intune = m
      }
      attachEntra(existing, aad)
      continue
    }
    const d: Draft = { serial, entra: [], intune: m, autopilot: null }
    drafts.push(d)
    if (serial) bySerial.set(serial, d)
    attachEntra(d, aad)
  }

  // 2. Autopilot : par n° de série, sinon par deviceId Entra
  for (const a of autopilot) {
    const serial = normSerial(a.serialNumber)
    const aad = cleanGuid(a.azureActiveDirectoryDeviceId)
    let d = (serial && bySerial.get(serial)) || (aad && byEntraId.get(aad)) || null
    if (!d) {
      d = { serial, entra: [], intune: null, autopilot: null }
      drafts.push(d)
      if (serial) bySerial.set(serial, d)
    }
    d.autopilot = a
    attachEntra(d, aad)
  }

  // 3. Objets Entra restants (hybrides / registered hors Intune). Rattachement par nom :
  //    un PC hybride a souvent un objet ServerAd + un objet Workplace du même nom.
  const byName = new Map<string, Draft>()
  for (const d of drafts) {
    const n = draftName(d)?.toLowerCase()
    if (n && !byName.has(n)) byName.set(n, d)
  }
  for (const e of entra) {
    const id = e.deviceId.toLowerCase()
    if (attached.has(id)) continue
    const n = e.displayName?.toLowerCase()
    let d = n ? byName.get(n) : undefined
    if (!d) {
      d = { serial: null, entra: [], intune: null, autopilot: null }
      drafts.push(d)
      if (n) byName.set(n, d)
    }
    attachEntra(d, id)
  }

  // Objet Entra principal en tête : AzureAd > ServerAd > Workplace, puis le plus récent
  for (const d of drafts) {
    d.entra.sort(
      (a, b) =>
        (TRUST_PRIORITY[b.trustType ?? ''] ?? 0) - (TRUST_PRIORITY[a.trustType ?? ''] ?? 0) ||
        (toDate(b.approximateLastSignInDateTime)?.getTime() ?? 0) -
          (toDate(a.approximateLastSignInDateTime)?.getTime() ?? 0)
    )
  }
  return drafts
}

function gb(bytes: number | null | undefined): number | null {
  return bytes && bytes > 0 ? Math.round(bytes / 1024 ** 3) : null
}

// ── Synchro ──────────────────────────────────────────────────────────────────

export async function runInventorySync(): Promise<void> {
  if (syncState.running) return
  const startedAt = new Date()
  Object.assign(syncState, {
    running: true,
    step: 'Démarrage',
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    error: null,
    warnings: [],
    sources: {},
  })

  try {
    const ol = onelaCreds()
    const oh = ouihelpCreds()
    const olToken = await getMsToken(ol.tid, ol.cid, ol.sec)
    const ohToken = await getMsToken(oh.tid, oh.cid, oh.sec)

    // ── ONELA ──
    const entraAll = await optional('Entra ONELA', () =>
      graphGetAll<EntraDevice>(
        olToken,
        `${GRAPH}/devices?$select=${ENTRA_SELECT}&$top=999`,
        'Entra ONELA'
      )
    )
    const intuneAll = await optional('Intune ONELA', () =>
      graphGetAll<IntuneDevice>(
        olToken,
        `${GRAPH}/deviceManagement/managedDevices?$filter=operatingSystem eq 'Windows'&$select=${INTUNE_SELECT}&$top=999`,
        'Intune ONELA'
      )
    )
    if (!entraAll && !intuneAll)
      throw new Error('Ni Entra ni Intune ONELA lisibles — voir les avertissements')

    const autopilotOl = await optional('Autopilot ONELA', () =>
      graphGetAll<AutopilotDevice>(
        olToken,
        `${GRAPH}/deviceManagement/windowsAutopilotDeviceIdentities`,
        'Autopilot ONELA'
      )
    )
    const usersOl = await optional('Utilisateurs ONELA', () =>
      graphGetAll<EntraUser>(
        olToken,
        `${GRAPH}/users?$select=userPrincipalName,displayName,officeLocation,department&$top=999`,
        'Utilisateurs ONELA'
      )
    )
    // Métadonnées seules (ReadBasic) : on compte les clés par poste, sans lire leur valeur
    const bitlockerOl = await optional('Clés BitLocker ONELA', () =>
      graphGetAll<BitlockerKeyMeta>(
        olToken,
        `${GRAPH}/informationProtection/bitlocker/recoveryKeys`,
        'Clés BitLocker ONELA',
        {
          'ocp-client-name': 'DSI App',
          'ocp-client-version': '1.0',
        }
      )
    )

    // ── Ouihelp ──
    const intuneOh = await optional('Intune Ouihelp', () =>
      graphGetAll<IntuneDevice>(
        ohToken,
        `${GRAPH}/deviceManagement/managedDevices?$filter=operatingSystem eq 'Windows'&$select=${INTUNE_SELECT}&$top=999`,
        'Intune Ouihelp'
      )
    )
    const autopilotOh = await optional('Autopilot Ouihelp', () =>
      graphGetAll<AutopilotDevice>(
        ohToken,
        `${GRAPH}/deviceManagement/windowsAutopilotDeviceIdentities`,
        'Autopilot Ouihelp'
      )
    )

    syncState.step = 'Consolidation'
    const entra = (entraAll ?? []).filter((e) => e.deviceId && isWindowsClient(e.operatingSystem))
    const drafts = consolidate(entra, intuneAll ?? [], autopilotOl ?? [])

    const userByUpn = new Map((usersOl ?? []).map((u) => [u.userPrincipalName.toLowerCase(), u]))
    const keysByDevice = new Map<string, number>()
    for (const k of bitlockerOl ?? []) {
      const id = cleanGuid(k.deviceId)
      if (id) keysByDevice.set(id, (keysByDevice.get(id) ?? 0) + 1)
    }
    const ohIntuneBySerial = new Map<string, IntuneDevice>()
    for (const m of intuneOh ?? []) {
      const s = normSerial(m.serialNumber)
      const prev = s ? ohIntuneBySerial.get(s) : undefined
      if (
        s &&
        (!prev ||
          (toDate(m.lastSyncDateTime)?.getTime() ?? 0) >
            (toDate(prev.lastSyncDateTime)?.getTime() ?? 0))
      ) {
        ohIntuneBySerial.set(s, m)
      }
    }
    const ohAutopilotBySerial = new Map<string, AutopilotDevice>()
    for (const a of autopilotOh ?? []) {
      const s = normSerial(a.serialNumber)
      if (s) ohAutopilotBySerial.set(s, a)
    }

    // ── Écriture ──
    syncState.step = 'Enregistrement'
    const existing = await db.select().from(deviceMigrations)
    const existingByKey = new Map(existing.map((r) => [r.deviceKey, r]))
    const existingByEntra = new Map<string, DeviceMigrationRow>()
    for (const r of existing) if (r.onelaEntraDeviceId) existingByEntra.set(r.onelaEntraDeviceId, r)

    let written = 0
    for (const d of drafts) {
      const primary = d.entra[0] ?? null
      const entraDeviceId = primary
        ? primary.deviceId.toLowerCase()
        : cleanGuid(d.intune?.azureADDeviceId ?? d.autopilot?.azureActiveDirectoryDeviceId)
      const key = d.serial
        ? `sn:${d.serial}`
        : entraDeviceId
          ? `aad:${entraDeviceId}`
          : d.intune
            ? `intune:${d.intune.id}`
            : `autopilot:${d.autopilot!.id}`
      const prev =
        existingByKey.get(key) ??
        d.entra.map((e) => existingByEntra.get(e.deviceId.toLowerCase())).find(Boolean) ??
        null

      const upn = d.intune?.userPrincipalName?.toLowerCase() || null
      const user = upn ? userByUpn.get(upn) : undefined
      const ohIntune = d.serial ? ohIntuneBySerial.get(d.serial) : undefined
      const ohAutopilot = d.serial ? ohAutopilotBySerial.get(d.serial) : undefined
      const lastSignIn = d.entra
        .map((e) => toDate(e.approximateLastSignInDateTime))
        .reduce<Date | null>((max, v) => (v && (!max || v > max) ? v : max), null)
      const entraObjects: DeviceEntraObject[] = d.entra.map((e) => ({
        objectId: e.id,
        deviceId: e.deviceId.toLowerCase(),
        trustType: e.trustType,
        accountEnabled: e.accountEnabled,
        approximateLastSignInDateTime: e.approximateLastSignInDateTime,
        registrationDateTime: e.registrationDateTime,
        isManaged: e.isManaged,
      }))
      const keyCount = bitlockerOl
        ? d.entra.reduce((n, e) => n + (keysByDevice.get(e.deviceId.toLowerCase()) ?? 0), 0)
        : null

      const values: Omit<
        NewDeviceMigrationRow,
        'id' | 'excluded' | 'excludeReason' | 'firstSeenAt' | 'createdAt'
      > = {
        deviceKey: key,
        displayName: draftName(d),
        serialNumber: d.serial,
        manufacturer:
          d.intune?.manufacturer ?? d.autopilot?.manufacturer ?? primary?.manufacturer ?? null,
        model: d.intune?.model ?? d.autopilot?.model ?? primary?.model ?? null,
        osVersion: d.intune?.osVersion ?? primary?.operatingSystemVersion ?? null,
        joinType: joinTypeOf(primary?.trustType),
        onelaEntraDeviceId: entraDeviceId,
        onelaEntraObjects: JSON.stringify(entraObjects),
        onelaEntraLastSignIn: lastSignIn,
        onelaIntuneId: d.intune?.id ?? null,
        onelaIntuneLastSync: toDate(d.intune?.lastSyncDateTime),
        onelaManagementAgent: d.intune?.managementAgent ?? null,
        onelaAutopilotId: d.autopilot?.id ?? null,
        onelaAutopilotGroupTag: d.autopilot?.groupTag || null,
        onelaUserUpn: upn,
        onelaUserName: user?.displayName ?? d.intune?.userDisplayName ?? null,
        onelaOfficeLocation: user?.officeLocation ?? null,
        onelaDepartment: user?.department ?? null,
        isEncrypted: d.intune?.isEncrypted == null ? null : d.intune.isEncrypted ? 1 : 0,
        freeStorageGb: gb(d.intune?.freeStorageSpaceInBytes),
        totalStorageGb: gb(d.intune?.totalStorageSpaceInBytes),
        bitlockerKeysOnela: keyCount,
        ouihelpIntuneId: ohIntune?.id ?? null,
        ouihelpEntraDeviceId: cleanGuid(
          ohIntune?.azureADDeviceId ?? ohAutopilot?.azureActiveDirectoryDeviceId
        ),
        ouihelpAutopilotId: ohAutopilot?.id ?? null,
        ouihelpLastSync: toDate(ohIntune?.lastSyncDateTime),
        ouihelpUserUpn: ohIntune?.userPrincipalName?.toLowerCase() || null,
        lastSeenAt: startedAt,
      }

      if (prev) {
        await db.update(deviceMigrations).set(values).where(eq(deviceMigrations.id, prev.id))
        existingByKey.delete(prev.deviceKey)
        if (prev.onelaEntraDeviceId) existingByEntra.delete(prev.onelaEntraDeviceId)
      } else {
        await db
          .insert(deviceMigrations)
          .values({ id: randomUUID(), ...values, firstSeenAt: startedAt })
      }
      written++
    }

    // Les postes absents d'ONELA gardent leur ligne (last_seen_at ancien) : on met juste
    // à jour leur présence côté Ouihelp, c'est ce qui prouve qu'ils ont basculé.
    for (const r of existingByKey.values()) {
      if (!r.serialNumber) continue
      const ohIntune = ohIntuneBySerial.get(r.serialNumber)
      const ohAutopilot = ohAutopilotBySerial.get(r.serialNumber)
      await db
        .update(deviceMigrations)
        .set({
          ouihelpIntuneId: ohIntune?.id ?? null,
          ouihelpEntraDeviceId: cleanGuid(
            ohIntune?.azureADDeviceId ?? ohAutopilot?.azureActiveDirectoryDeviceId
          ),
          ouihelpAutopilotId: ohAutopilot?.id ?? null,
          ouihelpLastSync: toDate(ohIntune?.lastSyncDateTime),
          ouihelpUserUpn: ohIntune?.userPrincipalName?.toLowerCase() || null,
        })
        .where(eq(deviceMigrations.id, r.id))
    }

    await db
      .insert(syncStatus)
      .values({
        id: SYNC_STATUS_ID,
        status: 'idle',
        lastSyncAt: startedAt,
        deviceCount: written,
        userCount: 0,
        syncStep: 'Terminé',
        syncProgress: 100,
      })
      .onDuplicateKeyUpdate({
        set: {
          status: 'idle',
          lastSyncAt: startedAt,
          deviceCount: written,
          syncStep: 'Terminé',
          syncProgress: 100,
          error: null,
        },
      })

    console.log(
      `[device-migration] sync OK : ${written} postes (${syncState.warnings.length} avertissement(s))`
    )
  } catch (err) {
    syncState.error = err instanceof Error ? err.message : String(err)
    console.error('[device-migration] sync failed:', syncState.error)
  } finally {
    syncState.running = false
    syncState.step = null
    syncState.finishedAt = new Date().toISOString()
  }
}
