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
