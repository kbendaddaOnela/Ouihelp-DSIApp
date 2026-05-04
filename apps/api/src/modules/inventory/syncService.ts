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
  return data.token ?? data.access_token
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
  let url: string | undefined = `https://graph.microsoft.com/v1.0/users?$select=id,userPrincipalName,displayName,department,jobTitle,accountEnabled&$top=999&$filter=accountEnabled eq true`
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`MS users error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { value: MsUser[]; '@odata.nextLink'?: string }
    for (const u of data.value) yield u
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

export async function runSync(): Promise<{ users: number; devices: number }> {
  if (syncInProgress) throw new Error('Sync déjà en cours')
  syncInProgress = true

  await db.insert(syncStatus).values({ id: 'main', status: 'running', userCount: 0, deviceCount: 0 })
    .onDuplicateKeyUpdate({ set: { status: 'running', error: null } })

  try {
    let totalUsers = 0
    let totalDevices = 0

    // ── Supprimer les anciennes données ──
    await db.delete(cachedUsers)
    await db.delete(cachedDevices)

    // ── Ouihelp users ──
    const { tid: ohTid, cid: ohCid, sec: ohSec } = ouihelpCreds()
    const ohToken = await getMsToken(ohTid, ohCid, ohSec)
    const ohUsers: (typeof cachedUsers.$inferInsert)[] = []
    for await (const u of iterateMsUsers(ohToken)) {
      ohUsers.push({
        id: randomUUID(),
        source: 'ouihelp',
        upn: u.userPrincipalName,
        displayName: u.displayName,
        department: u.department ?? null,
        jobTitle: u.jobTitle ?? null,
        accountEnabled: 1,
        syncedAt: new Date(),
      })
      if (ohUsers.length === 200) {
        await db.insert(cachedUsers).values(ohUsers)
        totalUsers += ohUsers.length
        ohUsers.length = 0
      }
    }
    if (ohUsers.length) { await db.insert(cachedUsers).values(ohUsers); totalUsers += ohUsers.length }

    // ── ONELA users ──
    const { tid: olTid, cid: olCid, sec: olSec } = onelaCreds()
    const olToken = await getMsToken(olTid, olCid, olSec)
    const olUsers: (typeof cachedUsers.$inferInsert)[] = []
    for await (const u of iterateMsUsers(olToken)) {
      olUsers.push({
        id: randomUUID(),
        source: 'onela',
        upn: u.userPrincipalName,
        displayName: u.displayName,
        department: u.department ?? null,
        jobTitle: u.jobTitle ?? null,
        accountEnabled: 1,
        syncedAt: new Date(),
      })
      if (olUsers.length === 200) {
        await db.insert(cachedUsers).values(olUsers)
        totalUsers += olUsers.length
        olUsers.length = 0
      }
    }
    if (olUsers.length) { await db.insert(cachedUsers).values(olUsers); totalUsers += olUsers.length }

    // ── Google users ──
    const gUsers: (typeof cachedUsers.$inferInsert)[] = []
    for await (const u of iterateGoogleUsers()) {
      const org = u.organizations?.find((o) => o.primary) ?? u.organizations?.[0]
      gUsers.push({
        id: randomUUID(),
        source: 'google',
        upn: u.primaryEmail,
        displayName: u.name.fullName,
        department: org?.department ?? null,
        jobTitle: org?.title ?? null,
        accountEnabled: 1,
        syncedAt: new Date(),
      })
      if (gUsers.length === 200) {
        await db.insert(cachedUsers).values(gUsers)
        totalUsers += gUsers.length
        gUsers.length = 0
      }
    }
    if (gUsers.length) { await db.insert(cachedUsers).values(gUsers); totalUsers += gUsers.length }

    // ── Ouihelp devices (Intune) ──
    const ohDevices: (typeof cachedDevices.$inferInsert)[] = []
    for await (const d of iterateIntuneDevices(ohToken)) {
      ohDevices.push({
        id: randomUUID(),
        source: 'ouihelp',
        deviceName: d.deviceName,
        operatingSystem: d.operatingSystem,
        osVersion: d.osVersion,
        deviceType: inferDeviceType(d.operatingSystem, d.chassisType),
        complianceState: (d.complianceState as typeof cachedDevices.$inferInsert['complianceState']) ?? 'unknown',
        userPrincipalName: d.userPrincipalName || null,
        userDisplayName: d.userDisplayName || null,
        lastSyncDateTime: d.lastSyncDateTime ? new Date(d.lastSyncDateTime) : null,
        enrolledDateTime: d.enrolledDateTime ? new Date(d.enrolledDateTime) : null,
        syncedAt: new Date(),
      })
      if (ohDevices.length === 200) {
        await db.insert(cachedDevices).values(ohDevices)
        totalDevices += ohDevices.length
        ohDevices.length = 0
      }
    }
    if (ohDevices.length) { await db.insert(cachedDevices).values(ohDevices); totalDevices += ohDevices.length }

    // ── ONELA devices (Intune) ──
    const olDevices: (typeof cachedDevices.$inferInsert)[] = []
    for await (const d of iterateIntuneDevices(olToken)) {
      olDevices.push({
        id: randomUUID(),
        source: 'onela',
        deviceName: d.deviceName,
        operatingSystem: d.operatingSystem,
        osVersion: d.osVersion,
        deviceType: inferDeviceType(d.operatingSystem, d.chassisType),
        complianceState: (d.complianceState as typeof cachedDevices.$inferInsert['complianceState']) ?? 'unknown',
        userPrincipalName: d.userPrincipalName || null,
        userDisplayName: d.userDisplayName || null,
        lastSyncDateTime: d.lastSyncDateTime ? new Date(d.lastSyncDateTime) : null,
        enrolledDateTime: d.enrolledDateTime ? new Date(d.enrolledDateTime) : null,
        syncedAt: new Date(),
      })
      if (olDevices.length === 200) {
        await db.insert(cachedDevices).values(olDevices)
        totalDevices += olDevices.length
        olDevices.length = 0
      }
    }
    if (olDevices.length) { await db.insert(cachedDevices).values(olDevices); totalDevices += olDevices.length }

    await db.insert(syncStatus).values({ id: 'main', status: 'idle', userCount: totalUsers, deviceCount: totalDevices, lastSyncAt: new Date() })
      .onDuplicateKeyUpdate({ set: { status: 'idle', userCount: totalUsers, deviceCount: totalDevices, lastSyncAt: new Date(), error: null } })

    return { users: totalUsers, devices: totalDevices }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.insert(syncStatus).values({ id: 'main', status: 'error', error: msg })
      .onDuplicateKeyUpdate({ set: { status: 'error', error: msg } })
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
