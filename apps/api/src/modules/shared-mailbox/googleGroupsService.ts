// Google Groups : création (Admin SDK) + import RFC822 dans l'archive (Groups Migration API).
//
// Scopes DwD requis (à autoriser dans Google Admin Console pour le service account) :
//   - https://www.googleapis.com/auth/admin.directory.group        (créer/lire les groupes)
//   - https://www.googleapis.com/auth/apps.groups.migration        (importer dans l'archive)
//
// L'API Groups Migration accepte du RFC822 et préserve la date d'origine du message :
// idéal pour migrer une BAL partagée Exchange sans consommer de licence Workspace.

import { fetchWithTimeout } from '../migration/httpClient'
import { getGoogleAccessTokenForUser } from '../migration/googleService'

const SCOPE_DIRECTORY_GROUP = 'https://www.googleapis.com/auth/admin.directory.group'
const SCOPE_GROUPS_MIGRATION = 'https://www.googleapis.com/auth/apps.groups.migration'
const SCOPE_GROUPS_SETTINGS = 'https://www.googleapis.com/auth/apps.groups.settings'

function adminEmail(): string {
  const e = process.env['GOOGLE_ADMIN_EMAIL']
  if (!e) throw new Error('GOOGLE_ADMIN_EMAIL manquant')
  return e
}

interface DirectoryGroup {
  id: string
  email: string
  name: string
  description?: string
}

/** Récupère un groupe par email. Renvoie null si absent (404). */
export async function getGoogleGroup(email: string): Promise<DirectoryGroup | null> {
  const token = await getGoogleAccessTokenForUser(adminEmail(), SCOPE_DIRECTORY_GROUP)
  const res = await fetchWithTimeout(
    `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status === 404) return null
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Google get group error (${res.status}): ${err}`)
  }
  return res.json() as Promise<DirectoryGroup>
}

/** Crée un groupe Google Workspace. Retourne le groupe (id inclus). */
export async function createGoogleGroup(params: {
  email: string
  name: string
  description?: string
}): Promise<DirectoryGroup> {
  const token = await getGoogleAccessTokenForUser(adminEmail(), SCOPE_DIRECTORY_GROUP)
  const res = await fetchWithTimeout('https://admin.googleapis.com/admin/directory/v1/groups', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: params.email,
      name: params.name,
      description: params.description ?? 'Migré depuis Exchange (boîte partagée ONELA)',
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Google create group error (${res.status}): ${err}`)
  }
  return res.json() as Promise<DirectoryGroup>
}

/** Crée le groupe s'il n'existe pas. Idempotent. */
export async function ensureGoogleGroup(params: {
  email: string
  name: string
  description?: string
}): Promise<DirectoryGroup> {
  const existing = await getGoogleGroup(params.email)
  if (existing) return existing
  return createGoogleGroup(params)
}

/** Ajoute un alias au groupe. Idempotent (409 = déjà présent). */
export async function addGroupAlias(groupEmail: string, alias: string): Promise<{ added: boolean }> {
  const token = await getGoogleAccessTokenForUser(adminEmail(), SCOPE_DIRECTORY_GROUP)
  const res = await fetchWithTimeout(
    `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/aliases`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias }),
    },
  )
  if (res.status === 409) return { added: false }
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Add group alias error (${res.status}): ${err}`)
  }
  return { added: true }
}

/**
 * Importe un message RFC822 dans l'archive d'un Google Group via Groups Migration API.
 * Préserve la date d'origine (Date: header du MIME). Idempotence : à gérer côté appelant
 * (l'API ne dédoublonne pas — chaque appel crée une entrée d'archive).
 *
 * Retries : 429, 500, 502, 503, 504 avec backoff exponentiel.
 */
const ARCHIVE_MAX_RETRIES = 4

export async function archiveMessageToGroup(params: {
  groupEmail: string
  rawMime: Buffer | Uint8Array | string
}): Promise<void> {
  const token = await getGoogleAccessTokenForUser(adminEmail(), SCOPE_GROUPS_MIGRATION)
  const url = `https://www.googleapis.com/upload/groups/v1/groups/${encodeURIComponent(
    params.groupEmail,
  )}/archive?uploadType=media`

  for (let attempt = 0; attempt < ARCHIVE_MAX_RETRIES; attempt++) {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'message/rfc822' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: params.rawMime as any,
    })

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { responseCode?: string }
      if (data.responseCode && data.responseCode !== 'SUCCESS') {
        throw new Error(`Groups Migration: ${data.responseCode}`)
      }
      return
    }

    const status = res.status
    const errBody = await res.text().catch(() => '')

    const isRetryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504
    if (isRetryable && attempt < ARCHIVE_MAX_RETRIES - 1) {
      const backoff = Math.min(1000 * Math.pow(2, attempt + 1), 16000)
      await new Promise((r) => setTimeout(r, backoff))
      continue
    }
    throw new Error(`Groups Migration error (${status}): ${errBody.slice(0, 500)}`)
  }
}

// ── Groups Settings (permissions de publication) ─────────────────────────────
// Pour le dual delivery : par défaut un Google Group n'accepte les mails que de
// ses membres. Si on forward depuis Exchange (expéditeur externe), il faut
// ouvrir les permissions, sinon les mails bouncent.

export interface GroupSettings {
  whoCanPostMessage?:
    | 'NONE_CAN_POST'
    | 'ALL_MANAGERS_CAN_POST'
    | 'ALL_OWNERS_CAN_POST'
    | 'ALL_MEMBERS_CAN_POST'
    | 'ALL_IN_DOMAIN_CAN_POST'
    | 'ANYONE_CAN_POST'
  allowExternalMembers?: 'true' | 'false'
  messageModerationLevel?: 'MODERATE_ALL_MESSAGES' | 'MODERATE_NON_MEMBERS' | 'MODERATE_NEW_MEMBERS' | 'MODERATE_NONE'
  isArchived?: 'true' | 'false'
  enableCollaborativeInbox?: 'true' | 'false'
  whoCanModerateContent?: 'NONE' | 'OWNERS_ONLY' | 'OWNERS_AND_MANAGERS' | 'ALL_MEMBERS'
  whoCanModerateMembers?: 'NONE' | 'OWNERS_ONLY' | 'OWNERS_AND_MANAGERS' | 'ALL_MEMBERS'
  whoCanAssignTopics?: 'NONE' | 'OWNERS_ONLY' | 'OWNERS_AND_MANAGERS' | 'MANAGERS_ONLY' | 'ALL_MEMBERS'
  whoCanTakeTopics?: 'NONE' | 'OWNERS_ONLY' | 'OWNERS_AND_MANAGERS' | 'MANAGERS_ONLY' | 'ALL_MEMBERS'
  whoCanMarkNoResponseNeeded?: 'NONE' | 'OWNERS_ONLY' | 'OWNERS_AND_MANAGERS' | 'MANAGERS_ONLY' | 'ALL_MEMBERS'
}

export async function getGroupSettings(groupEmail: string): Promise<GroupSettings> {
  const token = await getGoogleAccessTokenForUser(adminEmail(), SCOPE_GROUPS_SETTINGS)
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/groups/v1/groups/${encodeURIComponent(groupEmail)}?alt=json`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Group settings get error (${res.status}): ${err}`)
  }
  return res.json() as Promise<GroupSettings>
}

export async function updateGroupSettings(groupEmail: string, patch: Partial<GroupSettings>): Promise<GroupSettings> {
  const token = await getGoogleAccessTokenForUser(adminEmail(), SCOPE_GROUPS_SETTINGS)
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/groups/v1/groups/${encodeURIComponent(groupEmail)}?alt=json`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Group settings update error (${res.status}): ${err}`)
  }
  return res.json() as Promise<GroupSettings>
}

/** Ouvre le groupe aux posts externes (nécessaire pour le dual delivery depuis Exchange). */
export async function allowExternalPostsOnGroup(groupEmail: string): Promise<GroupSettings> {
  return updateGroupSettings(groupEmail, {
    whoCanPostMessage: 'ANYONE_CAN_POST',
    messageModerationLevel: 'MODERATE_NONE',
  })
}

// ── Préférences de livraison des membres (fan-out vs. groupe seul) ──────────

interface GroupMember {
  id: string
  email: string
  role: 'OWNER' | 'MANAGER' | 'MEMBER'
  type: 'USER' | 'GROUP' | 'EXTERNAL' | 'CUSTOMER'
  status: string
  delivery_settings?: 'ALL_MAIL' | 'DAILY' | 'DIGEST' | 'NONE' | 'DISABLED'
}

async function listGroupMembers(groupEmail: string): Promise<GroupMember[]> {
  const token = await getGoogleAccessTokenForUser(adminEmail(), SCOPE_DIRECTORY_GROUP)
  const members: GroupMember[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`)
    url.searchParams.set('maxResults', '200')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetchWithTimeout(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`List members error (${res.status}): ${err}`)
    }
    const data = (await res.json()) as { members?: GroupMember[]; nextPageToken?: string }
    if (data.members) members.push(...data.members)
    pageToken = data.nextPageToken
  } while (pageToken)
  return members
}

async function setMemberDelivery(
  groupEmail: string,
  memberKey: string,
  setting: 'ALL_MAIL' | 'DAILY' | 'DIGEST' | 'NONE',
): Promise<void> {
  const token = await getGoogleAccessTokenForUser(adminEmail(), SCOPE_DIRECTORY_GROUP)
  const res = await fetchWithTimeout(
    `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members/${encodeURIComponent(memberKey)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery_settings: setting }),
    },
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Update member delivery error (${res.status}): ${err}`)
  }
}

/**
 * Désactive le fan-out vers les boîtes Gmail perso des membres.
 * Chaque membre garde l'accès au groupe (web/mobile) mais ne reçoit plus
 * de copie dans son inbox perso. Idéal pour un usage shared mailbox pur.
 *
 * Note : ne s'applique qu'aux membres ACTUELS. Les nouveaux membres ajoutés
 * ensuite garderont la valeur par défaut (ALL_MAIL) → re-cliquer après ajout.
 */
export async function silenceAllGroupMembers(
  groupEmail: string,
): Promise<{ total: number; updated: number; alreadySilent: number; failed: number; failedMembers: string[] }> {
  const members = await listGroupMembers(groupEmail)
  let updated = 0
  let alreadySilent = 0
  let failed = 0
  const failedMembers: string[] = []
  for (const m of members) {
    if (m.type === 'GROUP') continue // ne pas modifier les groupes imbriqués
    if (m.delivery_settings === 'NONE' || m.delivery_settings === 'DISABLED') {
      alreadySilent++
      continue
    }
    try {
      await setMemberDelivery(groupEmail, m.id ?? m.email, 'NONE')
      updated++
    } catch (err) {
      failed++
      failedMembers.push(m.email)
      console.warn(`[silence-members] ${m.email}:`, err instanceof Error ? err.message : err)
    }
  }
  return { total: members.length, updated, alreadySilent, failed, failedMembers }
}

/**
 * Active la "Boîte de réception collaborative" (mode shared mailbox).
 * Active aussi l'historique des conversations qui est un prérequis obligatoire.
 * Donne aux membres la capacité d'assigner/prendre/résoudre les threads.
 */
export async function enableCollaborativeInbox(groupEmail: string): Promise<GroupSettings> {
  return updateGroupSettings(groupEmail, {
    isArchived: 'true', // Historique des conversations (prérequis)
    enableCollaborativeInbox: 'true',
    whoCanModerateContent: 'ALL_MEMBERS',
    whoCanModerateMembers: 'ALL_MEMBERS',
    whoCanAssignTopics: 'ALL_MEMBERS',
    whoCanTakeTopics: 'ALL_MEMBERS',
    whoCanMarkNoResponseNeeded: 'ALL_MEMBERS',
  })
}
