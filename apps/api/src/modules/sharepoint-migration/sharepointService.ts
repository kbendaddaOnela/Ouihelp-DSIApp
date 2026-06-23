// Lecture SharePoint via Microsoft Graph (App-only, tenant ONELA).
//
// Permissions Graph requises sur l'app ONELA (app-only) :
//   - Sites.Read.All
//   - Files.Read.All
//
// On réutilise le même token app-only que le reste du module migration
// (getOnelaToken). Pas de SDK Graph : appels REST directs comme partout ailleurs.

import { fetchWithTimeout } from '../migration/httpClient'
import { getOnelaToken } from '../migration/service'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

export interface SpSite {
  id: string
  name: string
  displayName: string | null
  webUrl: string | null
}

export interface SpDrive {
  id: string
  name: string
  driveType: string | null
  webUrl: string | null
}

export interface SpItem {
  id: string
  name: string
  isFolder: boolean
  size: number | null
  childCount: number | null
  webUrl: string | null
  /** URL de téléchargement pré-authentifiée (fichiers uniquement, courte durée) */
  downloadUrl: string | null
  /** Métadonnées d'origine SharePoint (réinjectées côté Google Drive) */
  createdDateTime: string | null
  lastModifiedDateTime: string | null
  createdByName: string | null
  lastModifiedByName: string | null
}

// Champs demandés au listage : décider dossier/fichier + métadonnées d'origine
const ITEM_SELECT =
  'id,name,size,webUrl,folder,file,parentReference,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy'
const ITEM_EXPAND = ''

interface GraphIdentitySet {
  user?: { displayName?: string; email?: string }
  application?: { displayName?: string }
}

interface GraphDriveItemRaw {
  id: string
  name?: string
  size?: number
  webUrl?: string
  folder?: { childCount?: number }
  file?: { mimeType?: string }
  ['@microsoft.graph.downloadUrl']?: string
  createdDateTime?: string
  lastModifiedDateTime?: string
  createdBy?: GraphIdentitySet
  lastModifiedBy?: GraphIdentitySet
}

/** Extrait un nom lisible d'un IdentitySet (user d'abord, sinon application). */
function identityName(id: GraphIdentitySet | undefined): string | null {
  return id?.user?.displayName ?? id?.application?.displayName ?? null
}

/** Fetch Graph avec retry sur throttling transitoire (429/503/504). */
async function graphFetchWithRetry(url: string, token: string, label: string): Promise<Response> {
  const RETRYABLE = new Set([429, 503, 504])
  const MAX_ATTEMPTS = 5
  let delay = 1500
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok || res.status === 404) return res
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) return res
    const retryAfter = res.headers.get('Retry-After')
    const waitMs = retryAfter ? Math.max(parseInt(retryAfter, 10) * 1000, 1000) : delay
    console.warn(`[sharepoint] ${label} ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${waitMs}ms`)
    await new Promise((r) => setTimeout(r, waitMs))
    delay = Math.min(delay * 2, 16_000)
  }
  // Inatteignable, mais TS l'exige
  throw new Error(`[sharepoint] ${label} : échec après ${MAX_ATTEMPTS} tentatives`)
}

function mapItem(raw: GraphDriveItemRaw): SpItem {
  return {
    id: raw.id,
    name: raw.name ?? '(sans nom)',
    isFolder: !!raw.folder,
    size: typeof raw.size === 'number' ? raw.size : null,
    childCount: raw.folder?.childCount ?? null,
    webUrl: raw.webUrl ?? null,
    downloadUrl: raw['@microsoft.graph.downloadUrl'] ?? null,
    createdDateTime: raw.createdDateTime ?? null,
    lastModifiedDateTime: raw.lastModifiedDateTime ?? null,
    createdByName: identityName(raw.createdBy),
    lastModifiedByName: identityName(raw.lastModifiedBy),
  }
}

/**
 * Résout une URL de site SharePoint en site Graph + liste de ses drives.
 * Accepte une URL type https://onela.sharepoint.com/sites/RH (avec ou sans
 * sous-chemin /Documents%20partages/...). On ne garde que hostname + /sites/<nom>.
 */
export async function resolveSiteByUrl(rawUrl: string): Promise<{ site: SpSite; drives: SpDrive[] }> {
  const token = await getOnelaToken()
  const u = new URL(rawUrl.trim())
  const hostname = u.hostname

  // Conserver uniquement le segment de site : /sites/<nom> ou /teams/<nom>, sinon racine
  const segments = u.pathname.split('/').filter(Boolean)
  let sitePath = ''
  if ((segments[0] === 'sites' || segments[0] === 'teams') && segments[1]) {
    sitePath = `/${segments[0]}/${segments[1]}`
  }

  const sitePathEncoded = sitePath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
  const siteRef = sitePath
    ? `${hostname}:${sitePathEncoded}`
    : hostname

  const siteRes = await graphFetchWithRetry(
    `${GRAPH_BASE}/sites/${siteRef}?$select=id,name,displayName,webUrl`,
    token,
    `resolveSite ${siteRef}`,
  )
  if (siteRes.status === 404) {
    throw new Error(`Site SharePoint introuvable pour l'URL fournie (${siteRef}). Vérifie l'URL.`)
  }
  if (!siteRes.ok) {
    const err = await siteRes.text()
    throw new Error(`Graph resolveSite ${siteRes.status}: ${err.slice(0, 400)}`)
  }
  const siteRaw = (await siteRes.json()) as {
    id: string
    name?: string
    displayName?: string
    webUrl?: string
  }
  const site: SpSite = {
    id: siteRaw.id,
    name: siteRaw.name ?? siteRaw.displayName ?? '(site)',
    displayName: siteRaw.displayName ?? null,
    webUrl: siteRaw.webUrl ?? null,
  }

  const drives = await listSiteDrives(site.id, token)
  return { site, drives }
}

/** Liste les bibliothèques de documents (drives) d'un site. */
export async function listSiteDrives(siteId: string, tokenOverride?: string): Promise<SpDrive[]> {
  const token = tokenOverride ?? (await getOnelaToken())
  const res = await graphFetchWithRetry(
    `${GRAPH_BASE}/sites/${encodeURIComponent(siteId)}/drives?$select=id,name,driveType,webUrl`,
    token,
    `listSiteDrives ${siteId}`,
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph listSiteDrives ${res.status}: ${err.slice(0, 400)}`)
  }
  const data = (await res.json()) as {
    value: Array<{ id: string; name?: string; driveType?: string; webUrl?: string }>
  }
  return data.value.map((d) => ({
    id: d.id,
    name: d.name ?? '(bibliothèque)',
    driveType: d.driveType ?? null,
    webUrl: d.webUrl ?? null,
  }))
}

/**
 * Liste les enfants directs d'un dossier d'un drive.
 * `itemId = null` → racine du drive. Gère la pagination (@odata.nextLink).
 */
export async function listChildren(
  driveId: string,
  itemId: string | null,
): Promise<SpItem[]> {
  const token = await getOnelaToken()
  const base = itemId
    ? `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`
    : `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/root/children`
  let url: string | null = `${base}?$select=${ITEM_SELECT}&$top=200${ITEM_EXPAND}`
  const out: SpItem[] = []
  while (url) {
    const res = await graphFetchWithRetry(url, token, `listChildren ${itemId ?? 'root'}`)
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Graph listChildren ${res.status}: ${err.slice(0, 400)}`)
    }
    const data = (await res.json()) as {
      value: GraphDriveItemRaw[]
      ['@odata.nextLink']?: string
    }
    for (const raw of data.value) out.push(mapItem(raw))
    url = data['@odata.nextLink'] ?? null
  }
  return out
}

/**
 * Ouvre un flux de lecture sur le contenu d'un fichier SharePoint via l'endpoint
 * `/content` de Graph. Celui-ci renvoie un 302 vers une URL de stockage
 * pré-authentifiée ; `fetch` suit la redirection automatiquement.
 *
 * Note : undici ne propage PAS l'en-tête Authorization à travers une redirection
 * cross-origin, ce qui est exactement le comportement voulu (l'URL de stockage
 * porte déjà son propre jeton dans la query). On ne demande donc surtout PAS
 * l'annotation @microsoft.graph.downloadUrl via $select : elle est retirée par
 * Graph dès qu'un $select est présent.
 *
 * Retourne le corps (ReadableStream) + la taille (Content-Length) pour l'upload.
 */
export async function openItemContentStream(
  driveId: string,
  itemId: string,
): Promise<{ body: ReadableStream<Uint8Array>; size: number | null }> {
  const token = await getOnelaToken()
  const res = await fetchWithTimeout(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
    { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 600_000 },
  )
  if (!res.ok || !res.body) {
    const err = res.ok ? 'corps vide' : await res.text()
    throw new Error(`Téléchargement SharePoint échoué (${res.status}): ${String(err).slice(0, 200)}`)
  }
  const len = res.headers.get('Content-Length')
  return { body: res.body, size: len ? parseInt(len, 10) : null }
}
