interface TokenCache {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, TokenCache>()

async function getAccessToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const cacheKey = `${tenantId}:${clientId}`
  const cached = tokenCache.get(cacheKey)
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

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph token error (${res.status}): ${err}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  })
  return data.access_token
}

async function graphRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph API error ${res.status} on ${method} ${path}: ${err}`)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// ── ONELA client (read-only) ──────────────────────────────────────────────────

async function onelaToken(): Promise<string> {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('ONELA Graph credentials manquantes')
  return getAccessToken(tid, cid, sec)
}

export interface GraphUser {
  id: string
  displayName: string
  givenName: string
  surname: string
  userPrincipalName: string
  mail: string | null
  department: string | null
  jobTitle: string | null
  companyName: string | null
  onPremisesExtensionAttributes?: {
    extensionAttribute10?: string | null
    extensionAttribute11?: string | null
  } | null
}

const USER_SELECT = 'id,displayName,givenName,surname,userPrincipalName,mail,department,jobTitle,companyName,onPremisesExtensionAttributes'

export async function searchOnelaUsers(query: string): Promise<GraphUser[]> {
  const token = await onelaToken()

  // Search by displayName, mail, or UPN
  const filter = `startsWith(displayName,'${query}') or startsWith(userPrincipalName,'${query}') or startsWith(mail,'${query}')`
  const encoded = encodeURIComponent(filter)

  const res = await graphRequest<{ value: GraphUser[] }>(
    token,
    'GET',
    `/users?$filter=${encoded}&$select=${USER_SELECT}&$top=20`
  )
  return res.value
}

// ── GOH client (read-write) ───────────────────────────────────────────────────

async function gohToken(): Promise<string> {
  const tid = process.env['AZURE_TENANT_ID']
  const cid = process.env['AZURE_CLIENT_ID']
  const sec = process.env['AZURE_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('GOH Graph credentials manquantes')
  return getAccessToken(tid, cid, sec)
}

export async function createGohUser(params: {
  givenName: string
  surname: string
  upn: string
  displayName: string
  department: string | null
  jobTitle: string | null
  tempPassword: string
}): Promise<GraphUser> {
  const token = await gohToken()
  return graphRequest<GraphUser>(token, 'POST', '/users', {
    accountEnabled: true,
    displayName: params.displayName,
    givenName: params.givenName,
    surname: params.surname,
    userPrincipalName: params.upn,
    mailNickname: params.upn.split('@')[0],
    department: params.department ?? undefined,
    jobTitle: params.jobTitle ?? undefined,
    companyName: 'ONELA',
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password: params.tempPassword,
    },
  })
}

export async function setGohUserAttributes(userId: string, ext10: string, ext11: string): Promise<void> {
  const token = await gohToken()
  await graphRequest<void>(token, 'PATCH', `/users/${userId}`, {
    onPremisesExtensionAttributes: {
      extensionAttribute10: ext10,
      extensionAttribute11: ext11,
    },
  })
}

export async function checkGohUserExists(upn: string): Promise<boolean> {
  const token = await gohToken()
  try {
    await graphRequest<GraphUser>(token, 'GET', `/users/${encodeURIComponent(upn)}?$select=id`)
    return true
  } catch {
    return false
  }
}
