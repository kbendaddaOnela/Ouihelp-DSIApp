// Écriture Google Drive via l'API Drive v3 (DwD, impersonation de l'admin GOH).
//
// Scope DwD requis (à autoriser dans Google Admin Console pour le service account) :
//   - https://www.googleapis.com/auth/drive
//
// Deux modes d'impersonation DwD :
//  - GOOGLE_ADMIN_EMAIL pour l'administration (recherche de Drives, ajout/retrait
//    de membres, création de dossiers).
//  - l'AUTEUR du fichier (compte prenom.nom@mig.onela.com) pour l'upload, afin que
//    Google enregistre le bon « modifié par ». Repli admin si l'auteur n'a pas de
//    compte Google. Tous les appels portent supportsAllDrives=true (cible = Drive
//    partagé, pas un Mon Drive).

import { fetchWithTimeout } from '../migration/httpClient'
import { getGoogleAccessTokenForUser } from '../migration/googleService'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

function adminEmail(): string {
  const e = process.env['GOOGLE_ADMIN_EMAIL']
  if (!e) throw new Error('GOOGLE_ADMIN_EMAIL manquant')
  return e
}

function driveToken(): Promise<string> {
  return getGoogleAccessTokenForUser(adminEmail(), DRIVE_SCOPE)
}

/** Token Drive en usurpant un utilisateur précis (pour attribuer le « modifié par »). */
function impersonatedToken(userEmail: string): Promise<string> {
  return getGoogleAccessTokenForUser(userEmail, DRIVE_SCOPE)
}

/**
 * Ajoute un utilisateur comme membre (writer) d'un Shared Drive — prérequis pour
 * pouvoir y déposer du contenu EN TANT QUE lui (attribution du « modifié par »).
 * Idempotent côté usage : on l'appelle une fois par user/migration et on mémorise
 * l'id de permission pour le retirer en fin de run. Retourne l'id de permission,
 * ou null si l'ajout a échoué (→ l'appelant repliera sur le compte admin).
 */
export async function addSharedDriveMember(
  sharedDriveId: string,
  userEmail: string,
): Promise<string | null> {
  const token = await driveToken()
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sharedDriveId)}/permissions?supportsAllDrives=true&useDomainAdminAccess=true&sendNotificationEmail=false&fields=id`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: userEmail }),
    },
  )
  if (!res.ok) {
    const err = await res.text()
    console.warn(`[sharepoint] addSharedDriveMember ${userEmail} échoué (${res.status}): ${err.slice(0, 200)}`)
    return null
  }
  const data = (await res.json()) as { id: string }
  return data.id
}

/** Retire une permission d'un Shared Drive (best-effort, nettoyage fin de run). */
export async function removeSharedDrivePermission(
  sharedDriveId: string,
  permissionId: string,
): Promise<void> {
  const token = await driveToken()
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sharedDriveId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true&useDomainAdminAccess=true`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok && res.status !== 404) {
    const err = await res.text()
    console.warn(`[sharepoint] removeSharedDrivePermission ${permissionId} échoué (${res.status}): ${err.slice(0, 150)}`)
  }
}

/**
 * Recherche les Shared Drives (Drives partagés) du domaine par nom.
 * Les Shared Drives sont créés MANUELLEMENT par l'admin ; l'app ne fait que les
 * retrouver pour sélection. `useDomainAdminAccess=true` → l'admin voit tous les
 * Drives partagés du domaine (et pas seulement ceux dont il est membre).
 * `q` vide → liste les premiers Drives.
 */
export async function searchSharedDrives(query: string | null): Promise<Array<{ id: string; name: string }>> {
  const token = await driveToken()
  const params = new URLSearchParams({
    useDomainAdminAccess: 'true',
    pageSize: '100',
    fields: 'drives(id,name)',
  })
  if (query && query.trim()) {
    // Échappe les apostrophes pour la syntaxe q de l'API Drive
    const safe = query.trim().replace(/'/g, "\\'")
    params.set('q', `name contains '${safe}'`)
  }
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/drives?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Recherche Shared Drives échouée (${res.status}): ${err.slice(0, 400)}`)
  }
  const data = (await res.json()) as { drives?: Array<{ id: string; name: string }> }
  return data.drives ?? []
}

/** Vérifie qu'un Shared Drive existe (par id) et retourne son nom, ou null. */
export async function getSharedDrive(driveId: string): Promise<{ id: string; name: string } | null> {
  const token = await driveToken()
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/drives/${encodeURIComponent(driveId)}?useDomainAdminAccess=true&fields=id,name`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status === 404) return null
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Lecture Shared Drive échouée (${res.status}): ${err.slice(0, 300)}`)
  }
  return (await res.json()) as { id: string; name: string }
}

/**
 * Crée un dossier dans un Shared Drive sous `parentId` et retourne son id.
 * `parentId` peut être l'id du Shared Drive (racine) ou d'un dossier.
 */
/**
 * Métadonnées d'origine à réinjecter sur l'objet Google.
 * - `createdTime` / `modifiedTime` : dates SharePoint (RFC 3339), inscriptibles à
 *   la création côté Drive → préserve les vraies dates au lieu de « maintenant ».
 * - `appProperties` : traçabilité de l'auteur d'origine SharePoint. Le « Modifié
 *   par » NATIF de Drive reste le compte de migration (limite Drive : dans un
 *   Shared Drive on ne peut pas falsifier l'acteur), d'où le repli en propriété.
 */
export interface ItemMeta {
  createdTime?: string | null
  modifiedTime?: string | null
  appProperties?: Record<string, string>
}

/** Ajoute les champs de métadonnées non vides à un corps de requête Drive. */
function withMeta(base: Record<string, unknown>, meta?: ItemMeta): Record<string, unknown> {
  if (meta?.createdTime) base['createdTime'] = meta.createdTime
  if (meta?.modifiedTime) base['modifiedTime'] = meta.modifiedTime
  if (meta?.appProperties && Object.keys(meta.appProperties).length > 0) {
    base['appProperties'] = meta.appProperties
  }
  return base
}

export async function createFolder(name: string, parentId: string, meta?: ItemMeta): Promise<string> {
  const token = await driveToken()
  const res = await fetchWithTimeout(
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        withMeta({ name, mimeType: FOLDER_MIME, parents: [parentId] }, meta),
      ),
    },
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Création dossier "${name}" échouée (${res.status}): ${err.slice(0, 300)}`)
  }
  const data = (await res.json()) as { id: string }
  return data.id
}

/**
 * Upload résumable d'un fichier (Buffer) vers un Shared Drive, avec métadonnées
 * d'origine. Le Buffer est rejouable par undici → robuste aux retries de
 * connexion (contrairement à un flux à usage unique).
 *
 * `impersonate` : si fourni, l'upload se fait EN TANT QUE cet utilisateur (token
 * DwD) → Google l'enregistre comme « modifié par ». Sinon, compte admin.
 * Prérequis : l'utilisateur usurpé doit être membre du Shared Drive.
 */
export async function uploadFile(params: {
  name: string
  parentId: string
  body: Buffer
  mimeType?: string
  meta?: ItemMeta
  impersonate?: string
}): Promise<string> {
  const token = params.impersonate ? await impersonatedToken(params.impersonate) : await driveToken()

  // 1) Ouvrir une session résumable (metadata + dates d'origine)
  const initRes = await fetchWithTimeout(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(
        withMeta({ name: params.name, parents: [params.parentId] }, params.meta),
      ),
    },
  )
  if (!initRes.ok) {
    const err = await initRes.text()
    throw new Error(`Init upload "${params.name}" échoué (${initRes.status}): ${err.slice(0, 300)}`)
  }
  const sessionUri = initRes.headers.get('Location')
  if (!sessionUri) throw new Error(`Pas de session URI résumable pour "${params.name}"`)

  // 2) Transférer le contenu (Buffer → un seul PUT).
  const putRes = await fetchWithTimeout(sessionUri, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': params.mimeType ?? 'application/octet-stream',
      'Content-Length': String(params.body.byteLength),
    },
    body: params.body,
    timeoutMs: 600_000,
  })
  if (!putRes.ok) {
    const err = await putRes.text()
    throw new Error(`Upload "${params.name}" échoué (${putRes.status}): ${err.slice(0, 300)}`)
  }
  const data = (await putRes.json()) as { id: string }

  // Filet de sécurité : si la finalisation du contenu a repoussé modifiedTime à
  // « maintenant », on le réimpose par un PATCH. Best-effort (le contenu est déjà
  // en place ; on ne fait pas échouer le fichier pour une date).
  if (params.meta?.modifiedTime) {
    try {
      const patchRes = await fetchWithTimeout(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(data.id)}?supportsAllDrives=true&fields=id`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ modifiedTime: params.meta.modifiedTime }),
        },
      )
      if (!patchRes.ok) {
        console.warn(
          `[sharepoint] PATCH modifiedTime "${params.name}" ignoré (${patchRes.status})`,
        )
      }
    } catch (e) {
      console.warn(
        `[sharepoint] PATCH modifiedTime "${params.name}" échoué:`,
        e instanceof Error ? e.message : e,
      )
    }
  }

  return data.id
}

/**
 * Ajoute une RÉVISION (nouvelle version du contenu) à un fichier Drive existant.
 * Sert à rejouer l'historique des versions SharePoint : on crée le fichier avec la
 * version la plus ancienne (uploadFile), puis on empile chaque version suivante ici.
 * `keepRevisionForever=true` empêche Drive de purger ces révisions.
 *
 * Limite Drive : la DATE d'une révision reflète l'instant de l'upload (non
 * inscriptible) ; seul le modifiedTime global du fichier est réglable (fait par
 * l'appelant après la dernière version).
 */
export async function addRevision(params: {
  fileId: string
  body: Buffer
  mimeType?: string
  impersonate?: string
}): Promise<void> {
  const token = params.impersonate ? await impersonatedToken(params.impersonate) : await driveToken()

  // 1) Session résumable de MISE À JOUR (PATCH) du contenu
  const initRes = await fetchWithTimeout(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(params.fileId)}?uploadType=resumable&supportsAllDrives=true&keepRevisionForever=true&fields=id`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({}),
    },
  )
  if (!initRes.ok) {
    const err = await initRes.text()
    throw new Error(`Init révision ${params.fileId} échoué (${initRes.status}): ${err.slice(0, 300)}`)
  }
  const sessionUri = initRes.headers.get('Location')
  if (!sessionUri) throw new Error(`Pas de session URI résumable (révision) pour ${params.fileId}`)

  // 2) PUT du contenu de la révision
  const putRes = await fetchWithTimeout(sessionUri, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': params.mimeType ?? 'application/octet-stream',
      'Content-Length': String(params.body.byteLength),
    },
    body: params.body,
    timeoutMs: 600_000,
  })
  if (!putRes.ok) {
    const err = await putRes.text()
    throw new Error(`Révision ${params.fileId} échouée (${putRes.status}): ${err.slice(0, 300)}`)
  }
}

/** Règle le modifiedTime d'un fichier (best-effort). Utilisé après la dernière révision. */
export async function setFileModifiedTime(
  fileId: string,
  modifiedTime: string,
  impersonate?: string,
): Promise<void> {
  const token = impersonate ? await impersonatedToken(impersonate) : await driveToken()
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ modifiedTime }),
    },
  )
  if (!res.ok) {
    console.warn(`[sharepoint] setFileModifiedTime ${fileId} ignoré (${res.status})`)
  }
}
