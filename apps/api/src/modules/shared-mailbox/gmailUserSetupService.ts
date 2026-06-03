// Setup "shared mailbox façon Gmail label" sur chaque membre du groupe :
//   1. Libellé "Service DSI" (ou nom du groupe)
//   2. Filtre qui applique le libellé + archive automatiquement les mails reçus
//      à l'adresse du groupe partagé
//   3. Identité "Envoyer en tant que" pour répondre avec l'adresse partagée
//
// Pourquoi : alternative au collaborative inbox de Google Groups, plus naturelle
// pour les users habitués à Outlook/Gmail standard. Chaque membre voit les mails
// du service comme un libellé dans son Gmail perso.
//
// Scopes DwD requis (Google Admin Console → Domain-wide delegation, en plus de
// gmail.modify déjà autorisé) :
//   - https://www.googleapis.com/auth/gmail.labels
//   - https://www.googleapis.com/auth/gmail.settings.basic
//   - https://www.googleapis.com/auth/gmail.settings.sharing

import { fetchWithTimeout } from '../migration/httpClient'
import { getGoogleAccessTokenForUser } from '../migration/googleService'

const SCOPE_GMAIL_LABELS = 'https://www.googleapis.com/auth/gmail.labels'
const SCOPE_GMAIL_SETTINGS_BASIC = 'https://www.googleapis.com/auth/gmail.settings.basic'
const SCOPE_GMAIL_SETTINGS_SHARING = 'https://www.googleapis.com/auth/gmail.settings.sharing'

// ── Helpers HTTP Gmail ───────────────────────────────────────────────────────

async function gmailFetch(
  userEmail: string,
  scope: string,
  path: string,
  init?: Parameters<typeof fetchWithTimeout>[1],
): Promise<Response> {
  const token = await getGoogleAccessTokenForUser(userEmail, scope)
  return fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

// ── Labels ───────────────────────────────────────────────────────────────────

interface GmailLabel {
  id: string
  name: string
  type: 'system' | 'user'
}

async function listLabels(userEmail: string): Promise<GmailLabel[]> {
  const res = await gmailFetch(userEmail, SCOPE_GMAIL_LABELS, '/labels')
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`List labels error (${res.status}): ${err.slice(0, 300)}`)
  }
  const data = (await res.json()) as { labels?: GmailLabel[] }
  return data.labels ?? []
}

/** Crée le libellé s'il n'existe pas. Retourne son ID. */
export async function ensureLabel(userEmail: string, labelName: string): Promise<{ id: string; created: boolean }> {
  const labels = await listLabels(userEmail)
  const existing = labels.find((l) => l.name === labelName)
  if (existing) return { id: existing.id, created: false }

  const res = await gmailFetch(userEmail, SCOPE_GMAIL_LABELS, '/labels', {
    method: 'POST',
    body: JSON.stringify({
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Create label error (${res.status}): ${err.slice(0, 300)}`)
  }
  const data = (await res.json()) as GmailLabel
  return { id: data.id, created: true }
}

// ── Filtres ──────────────────────────────────────────────────────────────────

interface GmailFilter {
  id: string
  criteria?: { to?: string; from?: string; query?: string; subject?: string }
  action?: { addLabelIds?: string[]; removeLabelIds?: string[] }
}

async function listFilters(userEmail: string): Promise<GmailFilter[]> {
  const res = await gmailFetch(userEmail, SCOPE_GMAIL_SETTINGS_BASIC, '/settings/filters')
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`List filters error (${res.status}): ${err.slice(0, 300)}`)
  }
  const data = (await res.json()) as { filter?: GmailFilter[] }
  return data.filter ?? []
}

/**
 * Crée un filtre qui applique `labelId` (et archive : skipInbox) sur les mails
 * adressés à `sharedAddress`. Idempotent : ne recrée pas si un filtre identique existe.
 *
 * Critère utilisé : `to:<sharedAddress>` — matche le header To/CC.
 * Quand Google Group fan-out, chaque membre reçoit une copie avec le To original
 * préservé, donc cette condition matche bien.
 */
export async function ensureFilter(
  userEmail: string,
  sharedAddress: string,
  labelId: string,
): Promise<{ id: string; created: boolean }> {
  const filters = await listFilters(userEmail)
  const existing = filters.find(
    (f) =>
      f.criteria?.to?.toLowerCase() === sharedAddress.toLowerCase() &&
      f.action?.addLabelIds?.includes(labelId),
  )
  if (existing) return { id: existing.id, created: false }

  const res = await gmailFetch(userEmail, SCOPE_GMAIL_SETTINGS_BASIC, '/settings/filters', {
    method: 'POST',
    body: JSON.stringify({
      criteria: { to: sharedAddress },
      action: {
        addLabelIds: [labelId],
        removeLabelIds: ['INBOX'], // archive (skip inbox)
      },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Create filter error (${res.status}): ${err.slice(0, 300)}`)
  }
  const data = (await res.json()) as GmailFilter
  return { id: data.id, created: true }
}

// ── Send As ──────────────────────────────────────────────────────────────────

interface SendAs {
  sendAsEmail: string
  displayName?: string
  isDefault?: boolean
  treatAsAlias?: boolean
  verificationStatus?: 'accepted' | 'pending' | 'success'
}

async function listSendAs(userEmail: string): Promise<SendAs[]> {
  const res = await gmailFetch(userEmail, SCOPE_GMAIL_SETTINGS_SHARING, '/settings/sendAs')
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`List sendAs error (${res.status}): ${err.slice(0, 300)}`)
  }
  const data = (await res.json()) as { sendAs?: SendAs[] }
  return data.sendAs ?? []
}

/**
 * Ajoute une identité "Envoyer en tant que" si elle n'existe pas.
 * Avec `treatAsAlias: true`, fonctionne sans vérification SMTP si la cible
 * est une adresse dans le même Workspace.
 */
export async function ensureSendAs(
  userEmail: string,
  sendAsEmail: string,
  displayName: string,
): Promise<{ created: boolean; verificationStatus?: string }> {
  const list = await listSendAs(userEmail)
  const existing = list.find((s) => s.sendAsEmail.toLowerCase() === sendAsEmail.toLowerCase())
  if (existing) return { created: false, verificationStatus: existing.verificationStatus }

  const res = await gmailFetch(userEmail, SCOPE_GMAIL_SETTINGS_SHARING, '/settings/sendAs', {
    method: 'POST',
    body: JSON.stringify({
      sendAsEmail,
      displayName,
      treatAsAlias: true,
      isDefault: false,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Create sendAs error (${res.status}): ${err.slice(0, 300)}`)
  }
  const data = (await res.json()) as SendAs
  return { created: true, verificationStatus: data.verificationStatus }
}

// ── Orchestrateurs (sur tous les membres du groupe) ──────────────────────────

interface BulkResult {
  total: number
  created: number
  alreadyOk: number
  failed: number
  failedMembers: string[]
}

async function listMembers(groupEmail: string): Promise<string[]> {
  // On réutilise l'API admin directory déjà câblée dans googleGroupsService,
  // mais pour éviter le couplage circulaire on refait un fetch léger ici.
  const SCOPE_DIRECTORY_GROUP = 'https://www.googleapis.com/auth/admin.directory.group'
  const adminEmail = process.env['GOOGLE_ADMIN_EMAIL']
  if (!adminEmail) throw new Error('GOOGLE_ADMIN_EMAIL manquant')
  const token = await getGoogleAccessTokenForUser(adminEmail, SCOPE_DIRECTORY_GROUP)

  const members: string[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`)
    url.searchParams.set('maxResults', '200')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetchWithTimeout(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`List members error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as {
      members?: Array<{ email: string; type: string }>
      nextPageToken?: string
    }
    for (const m of data.members ?? []) {
      // On ne configure que les USER (pas les groupes imbriqués ni externes)
      if (m.type === 'USER' && m.email) members.push(m.email)
    }
    pageToken = data.nextPageToken
  } while (pageToken)
  return members
}

export async function setupLabelForAllMembers(groupEmail: string, labelName: string): Promise<BulkResult> {
  const members = await listMembers(groupEmail)
  let created = 0
  let alreadyOk = 0
  let failed = 0
  const failedMembers: string[] = []
  for (const m of members) {
    try {
      const r = await ensureLabel(m, labelName)
      if (r.created) created++
      else alreadyOk++
    } catch (err) {
      failed++
      failedMembers.push(m)
      console.warn(`[setup-label] ${m}:`, err instanceof Error ? err.message : err)
    }
  }
  return { total: members.length, created, alreadyOk, failed, failedMembers }
}

export async function setupFilterForAllMembers(
  groupEmail: string,
  sharedAddress: string,
  labelName: string,
): Promise<BulkResult> {
  const members = await listMembers(groupEmail)
  let created = 0
  let alreadyOk = 0
  let failed = 0
  const failedMembers: string[] = []
  for (const m of members) {
    try {
      // S'assurer que le label existe d'abord (sinon le filter cassera)
      const label = await ensureLabel(m, labelName)
      const r = await ensureFilter(m, sharedAddress, label.id)
      if (r.created) created++
      else alreadyOk++
    } catch (err) {
      failed++
      failedMembers.push(m)
      console.warn(`[setup-filter] ${m}:`, err instanceof Error ? err.message : err)
    }
  }
  return { total: members.length, created, alreadyOk, failed, failedMembers }
}

export async function setupSendAsForAllMembers(
  groupEmail: string,
  sendAsEmail: string,
  displayName: string,
): Promise<BulkResult> {
  const members = await listMembers(groupEmail)
  let created = 0
  let alreadyOk = 0
  let failed = 0
  const failedMembers: string[] = []
  for (const m of members) {
    try {
      const r = await ensureSendAs(m, sendAsEmail, displayName)
      if (r.created) created++
      else alreadyOk++
    } catch (err) {
      failed++
      failedMembers.push(m)
      console.warn(`[setup-sendas] ${m}:`, err instanceof Error ? err.message : err)
    }
  }
  return { total: members.length, created, alreadyOk, failed, failedMembers }
}
