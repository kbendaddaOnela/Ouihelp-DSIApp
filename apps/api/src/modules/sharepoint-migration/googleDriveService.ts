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

/**
 * Google Drive throttle par utilisateur : 403 `userRateLimitExceeded` /
 * `rateLimitExceeded`, 429, et 5xx transitoires. Sans retry, une migration de
 * plusieurs dizaines de milliers de fichiers accumule les échecs.
 * Backoff exponentiel + jitter (le jitter évite que les N transferts parallèles
 * ne retentent tous en même temps).
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 6

function isRateLimited(status: number, body: string): boolean {
  if (RETRYABLE_STATUS.has(status)) return true
  // 403 est ambigu : throttling OU permission refusée. On ne retente que le 1er cas.
  return status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body)
}

/**
 * Exécute un appel Google avec retry sur throttling. `run` doit être REJOUABLE
 * (corps en Buffer, pas un flux à usage unique).
 */
async function googleFetchWithRetry(
  run: () => Promise<Response>,
  label: string,
): Promise<Response> {
  let delay = 2000
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response
    try {
      res = await run()
    } catch (e) {
      // Idem côté Google : un timeout lève, il n'a pas de statut à tester.
      if (attempt === MAX_ATTEMPTS) throw e
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[sharepoint] ${label} échec réseau (${msg}) — retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 60_000)
      continue
    }
    if (res.ok || res.status === 308 || res.status === 404) return res
    // On doit lire le corps pour distinguer throttling / vraie erreur : on
    // renvoie donc une copie exploitable par l'appelant.
    const body = await res.text()
    if (!isRateLimited(res.status, body) || attempt === MAX_ATTEMPTS) {
      return new Response(body, { status: res.status, headers: res.headers })
    }
    const retryAfter = res.headers.get('Retry-After')
    const jitter = Math.floor(Math.random() * 1000)
    const waitMs = retryAfter ? Math.max(parseInt(retryAfter, 10) * 1000, 1000) : delay + jitter
    console.warn(
      `[sharepoint] Google throttle (${res.status}) sur ${label} — retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${waitMs}ms`,
    )
    await new Promise((r) => setTimeout(r, waitMs))
    delay = Math.min(delay * 2, 60_000)
  }
  throw new Error(`[sharepoint] ${label} : échec après ${MAX_ATTEMPTS} tentatives`)
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
  const res = await googleFetchWithRetry(
    () =>
      fetchWithTimeout('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(withMeta({ name, mimeType: FOLDER_MIME, parents: [parentId] }, meta)),
      }),
    `création dossier "${name}"`,
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
  const initRes = await googleFetchWithRetry(
    () =>
      fetchWithTimeout(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
          },
          body: JSON.stringify(withMeta({ name: params.name, parents: [params.parentId] }, params.meta)),
        },
      ),
    `init upload "${params.name}"`,
  )
  if (!initRes.ok) {
    const err = await initRes.text()
    throw new Error(`Init upload "${params.name}" échoué (${initRes.status}): ${err.slice(0, 300)}`)
  }
  const sessionUri = initRes.headers.get('Location')
  if (!sessionUri) throw new Error(`Pas de session URI résumable pour "${params.name}"`)

  // 2) Transférer le contenu (Buffer → un seul PUT).
  const putRes = await googleFetchWithRetry(
    () =>
      fetchWithTimeout(sessionUri, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': params.mimeType ?? 'application/octet-stream',
          'Content-Length': String(params.body.byteLength),
        },
        body: params.body,
        timeoutMs: 600_000,
      }),
    `upload "${params.name}"`,
  )
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
  const putRes = await googleFetchWithRetry(
    () =>
      fetchWithTimeout(sessionUri, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': params.mimeType ?? 'application/octet-stream',
          'Content-Length': String(params.body.byteLength),
        },
        body: params.body,
        timeoutMs: 600_000,
      }),
    `révision ${params.fileId}`,
  )
  if (!putRes.ok) {
    const err = await putRes.text()
    throw new Error(`Révision ${params.fileId} échouée (${putRes.status}): ${err.slice(0, 300)}`)
  }
}

/**
 * Taille d'un morceau d'upload résumable. DOIT être un multiple de 256 Ko
 * (contrainte Google) sauf pour le dernier morceau. 16 Mo = 64 × 256 Ko.
 */
const CHUNK_SIZE = 16 * 1024 * 1024

/**
 * Pousse un flux vers une session résumable, morceau par morceau.
 *
 * Mémoire consommée ≈ CHUNK_SIZE, quelle que soit la taille du fichier → permet
 * de transférer des fichiers de plusieurs Go sans faire exploser le conteneur.
 * Google répond 308 (Resume Incomplete) sur les morceaux intermédiaires et
 * 200/201 sur le dernier.
 */
async function pushStreamInChunks(params: {
  sessionUri: string
  token: string
  stream: ReadableStream<Uint8Array>
  totalSize: number
  mimeType: string
  label: string
}): Promise<{ id: string }> {
  const { sessionUri, token, stream, totalSize, mimeType, label } = params
  const reader = stream.getReader()
  // ⚠️ Accumulation par LISTE, pas par Buffer.concat successifs : concaténer à
  // chaque morceau lu (~64 Ko) pour remplir 16 Mo recopie tout le tampon à
  // chaque tour → O(n²) et event loop bloqué. Ici, une seule concat par chunk.
  let parts: Uint8Array[] = []
  let pendingLen = 0
  let offset = 0
  let finalBody: { id: string } | null = null

  const putChunk = async (chunk: Buffer, isFinal: boolean): Promise<void> => {
    const start = offset
    const end = offset + chunk.byteLength - 1
    // Le chunk est un Buffer → rejouable, donc éligible au retry sur throttling.
    const res = await googleFetchWithRetry(
      () =>
        fetchWithTimeout(sessionUri, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': mimeType,
            'Content-Length': String(chunk.byteLength),
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          },
          body: chunk,
          timeoutMs: 900_000,
        }),
      `chunk ${label} @${start}`,
    )
    // 308 = morceau accepté, la suite est attendue (fetch le considère non-ok)
    if (res.status === 308) {
      offset += chunk.byteLength
      return
    }
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Upload par morceaux "${label}" échoué (${res.status}): ${err.slice(0, 300)}`)
    }
    finalBody = (await res.json()) as { id: string }
    offset += chunk.byteLength
    if (!isFinal) {
      throw new Error(`Upload "${label}" terminé prématurément par Google à l'octet ${offset}`)
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (value && value.byteLength > 0) {
      parts.push(value)
      pendingLen += value.byteLength
    }
    // Envoi des morceaux pleins ; le reliquat part au dernier tour
    while (pendingLen >= CHUNK_SIZE) {
      const merged = Buffer.concat(parts, pendingLen)
      const chunk = merged.subarray(0, CHUNK_SIZE)
      const rest = merged.subarray(CHUNK_SIZE)
      parts = rest.byteLength > 0 ? [rest] : []
      pendingLen = rest.byteLength
      await putChunk(chunk, false)
    }
    if (done) {
      if (pendingLen > 0) {
        await putChunk(Buffer.concat(parts, pendingLen), true)
        parts = []
        pendingLen = 0
      }
      break
    }
  }

  if (offset !== totalSize) {
    throw new Error(
      `Upload "${label}" incomplet : ${offset} octets envoyés sur ${totalSize} annoncés`,
    )
  }
  if (!finalBody) throw new Error(`Upload "${label}" : pas de réponse finale de Google`)
  return finalBody
}

/**
 * Upload d'un gros fichier EN FLUX (mémoire constante) vers un Shared Drive.
 * Même sémantique qu'uploadFile (métadonnées, impersonation), mais sans jamais
 * charger le contenu entier en RAM.
 */
export async function uploadFileStreamed(params: {
  name: string
  parentId: string
  /**
   * Ouvre le flux source. ⚠️ Appelé APRÈS l'init de session résumable : un flux
   * ouvert trop tôt reste inactif pendant les allers-retours d'authentification
   * et le serveur de stockage le ferme → lecture vide (« 0 octets envoyés »).
   */
  openStream: () => Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }>
  size: number
  mimeType?: string
  meta?: ItemMeta
  impersonate?: string
}): Promise<string> {
  const token = params.impersonate ? await impersonatedToken(params.impersonate) : await driveToken()
  const initRes = await googleFetchWithRetry(
    () =>
      fetchWithTimeout(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
          },
          body: JSON.stringify(withMeta({ name: params.name, parents: [params.parentId] }, params.meta)),
        },
      ),
    `init upload "${params.name}"`,
  )
  if (!initRes.ok) {
    const err = await initRes.text()
    throw new Error(`Init upload "${params.name}" échoué (${initRes.status}): ${err.slice(0, 300)}`)
  }
  const sessionUri = initRes.headers.get('Location')
  if (!sessionUri) throw new Error(`Pas de session URI résumable pour "${params.name}"`)

  // Flux ouvert seulement maintenant : la session est prête, on enchaîne direct.
  const opened = await params.openStream()
  const { id } = await pushStreamInChunks({
    sessionUri,
    token,
    stream: opened.stream,
    totalSize: opened.size ?? params.size,
    mimeType: params.mimeType ?? 'application/octet-stream',
    label: params.name,
  })

  if (params.meta?.modifiedTime) {
    await setFileModifiedTime(id, params.meta.modifiedTime, params.impersonate).catch(() => {})
  }
  return id
}

/** Ajoute une révision EN FLUX à un fichier existant (gros fichiers). */
export async function addRevisionStreamed(params: {
  fileId: string
  /** Ouvre le flux source — appelé après l'init de session (cf. uploadFileStreamed). */
  openStream: () => Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }>
  size: number
  mimeType?: string
  impersonate?: string
}): Promise<void> {
  const token = params.impersonate ? await impersonatedToken(params.impersonate) : await driveToken()
  const initRes = await googleFetchWithRetry(
    () =>
      fetchWithTimeout(
        `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(params.fileId)}?uploadType=resumable&supportsAllDrives=true&keepRevisionForever=true&fields=id`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=UTF-8',
          },
          body: JSON.stringify({}),
        },
      ),
    `init révision ${params.fileId}`,
  )
  if (!initRes.ok) {
    const err = await initRes.text()
    throw new Error(`Init révision ${params.fileId} échoué (${initRes.status}): ${err.slice(0, 300)}`)
  }
  const sessionUri = initRes.headers.get('Location')
  if (!sessionUri) throw new Error(`Pas de session URI résumable (révision) pour ${params.fileId}`)

  const opened = await params.openStream()
  await pushStreamInChunks({
    sessionUri,
    token,
    stream: opened.stream,
    totalSize: opened.size ?? params.size,
    mimeType: params.mimeType ?? 'application/octet-stream',
    label: `révision ${params.fileId}`,
  })
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
