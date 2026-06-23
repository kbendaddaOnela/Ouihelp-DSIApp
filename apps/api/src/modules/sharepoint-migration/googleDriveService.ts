// Écriture Google Drive via l'API Drive v3 (DwD, impersonation de l'admin GOH).
//
// Scope DwD requis (à autoriser dans Google Admin Console pour le service account) :
//   - https://www.googleapis.com/auth/drive
//
// On impersone GOOGLE_ADMIN_EMAIL : il devient organisateur des Shared Drives créés
// (les membres réels seront ajoutés en phase 2, mapping pnom@onela.com →
// prenom.nom@mig.onela.com). Tous les appels portent supportsAllDrives=true car la
// cible est un Drive partagé (et non un Mon Drive).

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

// Au-delà de ce seuil on streame (duplex) au lieu de bufferiser, pour ne pas
// saturer la mémoire du conteneur. En deçà on bufferise : un Buffer est rejouable
// par undici (évite « Response body object should not be disturbed or locked »
// quand la connexion résumable doit retenter), ce que ne permet pas un flux.
const MAX_BUFFER_BYTES = 200 * 1024 * 1024 // 200 Mo

/**
 * Upload résumable d'un fichier vers un Shared Drive, avec métadonnées d'origine.
 * Fichiers ≤ 200 Mo → bufferisés (robuste). Au-delà → streamés.
 */
export async function uploadFile(params: {
  name: string
  parentId: string
  body: ReadableStream<Uint8Array>
  size: number | null
  mimeType?: string
  meta?: ItemMeta
}): Promise<string> {
  const token = await driveToken()

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

  // 2) Transférer le contenu.
  let putBody: ReadableStream<Uint8Array> | Buffer
  const putHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': params.mimeType ?? 'application/octet-stream',
  }
  let size = params.size

  if (size != null && size > MAX_BUFFER_BYTES) {
    // Gros fichier : streaming direct (duplex half)
    putHeaders['Content-Length'] = String(size)
    putBody = params.body
  } else {
    // Cas courant : bufferiser (rejouable, robuste face aux retries)
    const buf = Buffer.from(await new Response(params.body).arrayBuffer())
    size = buf.byteLength
    putHeaders['Content-Length'] = String(size)
    putBody = buf
  }

  const putRes = await fetchWithTimeout(sessionUri, {
    method: 'PUT',
    headers: putHeaders,
    body: putBody,
    timeoutMs: 600_000,
    // duplex requis par Node pour un body en streaming
    duplex: 'half',
  } as Parameters<typeof fetchWithTimeout>[1])
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
