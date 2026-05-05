import { randomUUID } from 'crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db/index'
import { cachedUsers, cachedDevices, syncStatus } from './schema'
import { getGoogleAccessTokenForUser } from '../migration/googleService'

const ADMIN_DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly'

// ── Token helpers ─────────────────────────────────────────────────────────────

const msTokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getMsToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const key = `${tenantId}|${clientId}`
  const cached = msTokenCache.get(key)
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  })
  if (!res.ok) throw new Error(`MS token error (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  msTokenCache.set(key, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 })
  return data.access_token
}

function ouihelpCreds() {
  const tid = process.env['AZURE_TENANT_ID']
  const cid = process.env['AZURE_CLIENT_ID']
  const sec = process.env['AZURE_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('Credentials Ouihelp (AZURE_*) manquants')
  return { tid, cid, sec }
}

function onelaCreds() {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('Credentials ONELA manquants')
  return { tid, cid, sec }
}

// ── Fetch MS users (tous, actifs uniquement) ──────────────────────────────────

interface MsUser {
  id: string
  userPrincipalName: string
  displayName: string
  department?: string
  jobTitle?: string
  accountEnabled: boolean
}

async function* iterateMsUsers(token: string): AsyncGenerator<MsUser> {
  // Pas de $filter côté serveur : avec accountEnabled, Graph nécessite ConsistencyLevel:eventual
  // ce qui peut tronquer les résultats. On filtre côté client après récupération complète.
  let url: string | undefined = `https://graph.microsoft.com/v1.0/users?$select=id,userPrincipalName,displayName,department,jobTitle,accountEnabled&$top=999`
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`MS users error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { value: MsUser[]; '@odata.nextLink'?: string }
    for (const u of data.value) {
      if (u.accountEnabled) yield u
    }
    url = data['@odata.nextLink']
  }
}

// ── Fetch Google users ────────────────────────────────────────────────────────

interface GUser {
  id: string
  primaryEmail: string
  name: { fullName: string }
  orgUnitPath?: string
  suspended?: boolean
  organizations?: Array<{ department?: string; title?: string; primary?: boolean }>
}

async function* iterateGoogleUsers(): AsyncGenerator<GUser> {
  const adminEmail = process.env['GOOGLE_ADMIN_EMAIL']
  if (!adminEmail) throw new Error('GOOGLE_ADMIN_EMAIL manquant')
  const token = await getGoogleAccessTokenForUser(adminEmail, ADMIN_DIRECTORY_SCOPE)

  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ customer: 'my_customer', maxResults: '500', query: 'isSuspended=false' })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await fetch(`https://admin.googleapis.com/admin/directory/v1/users?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Google users error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { users?: GUser[]; nextPageToken?: string }
    for (const u of data.users ?? []) yield u
    pageToken = data.nextPageToken
  } while (pageToken)
}

// ── Fetch Intune devices ──────────────────────────────────────────────────────

interface IntuneDevice {
  id: string
  deviceName: string
  operatingSystem: string
  osVersion: string
  complianceState: string
  userPrincipalName: string
  userDisplayName: string
  lastSyncDateTime: string
  enrolledDateTime: string
  deviceType?: string
  chassisType?: string
}

async function* iterateIntuneDevices(token: string): AsyncGenerator<IntuneDevice> {
  let url: string | undefined = `https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$select=id,deviceName,operatingSystem,osVersion,complianceState,userPrincipalName,userDisplayName,lastSyncDateTime,enrolledDateTime,chassisType&$top=999`
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const body = await res.text()
      if (res.status === 403) throw new Error(`Intune: permission DeviceManagementManagedDevices.Read.All manquante (${body})`)
      throw new Error(`Intune devices error (${res.status}): ${body}`)
    }
    const data = (await res.json()) as { value: IntuneDevice[]; '@odata.nextLink'?: string }
    for (const d of data.value) yield d
    url = data['@odata.nextLink']
  }
}

function inferDeviceType(os: string, chassis: string | undefined): string {
  if (chassis) {
    const c = chassis.toLowerCase()
    if (c === 'laptop' || c === 'notebook') return 'Laptop'
    if (c === 'desktop') return 'Desktop'
    if (c === 'tablet') return 'Tablette'
    if (c === 'phone' || c === 'mobilePhone') return 'Téléphone'
  }
  const o = os.toLowerCase()
  if (o === 'ios' || o === 'android') return 'Mobile'
  if (o === 'macos') return 'Mac'
  if (o === 'windows') return 'Windows PC'
  return os || 'Inconnu'
}

// ── Sync principal ────────────────────────────────────────────────────────────

let syncInProgress = false

// 5 étapes : users OH, users ONELA, users Google, devices OH, devices ONELA
const SYNC_STEPS = [
  { key: 'users-ouihelp',  label: 'Utilisateurs Ouihelp',  progress: 10 },
  { key: 'users-onela',    label: 'Utilisateurs ONELA',    progress: 30 },
  { key: 'users-google',   label: 'Utilisateurs Google',   progress: 50 },
  { key: 'devices-ouihelp',label: 'Appareils Ouihelp',     progress: 70 },
  { key: 'devices-onela',  label: 'Appareils ONELA',       progress: 90 },
]

async function setStep(step: string, progress: number) {
  await db.insert(syncStatus)
    .values({ id: 'main', status: 'running', syncStep: step, syncProgress: progress, userCount: 0, deviceCount: 0 })
    .onDuplicateKeyUpdate({ set: { syncStep: step, syncProgress: progress } })
}

async function collectAll<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of gen) items.push(item)
  return items
}

async function insertBatched<T extends object>(rows: T[], inserter: (batch: T[]) => Promise<void>, batchSize = 200) {
  for (let i = 0; i < rows.length; i += batchSize) {
    await inserter(rows.slice(i, i + batchSize))
  }
}

export async function runSync(): Promise<{ users: number; devices: number }> {
  if (syncInProgress) throw new Error('Sync déjà en cours')
  syncInProgress = true

  await db.insert(syncStatus)
    .values({ id: 'main', status: 'running', userCount: 0, deviceCount: 0, syncStep: 'Démarrage…', syncProgress: 0, error: null })
    .onDuplicateKeyUpdate({ set: { status: 'running', syncStep: 'Démarrage…', syncProgress: 0, error: null } })

  try {
    const { tid: ohTid, cid: ohCid, sec: ohSec } = ouihelpCreds()
    const { tid: olTid, cid: olCid, sec: olSec } = onelaCreds()
    const ohToken = await getMsToken(ohTid, ohCid, ohSec)
    const olToken = await getMsToken(olTid, olCid, olSec)

    // ── Ouihelp users ──────────────────────────────────────────
    await setStep(SYNC_STEPS[0].label, SYNC_STEPS[0].progress)
    const ohRawUsers = await collectAll(iterateMsUsers(ohToken))
    const ohUsersRows = ohRawUsers.map((u) => ({
      id: randomUUID(), source: 'ouihelp' as const,
      upn: u.userPrincipalName, displayName: u.displayName,
      department: u.department ?? null, jobTitle: u.jobTitle ?? null,
      accountEnabled: 1, syncedAt: new Date(),
    }))

    // ── ONELA users ────────────────────────────────────────────
    await setStep(SYNC_STEPS[1].label, SYNC_STEPS[1].progress)
    const olRawUsers = await collectAll(iterateMsUsers(olToken))
    const olUsersRows = olRawUsers.map((u) => ({
      id: randomUUID(), source: 'onela' as const,
      upn: u.userPrincipalName, displayName: u.displayName,
      department: u.department ?? null, jobTitle: u.jobTitle ?? null,
      accountEnabled: 1, syncedAt: new Date(),
    }))

    // ── Google users ───────────────────────────────────────────
    await setStep(SYNC_STEPS[2].label, SYNC_STEPS[2].progress)
    const gRawUsers = await collectAll(iterateGoogleUsers())
    const gUsersRows = gRawUsers.map((u) => {
      const org = u.organizations?.find((o) => o.primary) ?? u.organizations?.[0]
      return {
        id: randomUUID(), source: 'google' as const,
        upn: u.primaryEmail, displayName: u.name.fullName,
        department: org?.department ?? null, jobTitle: org?.title ?? null,
        accountEnabled: 1, syncedAt: new Date(),
      }
    })

    // ── Ouihelp devices ────────────────────────────────────────
    await setStep(SYNC_STEPS[3].label, SYNC_STEPS[3].progress)
    const ohRawDevices = await collectAll(iterateIntuneDevices(ohToken))
    const ohDevicesRows = ohRawDevices.map((d) => ({
      id: randomUUID(), source: 'ouihelp' as const,
      deviceName: d.deviceName, operatingSystem: d.operatingSystem, osVersion: d.osVersion,
      deviceType: inferDeviceType(d.operatingSystem, d.chassisType),
      complianceState: (d.complianceState as typeof cachedDevices.$inferInsert['complianceState']) ?? 'unknown',
      userPrincipalName: d.userPrincipalName || null, userDisplayName: d.userDisplayName || null,
      lastSyncDateTime: d.lastSyncDateTime ? new Date(d.lastSyncDateTime) : null,
      enrolledDateTime: d.enrolledDateTime ? new Date(d.enrolledDateTime) : null,
      syncedAt: new Date(),
    }))

    // ── ONELA devices ──────────────────────────────────────────
    await setStep(SYNC_STEPS[4].label, SYNC_STEPS[4].progress)
    const olRawDevices = await collectAll(iterateIntuneDevices(olToken))
    const olDevicesRows = olRawDevices.map((d) => ({
      id: randomUUID(), source: 'onela' as const,
      deviceName: d.deviceName, operatingSystem: d.operatingSystem, osVersion: d.osVersion,
      deviceType: inferDeviceType(d.operatingSystem, d.chassisType),
      complianceState: (d.complianceState as typeof cachedDevices.$inferInsert['complianceState']) ?? 'unknown',
      userPrincipalName: d.userPrincipalName || null, userDisplayName: d.userDisplayName || null,
      lastSyncDateTime: d.lastSyncDateTime ? new Date(d.lastSyncDateTime) : null,
      enrolledDateTime: d.enrolledDateTime ? new Date(d.enrolledDateTime) : null,
      syncedAt: new Date(),
    }))

    // ── Écriture atomique ──────────────────────────────────────
    await setStep('Enregistrement…', 95)
    await db.delete(cachedUsers)
    await db.delete(cachedDevices)

    const allUsers = [...ohUsersRows, ...olUsersRows, ...gUsersRows]
    const allDevices = [...ohDevicesRows, ...olDevicesRows]

    if (allUsers.length) await insertBatched(allUsers, (b) => db.insert(cachedUsers).values(b))
    if (allDevices.length) await insertBatched(allDevices, (b) => db.insert(cachedDevices).values(b))

    await db.insert(syncStatus)
      .values({ id: 'main', status: 'idle', userCount: allUsers.length, deviceCount: allDevices.length, lastSyncAt: new Date(), syncStep: 'Terminé', syncProgress: 100 })
      .onDuplicateKeyUpdate({ set: { status: 'idle', userCount: allUsers.length, deviceCount: allDevices.length, lastSyncAt: new Date(), syncStep: 'Terminé', syncProgress: 100, error: null } })

    return { users: allUsers.length, devices: allDevices.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.insert(syncStatus).values({ id: 'main', status: 'error', error: msg, syncProgress: 0 })
      .onDuplicateKeyUpdate({ set: { status: 'error', error: msg, syncProgress: 0 } })
    throw err
  } finally {
    syncInProgress = false
  }
}

export async function getSyncStats() {
  const [status] = await db.select().from(syncStatus).where(eq(syncStatus.id, 'main'))

  const userCounts = await db.select({
    source: cachedUsers.source,
    count: sql<number>`COUNT(*)`,
  }).from(cachedUsers).groupBy(cachedUsers.source)

  const deviceCounts = await db.select({
    source: cachedDevices.source,
    count: sql<number>`COUNT(*)`,
  }).from(cachedDevices).groupBy(cachedDevices.source)

  const complianceCounts = await db.select({
    source: cachedDevices.source,
    complianceState: cachedDevices.complianceState,
    count: sql<number>`COUNT(*)`,
  }).from(cachedDevices).groupBy(cachedDevices.source, cachedDevices.complianceState)

  return { status: status ?? null, userCounts, deviceCounts, complianceCounts }
}
