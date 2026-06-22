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
export async function createFolder(name: string, parentId: string): Promise<string> {
  const token = await driveToken()
  const res = await fetchWithTimeout(
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      }),
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
 * Upload résumable d'un fichier vers un Shared Drive.
 * Streaming : le corps SharePoint est repassé tel quel à Google (pas de buffer
 * complet en mémoire → supporte les gros fichiers). Content-Length connu requis
 * pour le PUT mono-requête ; si la taille est inconnue on bufferise en dernier
 * recours.
 */
export async function uploadFile(params: {
  name: string
  parentId: string
  body: ReadableStream<Uint8Array>
  size: number | null
  mimeType?: string
}): Promise<string> {
  const token = await driveToken()

  // 1) Ouvrir une session résumable (metadata only)
  const initRes = await fetchWithTimeout(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        name: params.name,
        parents: [params.parentId],
      }),
    },
  )
  if (!initRes.ok) {
    const err = await initRes.text()
    throw new Error(`Init upload "${params.name}" échoué (${initRes.status}): ${err.slice(0, 300)}`)
  }
  const sessionUri = initRes.headers.get('Location')
  if (!sessionUri) throw new Error(`Pas de session URI résumable pour "${params.name}"`)

  // 2) Transférer le contenu. Avec une taille connue → stream direct (duplex half).
  let putBody: ReadableStream<Uint8Array> | Buffer
  const putHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': params.mimeType ?? 'application/octet-stream',
  }
  let size = params.size

  if (size != null && size >= 0) {
    putHeaders['Content-Length'] = String(size)
    putBody = params.body
  } else {
    // Taille inconnue : bufferiser (rare — fichiers SharePoint exposent size)
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
  return data.id
}
