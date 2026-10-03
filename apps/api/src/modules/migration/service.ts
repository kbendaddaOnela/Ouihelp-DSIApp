// Graph API client — client credentials flow (no SDK dependency)
import { fetchWithTimeout } from './httpClient'

interface TokenCache {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, TokenCache>()

export async function getAccessToken(tenantId: string, clientId: string, clientSecret: string, scope = 'https://graph.microsoft.com/.default'): Promise<string> {
  const cacheKey = `${tenantId}:${clientId}:${scope}`
  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token

  const res = await fetchWithTimeout(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Token error (${res.status}): ${err}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 })
  return data.access_token
}

async function graphRequest<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetchWithTimeout(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph ${res.status} on ${method} ${path}: ${err}`)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// ── Types ─────────────────────────────────────────────────────────────────────

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
}

const USER_SELECT = 'id,displayName,givenName,surname,userPrincipalName,mail,department,jobTitle,companyName'

// ── ONELA tenant (read-only) ──────────────────────────────────────────────────

export async function getOnelaToken(): Promise<string> {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('ONELA Graph credentials manquantes')
  return getAccessToken(tid, cid, sec)
}

export async function searchOnelaUsers(query: string): Promise<GraphUser[]> {
  const token = await getOnelaToken()
  const filter = `startsWith(displayName,'${query}') or startsWith(userPrincipalName,'${query}') or startsWith(mail,'${query}')`
  const res = await graphRequest<{ value: GraphUser[] }>(
    token, 'GET',
    `/users?$filter=${encodeURIComponent(filter)}&$select=${USER_SELECT}&$top=20`
  )
  return res.value
}

/**
 * Compte, en direct dans le tenant ONELA, la population « à migrer », ventilée
 * par service (attribut `department`) : comptes de type Member, activés, dont le
 * mail est @onela.com (exclut contacts, boîtes partagées non-Member et comptes
 * techniques hors domaine). `total` = somme de tous les services. Les comptes
 * sans département sont regroupés sous « (sans département) » — même libellé que
 * l'agrégation CSV, pour que les lignes se réconcilient.
 * Requête avancée (endsWith) → header ConsistencyLevel: eventual + $count=true.
 * Domaine surchargeable via ONELA_MAILBOX_DOMAIN.
 */
export async function countOnelaUsersByDepartment(): Promise<{ total: number; byDept: Record<string, number> }> {
  const token = await getOnelaToken()
  const domain = process.env['ONELA_MAILBOX_DOMAIN'] || 'onela.com'
  const filter = `userType eq 'Member' and accountEnabled eq true and endsWith(mail,'@${domain}')`
  let url: string | null =
    `https://graph.microsoft.com/v1.0/users?$filter=${encodeURIComponent(filter)}&$count=true&$select=department&$top=999`
  const byDept: Record<string, number> = {}
  let total = 0
  while (url) {
    const res: Response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Graph byDept ONELA ${res.status}: ${err.slice(0, 300)}`)
    }
    const data = (await res.json()) as { value?: Array<{ department: string | null }>; '@odata.nextLink'?: string }
    for (const u of data.value ?? []) {
      total++
      const dept = (u.department ?? '').trim() || '(sans département)'
      byDept[dept] = (byDept[dept] ?? 0) + 1
    }
    url = data['@odata.nextLink'] ?? null
  }
  return { total, byDept }
}

export interface OnelaGroupMember {
  upn: string
  mail: string | null
}

/**
 * Liste les membres (utilisateurs actifs) d'un groupe de sécurité ONELA, via
 * transitiveMembers (gère les groupes imbriqués). Ne garde que les comptes
 * activés dont le mail est @onela.com — la population réellement à migrer.
 * Requête avancée ($count) → header ConsistencyLevel: eventual.
 */
export async function getOnelaGroupMembers(groupId: string): Promise<OnelaGroupMember[]> {
  const token = await getOnelaToken()
  const domain = process.env['ONELA_MAILBOX_DOMAIN'] || 'onela.com'
  let url: string | null =
    `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}/transitiveMembers/microsoft.graph.user` +
    `?$select=userPrincipalName,accountEnabled,mail&$count=true&$top=999`
  const members: OnelaGroupMember[] = []
  while (url) {
    const res: Response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Graph group members ${res.status} (${groupId}): ${err.slice(0, 300)}`)
    }
    const data = (await res.json()) as {
      value?: Array<{ userPrincipalName: string | null; accountEnabled: boolean | null; mail: string | null }>
      '@odata.nextLink'?: string
    }
    for (const u of data.value ?? []) {
      if (u.accountEnabled === false) continue
      const mail = u.mail ?? null
      if (!mail || !mail.toLowerCase().endsWith(`@${domain}`)) continue
      const upn = (u.userPrincipalName ?? mail).toLowerCase()
      members.push({ upn, mail: mail.toLowerCase() })
    }
    url = data['@odata.nextLink'] ?? null
  }
  return members
}

/**
 * Liste complète des utilisateurs (détails) d'un groupe ONELA — pour la
 * sélection des membres avant lancement de migration. Mêmes champs que la
 * recherche, ne garde que les comptes activés @onela.com.
 */
export async function getOnelaGroupUsers(groupId: string): Promise<GraphUser[]> {
  const token = await getOnelaToken()
  const domain = process.env['ONELA_MAILBOX_DOMAIN'] || 'onela.com'
  let url: string | null =
    `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}/transitiveMembers/microsoft.graph.user` +
    `?$select=${USER_SELECT},accountEnabled&$count=true&$top=999`
  const users: GraphUser[] = []
  while (url) {
    const res: Response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Graph group users ${res.status} (${groupId}): ${err.slice(0, 300)}`)
    }
    const data = (await res.json()) as { value?: Array<GraphUser & { accountEnabled?: boolean | null }>; '@odata.nextLink'?: string }
    for (const u of data.value ?? []) {
      if (u.accountEnabled === false) continue
      const mail = u.mail ?? null
      if (!mail || !mail.toLowerCase().endsWith(`@${domain}`)) continue
      users.push(u)
    }
    url = data['@odata.nextLink'] ?? null
  }
  return users
}

/**
 * Envoie un e-mail depuis une boîte ONELA via Graph (app-only sendMail).
 * Expéditeur = ONELA_CREDENTIALS_SENDER (UPN d'une boîte ONELA). Nécessite la
 * permission Graph **Mail.Send** (application) sur l'app ONELA.
 */
export async function sendOnelaMail(params: { to: string; subject: string; html: string }): Promise<void> {
  const sender = process.env['ONELA_CREDENTIALS_SENDER']
  if (!sender) throw new Error('ONELA_CREDENTIALS_SENDER non défini (boîte expéditrice ONELA pour l\'envoi des accès)')
  const token = await getOnelaToken()
  const res = await fetchWithTimeout(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: params.subject,
        body: { contentType: 'HTML', content: params.html },
        toRecipients: [{ emailAddress: { address: params.to } }],
      },
      saveToSentItems: true,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph sendMail ${res.status}: ${err.slice(0, 300)}`)
  }
}

// ── Exchange Admin REST API (ForwardingSMTPAddress) ──────────────────────────
// Uses the same API as Exchange Admin Center to set the real transport-level forwarding

async function onelaExchangeToken(): Promise<string> {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('ONELA credentials manquantes')
  return getAccessToken(tid, cid, sec, 'https://outlook.office365.com/.default')
}

async function exchangeAdminRequest<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const tid = process.env['ONELA_TENANT_ID']
  const res = await fetchWithTimeout(`https://outlook.office365.com/adminapi/beta/${tid}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Exchange Admin ${res.status} on ${method} ${path}: ${err}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function setOnelaMailForwarding(onelaUpn: string, forwardTo: string): Promise<void> {
  const token = await onelaExchangeToken()
  await exchangeAdminRequest<void>(token, 'PATCH', `/Mailbox('${encodeURIComponent(onelaUpn)}')`, {
    ForwardingSmtpAddress: `smtp:${forwardTo}`,
    DeliverToMailboxAndForward: true,
  })
}

export async function removeOnelaMailForwarding(onelaUpn: string): Promise<void> {
  const token = await onelaExchangeToken()
  await exchangeAdminRequest<void>(token, 'PATCH', `/Mailbox('${encodeURIComponent(onelaUpn)}')`, {
    ForwardingSmtpAddress: null,
    DeliverToMailboxAndForward: false,
  })
}

export async function checkOnelaMailForwarding(onelaUpn: string): Promise<{ active: boolean; forwardTo: string | null }> {
  const token = await onelaExchangeToken()
  const mailbox = await exchangeAdminRequest<{
    ForwardingSmtpAddress: string | null
    DeliverToMailboxAndForward: boolean
  }>(token, 'GET', `/Mailbox('${encodeURIComponent(onelaUpn)}')?$select=ForwardingSmtpAddress,DeliverToMailboxAndForward`)
  const addr = mailbox.ForwardingSmtpAddress?.replace(/^smtp:/i, '') ?? null
  return { active: !!addr, forwardTo: addr }
}

// ── GOH tenant (read-write) ───────────────────────────────────────────────────

async function gohToken(): Promise<string> {
  const tid = process.env['AZURE_TENANT_ID']
  const cid = process.env['AZURE_CLIENT_ID']
  const sec = process.env['AZURE_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('GOH Graph credentials manquantes')
  return getAccessToken(tid, cid, sec)
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

export async function createGohUser(params: {
  givenName: string
  surname: string
  upn: string
  displayName: string
  department: string | null
  jobTitle: string | null
  tempPassword: string
  // Champs optionnels (onboarding nouvel arrivant — module accounts)
  officeLocation?: string | null
  streetAddress?: string | null
  postalCode?: string | null
  city?: string | null
  state?: string | null
  // Locale/pays : NON posés par défaut pour ne pas altérer le comportement de la
  // migration (qui n'appelle pas ces champs). Seul le module accounts les fournit.
  usageLocation?: string | null
  country?: string | null
  preferredLanguage?: string | null
  forceChangePassword?: boolean
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
    officeLocation: params.officeLocation ?? undefined,
    streetAddress: params.streetAddress ?? undefined,
    postalCode: params.postalCode ?? undefined,
    city: params.city ?? undefined,
    state: params.state ?? undefined,
    companyName: 'ONELA',
    country: params.country ?? undefined,
    usageLocation: params.usageLocation ?? undefined,
    preferredLanguage: params.preferredLanguage ?? undefined,
    passwordProfile: {
      forceChangePasswordNextSignIn: params.forceChangePassword ?? true,
      password: params.tempPassword,
    },
  })
}

/** Définit le manager d'un compte GOH (Graph manager/$ref). Le manager doit exister dans le tenant GOH. */
export async function setGohUserManager(userId: string, managerUpn: string): Promise<void> {
  const token = await gohToken()
  await graphRequest<void>(token, 'PUT', `/users/${userId}/manager/$ref`, {
    '@odata.id': `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(managerUpn)}`,
  })
}

/** Recherche des utilisateurs dans le tenant GOH (autocomplétion manager). */
export async function searchGohUsers(query: string): Promise<GraphUser[]> {
  const token = await gohToken()
  const filter = `startsWith(displayName,'${query}') or startsWith(userPrincipalName,'${query}') or startsWith(mail,'${query}')`
  const res = await graphRequest<{ value: GraphUser[] }>(
    token, 'GET',
    `/users?$filter=${encodeURIComponent(filter)}&$select=${USER_SELECT}&$top=20`
  )
  return res.value
}

export async function setGohUserAttributes(userId: string, ext10: string, ext11: string): Promise<void> {
  const token = await gohToken()
  // On renseigne aussi `mail` avec la valeur d'extensionAttribute11 (prenom.nom@onela.com)
  // pour que le compte affiche la bonne adresse de routage dans Entra ID
  await graphRequest<void>(token, 'PATCH', `/users/${userId}`, {
    mail: ext11,
    onPremisesExtensionAttributes: { extensionAttribute10: ext10, extensionAttribute11: ext11 },
  })
}

// ── GOH : offboarding (mot de passe / sessions) ───────────────────────────────

export interface GohAccount {
  id: string
  userPrincipalName: string
  displayName: string
  accountEnabled: boolean
}

/**
 * Retrouve le compte Entra GOH d'un utilisateur Google.
 *
 * Cas nominal : le compte Google a été provisionné par SCIM → son adresse
 * primaire (prenom.nom@mig.onela.com) EST l'UPN GOH. Repli sur `mail` puis
 * `proxyAddresses` pour les alias (prenom.nom@onela.com est posé en `mail` par
 * setGohUserAttributes). null si rien ne correspond.
 */
export async function findGohUserByEmails(emails: string[]): Promise<GohAccount | null> {
  const token = await gohToken()
  const select = 'id,userPrincipalName,displayName,accountEnabled'
  for (const email of emails) {
    try {
      return await graphRequest<GohAccount>(token, 'GET', `/users/${encodeURIComponent(email)}?$select=${select}`)
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('Graph 404'))) throw err
    }
  }
  for (const email of emails) {
    const e = email.replace(/'/g, "''")
    const filter = `mail eq '${e}' or proxyAddresses/any(p:p eq 'smtp:${e}')`
    const res = await graphRequest<{ value: GohAccount[] }>(
      token, 'GET',
      `/users?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=2`,
    )
    if (res.value.length === 1) return res.value[0]!
  }
  return null
}

/**
 * Réinitialise le mot de passe d'un compte GOH (app-only).
 * Permission Graph applicative requise : User-PasswordProfile.ReadWrite.All
 * (ou User.ReadWrite.All + rôle d'annuaire « Administrateur de l'authentification
 * privilégiée » pour les comptes admin — Entra refuse sinon avec un 403).
 */
export async function resetGohUserPassword(
  userId: string,
  password: string,
  forceChangePasswordNextSignIn = false,
): Promise<void> {
  const token = await gohToken()
  await graphRequest<void>(token, 'PATCH', `/users/${userId}`, {
    passwordProfile: { password, forceChangePasswordNextSignIn },
  })
}

/** Invalide les refresh tokens / cookies de session du compte GOH (User.RevokeSessions.All). */
export async function revokeGohUserSessions(userId: string): Promise<void> {
  const token = await gohToken()
  await graphRequest<unknown>(token, 'POST', `/users/${userId}/revokeSignInSessions`)
}
