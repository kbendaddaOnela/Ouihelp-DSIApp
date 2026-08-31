// Accès Microsoft Graph BI-TENANT pour la migration SharePoint Ximi.
//
// Contrairement au module `sharepoint-migration` (lecture ONELA + écriture
// Google), on lit ET on écrit dans Graph, mais sur DEUX tenants différents.
// Toutes les fonctions prennent donc explicitement leur fournisseur de jeton
// (`SOURCE` = ONELA lecture, `TARGET` = Ouihelp lecture/écriture) : c'est le
// seul garde-fou fiable contre l'erreur qui coûterait le plus cher ici — écrire
// dans le mauvais tenant.
//
// Permissions Graph app-only requises :
//   - app ONELA  : Sites.Read.All, Files.Read.All
//   - app Ouihelp: Sites.ReadWrite.All (+ Group.Read.All pour résoudre les
//     groupes dynamiques d'agence par nom)

import { fetchWithTimeout } from '../migration/httpClient'
import { getAccessToken, getOnelaToken } from '../migration/service'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/** Options d'un appel Graph — alignées sur `fetchWithTimeout` (accepte un Buffer). */
type GraphInit = NonNullable<Parameters<typeof fetchWithTimeout>[1]>

/** Jeton app-only du tenant Ouihelp (même app que le reste du module GOH). */
export async function getOuihelpToken(): Promise<string> {
  const tid = process.env['AZURE_TENANT_ID']
  const cid = process.env['AZURE_CLIENT_ID']
  const sec = process.env['AZURE_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('Credentials Graph Ouihelp (AZURE_*) manquantes')
  return getAccessToken(tid, cid, sec)
}

/** Fournisseur de jeton — rend le tenant explicite à chaque appel. */
export type TokenProvider = () => Promise<string>

export const SOURCE: TokenProvider = getOnelaToken
export const TARGET: TokenProvider = getOuihelpToken

// ── Client HTTP Graph avec retry ──────────────────────────────────────────────

const RETRYABLE = new Set([429, 502, 503, 504])
const MAX_ATTEMPTS = 5

/**
 * Fetch Graph avec retry sur throttling ET sur coupure réseau.
 *
 * Le rattrapage de l'EXCEPTION (et pas seulement du statut) est délibéré : un
 * timeout ne porte aucun statut HTTP, donc un retry par statut seul le laisse
 * remonter et tuer toute la migration. C'est exactement le bug corrigé en
 * août 2026 sur le module Drive — ne pas le réintroduire ici.
 */
export async function graphFetch(
  url: string,
  token: TokenProvider,
  label: string,
  init?: GraphInit,
): Promise<Response> {
  let delay = 1500
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response
    try {
      const bearer = await token()
      res = await fetchWithTimeout(url, {
        ...init,
        headers: { Authorization: `Bearer ${bearer}`, ...(init?.headers ?? {}) },
      })
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) throw e
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[ximi] ${label} échec réseau (${msg}) — retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 16_000)
      continue
    }
    if (res.ok || res.status === 404) return res
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) return res
    const retryAfter = res.headers.get('Retry-After')
    const waitMs = retryAfter ? Math.max(parseInt(retryAfter, 10) * 1000, 1000) : delay
    console.warn(`[ximi] ${label} ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${waitMs}ms`)
    await new Promise((r) => setTimeout(r, waitMs))
    delay = Math.min(delay * 2, 16_000)
  }
  throw new Error(`[ximi] ${label} : échec après ${MAX_ATTEMPTS} tentatives`)
}

async function graphJson<T>(
  url: string,
  token: TokenProvider,
  label: string,
  init?: GraphInit,
): Promise<T> {
  const res = await graphFetch(url, token, label, init)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph ${label} ${res.status}: ${err.slice(0, 400)}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ── Sites ─────────────────────────────────────────────────────────────────────

export interface SiteInfo {
  id: string
  name: string
  displayName: string | null
  webUrl: string | null
}

interface RawSite {
  id: string
  name?: string
  displayName?: string
  webUrl?: string
  isPersonalSite?: boolean
}

function mapSite(s: RawSite): SiteInfo {
  return {
    id: s.id,
    name: s.name ?? s.displayName ?? '(site)',
    displayName: s.displayName ?? null,
    webUrl: s.webUrl ?? null,
  }
}

/**
 * Énumère TOUS les sites d'un tenant.
 *
 * `GET /sites?search=*` est la seule requête v1.0 qui pagine l'ensemble des
 * sites en app-only. Les OneDrive personnels (`isPersonalSite`) et les sites
 * système sont écartés : ils polluent la liste des agences.
 */
export async function listAllSites(token: TokenProvider): Promise<SiteInfo[]> {
  let url: string | null =
    `${GRAPH_BASE}/sites?search=*&$select=id,name,displayName,webUrl,isPersonalSite&$top=200`
  const out: SiteInfo[] = []
  const seen = new Set<string>()
  while (url) {
    const data: { value: RawSite[]; ['@odata.nextLink']?: string } = await graphJson(
      url,
      token,
      'listAllSites',
    )
    for (const s of data.value) {
      if (s.isPersonalSite) continue
      if (!s.webUrl || !/\/sites\//i.test(s.webUrl)) continue // exclut la racine et /portals
      if (seen.has(s.id)) continue
      seen.add(s.id)
      out.push(mapSite(s))
    }
    url = data['@odata.nextLink'] ?? null
  }
  out.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name, 'fr'))
  return out
}

/** Résout un site par son URL complète (https://host/sites/alias). */
export async function resolveSiteByUrl(rawUrl: string, token: TokenProvider): Promise<SiteInfo> {
  const u = new URL(rawUrl.trim())
  const segments = u.pathname.split('/').filter(Boolean)
  let sitePath = ''
  if ((segments[0] === 'sites' || segments[0] === 'teams') && segments[1]) {
    sitePath = `/${segments[0]}/${encodeURIComponent(segments[1])}`
  }
  const siteRef = sitePath ? `${u.hostname}:${sitePath}` : u.hostname
  const res = await graphFetch(
    `${GRAPH_BASE}/sites/${siteRef}?$select=id,name,displayName,webUrl`,
    token,
    `resolveSite ${siteRef}`,
  )
  if (res.status === 404) throw new Error(`Site SharePoint introuvable : ${rawUrl}`)
  if (!res.ok) throw new Error(`Graph resolveSite ${res.status}: ${(await res.text()).slice(0, 400)}`)
  return mapSite((await res.json()) as RawSite)
}

export interface DriveInfo {
  id: string
  name: string
  driveType: string | null
  webUrl: string | null
}

export async function listSiteDrives(siteId: string, token: TokenProvider): Promise<DriveInfo[]> {
  const data = await graphJson<{ value: Array<{ id: string; name?: string; driveType?: string; webUrl?: string }> }>(
    `${GRAPH_BASE}/sites/${encodeURIComponent(siteId)}/drives?$select=id,name,driveType,webUrl`,
    token,
    `listSiteDrives ${siteId}`,
  )
  return data.value.map((d) => ({
    id: d.id,
    name: d.name ?? '(bibliothèque)',
    driveType: d.driveType ?? null,
    webUrl: d.webUrl ?? null,
  }))
}

/** Bibliothèque de documents par défaut d'un site (`/drive`). */
export async function getDefaultDrive(siteId: string, token: TokenProvider): Promise<DriveInfo> {
  const d = await graphJson<{ id: string; name?: string; driveType?: string; webUrl?: string }>(
    `${GRAPH_BASE}/sites/${encodeURIComponent(siteId)}/drive?$select=id,name,driveType,webUrl`,
    token,
    `getDefaultDrive ${siteId}`,
  )
  return {
    id: d.id,
    name: d.name ?? 'Documents',
    driveType: d.driveType ?? null,
    webUrl: d.webUrl ?? null,
  }
}

// ── Groupes (tenant Ouihelp) ──────────────────────────────────────────────────

export interface GroupInfo {
  id: string
  displayName: string
  mail: string | null
  dynamic: boolean
}

interface RawGroup {
  id: string
  displayName?: string
  mail?: string
  membershipRule?: string | null
  groupTypes?: string[]
}

function mapGroup(g: RawGroup): GroupInfo {
  return {
    id: g.id,
    displayName: g.displayName ?? '(groupe)',
    mail: g.mail ?? null,
    dynamic: !!g.membershipRule || (g.groupTypes ?? []).includes('DynamicMembership'),
  }
}

/** Recherche de groupes par préfixe de nom sur le tenant Ouihelp. */
export async function searchTargetGroups(query: string): Promise<GroupInfo[]> {
  const q = query.trim()
  const select = 'id,displayName,mail,membershipRule,groupTypes'
  const url = q
    ? `${GRAPH_BASE}/groups?$filter=${encodeURIComponent(`startsWith(displayName,'${q.replace(/'/g, "''")}')`)}&$select=${select}&$top=50`
    : `${GRAPH_BASE}/groups?$select=${select}&$top=50`
  const data = await graphJson<{ value: RawGroup[] }>(url, TARGET, 'searchTargetGroups')
  return data.value.map(mapGroup)
}

/** Résout un groupe par nom EXACT (utilisé par le worker). */
export async function findGroupByExactName(name: string): Promise<GroupInfo | null> {
  const filter = `displayName eq '${name.replace(/'/g, "''")}'`
  const data = await graphJson<{ value: RawGroup[] }>(
    `${GRAPH_BASE}/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,membershipRule,groupTypes&$top=2`,
    TARGET,
    `findGroupByExactName ${name}`,
  )
  const first = data.value[0]
  return first ? mapGroup(first) : null
}

// ── driveItems ────────────────────────────────────────────────────────────────

export interface DeltaItem {
  id: string
  name: string
  isFolder: boolean
  isRoot: boolean
  /** true = l'item a été supprimé côté source depuis la dernière passe */
  deleted: boolean
  size: number | null
  parentId: string | null
  /** Chemin décodé du parent (« /Dossier/Sous-dossier »), '' pour la racine */
  parentPath: string
  createdDateTime: string | null
  lastModifiedDateTime: string | null
  /** eTag du contenu : change à chaque nouvelle version, PAS sur un renommage */
  cTag: string | null
}

interface RawDriveItem {
  id: string
  name?: string
  size?: number
  folder?: { childCount?: number }
  file?: { mimeType?: string }
  root?: Record<string, unknown>
  deleted?: { state?: string }
  cTag?: string
  createdDateTime?: string
  lastModifiedDateTime?: string
  parentReference?: { id?: string; path?: string; driveId?: string }
}

/**
 * Décode le chemin du parent depuis `parentReference.path`.
 * Graph renvoie « /drive/root:/Dossier/Sous%20dossier » ; on veut
 * « /Dossier/Sous dossier » (et '' à la racine).
 */
function decodeParentPath(path: string | undefined): string {
  if (!path) return ''
  const idx = path.indexOf('root:')
  const rel = idx >= 0 ? path.slice(idx + 'root:'.length) : path
  try {
    return decodeURIComponent(rel)
  } catch {
    return rel
  }
}

function mapDeltaItem(raw: RawDriveItem): DeltaItem {
  return {
    id: raw.id,
    name: raw.name ?? '(sans nom)',
    isFolder: !!raw.folder,
    isRoot: !!raw.root,
    deleted: !!raw.deleted,
    size: typeof raw.size === 'number' ? raw.size : null,
    parentId: raw.parentReference?.id ?? null,
    parentPath: decodeParentPath(raw.parentReference?.path),
    createdDateTime: raw.createdDateTime ?? null,
    lastModifiedDateTime: raw.lastModifiedDateTime ?? null,
    cTag: raw.cTag ?? null,
  }
}

const DELTA_SELECT =
  'id,name,size,folder,file,root,deleted,cTag,createdDateTime,lastModifiedDateTime,parentReference'

/**
 * Parcourt `/drives/{id}/root/delta` et renvoie les changements + le NOUVEAU
 * jeton delta.
 *
 * - `deltaToken = null` → énumération complète du drive (pré-migration) ;
 * - `deltaToken` fourni → uniquement ce qui a bougé depuis, suppressions et
 *   déplacements compris. C'est ce qui permet au module de faire ce que le
 *   module Drive ne sait pas faire.
 *
 * `onPage` est appelé à chaque page : sur une énumération complète d'un gros
 * site, tout garder en RAM avant de commencer serait à la fois lent (aucun
 * retour visuel) et coûteux en mémoire.
 */
export async function walkDelta(
  driveId: string,
  deltaToken: string | null,
  token: TokenProvider,
  onPage: (items: DeltaItem[]) => Promise<void> | void,
): Promise<{ nextDeltaToken: string | null }> {
  let url: string | null = deltaToken
    ? `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/root/delta?token=${encodeURIComponent(deltaToken)}&$select=${DELTA_SELECT}&$top=500`
    : `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/root/delta?$select=${DELTA_SELECT}&$top=500`
  let nextDeltaToken: string | null = null

  while (url) {
    const res: Response = await graphFetch(url, token, 'walkDelta', { timeoutMs: 300_000 })
    if (res.status === 410) {
      // Jeton delta périmé (resync requis) : Graph demande de repartir de zéro.
      // On ne peut PAS l'ignorer — le prochain delta manquerait des changements.
      throw new DeltaResyncRequired()
    }
    if (!res.ok) {
      throw new Error(`Graph walkDelta ${res.status}: ${(await res.text()).slice(0, 400)}`)
    }
    const data = (await res.json()) as {
      value: RawDriveItem[]
      ['@odata.nextLink']?: string
      ['@odata.deltaLink']?: string
    }
    await onPage(data.value.map(mapDeltaItem))
    const deltaLink = data['@odata.deltaLink']
    if (deltaLink) {
      nextDeltaToken = new URL(deltaLink).searchParams.get('token')
    }
    url = data['@odata.nextLink'] ?? null
  }
  return { nextDeltaToken }
}

/** Le jeton delta n'est plus valide : il faut refaire une énumération complète. */
export class DeltaResyncRequired extends Error {
  constructor() {
    super('Jeton delta périmé (410 resyncRequired) — énumération complète nécessaire')
    this.name = 'DeltaResyncRequired'
  }
}

/**
 * Télécharge le contenu courant d'un fichier (Buffer, rejouable).
 *
 * On passe par `/content` et on lit `res.arrayBuffer()` directement — surtout
 * pas `new Response(res.body)`, qui provoque « Response body object should not
 * be disturbed or locked ». Et on ne demande jamais l'annotation
 * `@microsoft.graph.downloadUrl` via $select : Graph la retire dès qu'un
 * $select est présent.
 */
export async function downloadContent(
  driveId: string,
  itemId: string,
  token: TokenProvider,
): Promise<Buffer> {
  const res = await graphFetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
    token,
    `downloadContent ${itemId}`,
    { timeoutMs: 600_000 },
  )
  if (!res.ok) {
    throw new Error(`Téléchargement source échoué (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/** Ouvre un FLUX de lecture sur le contenu courant (gros fichiers). */
export async function openContentStream(
  driveId: string,
  itemId: string,
  token: TokenProvider,
): Promise<ReadableStream<Uint8Array>> {
  const res = await graphFetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`,
    token,
    `openContentStream ${itemId}`,
    { timeoutMs: 1_800_000 },
  )
  if (!res.ok || !res.body) {
    const err = res.ok ? 'corps vide' : await res.text()
    throw new Error(`Téléchargement source échoué (${res.status}): ${String(err).slice(0, 200)}`)
  }
  return res.body
}

// ── Écriture côté cible ───────────────────────────────────────────────────────

export interface FileTimes {
  createdDateTime: string | null
  lastModifiedDateTime: string | null
}

/** `fileSystemInfo` Graph — c'est ce qui préserve les dates d'origine. */
function fileSystemInfo(times: FileTimes): Record<string, string> | undefined {
  const fs: Record<string, string> = {}
  if (times.createdDateTime) fs['createdDateTime'] = times.createdDateTime
  if (times.lastModifiedDateTime) fs['lastModifiedDateTime'] = times.lastModifiedDateTime
  return Object.keys(fs).length > 0 ? fs : undefined
}

/**
 * Crée (ou retrouve) un dossier sous un parent cible.
 *
 * `conflictBehavior: 'fail'` puis repli sur une recherche par nom : si le
 * dossier existe déjà (reprise après interruption), on veut RÉUTILISER l'existant,
 * jamais en créer un second — SharePoint refuse les doublons de nom, mais
 * `rename` en créerait un « Dossier 1 » silencieux.
 */
export async function createTargetFolder(
  driveId: string,
  parentItemId: string,
  name: string,
  times: FileTimes,
): Promise<string> {
  const body: Record<string, unknown> = {
    name,
    folder: {},
    '@microsoft.graph.conflictBehavior': 'fail',
  }
  const fs = fileSystemInfo(times)
  if (fs) body['fileSystemInfo'] = fs
  const res = await graphFetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentItemId)}/children`,
    TARGET,
    `createTargetFolder ${name}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (res.ok) return ((await res.json()) as { id: string }).id
  if (res.status === 409) {
    const existing = await findChildByName(driveId, parentItemId, name)
    if (existing) return existing
  }
  throw new Error(`Création dossier cible échouée (${res.status}): ${(await res.text()).slice(0, 300)}`)
}

/** Retrouve un enfant par nom sous un parent (reprise / conflit). */
export async function findChildByName(
  driveId: string,
  parentItemId: string,
  name: string,
): Promise<string | null> {
  const res = await graphFetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentItemId)}:/${encodeURIComponent(name)}?$select=id`,
    TARGET,
    `findChildByName ${name}`,
  )
  if (res.status === 404) return null
  if (!res.ok) return null
  return ((await res.json()) as { id: string }).id
}

/** Id du dossier racine de la bibliothèque cible. */
export async function getRootItemId(driveId: string): Promise<string> {
  const d = await graphJson<{ id: string }>(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/root?$select=id`,
    TARGET,
    'getRootItemId',
  )
  return d.id
}

/**
 * Upload « simple » (un seul PUT) — réservé aux petits fichiers.
 * Graph plafonne ce mode à 250 Mo, mais on bascule bien avant en session
 * résumable : un PUT unique n'est pas reprenable et un échec à 200 Mo coûte
 * l'intégralité du transfert.
 */
export async function uploadSmallFile(params: {
  driveId: string
  parentItemId: string
  name: string
  body: Buffer
  times: FileTimes
  /** true = remplacer le contenu d'un fichier existant (passe delta) */
  replace?: boolean
}): Promise<string> {
  const { driveId, parentItemId, name, body, times } = params
  const conflict = params.replace ? 'replace' : 'fail'
  const res = await graphFetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentItemId)}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=${conflict}`,
    TARGET,
    `uploadSmallFile ${name}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      timeoutMs: 600_000,
    },
  )
  if (!res.ok) {
    // 409 sur conflictBehavior=fail : le fichier existe déjà (reprise après
    // interruption). On récupère son id plutôt que d'en créer un doublon.
    if (res.status === 409 && !params.replace) {
      const existing = await findChildByName(driveId, parentItemId, name)
      if (existing) {
        await setFileTimes(driveId, existing, times)
        return existing
      }
    }
    throw new Error(`Upload cible échoué (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  const created = (await res.json()) as { id: string }
  await setFileTimes(driveId, created.id, times)
  return created.id
}

/**
 * Taille des morceaux d'un upload résumable. Graph EXIGE un multiple de
 * 320 Kio pour tous les morceaux sauf le dernier — un morceau mal aligné fait
 * échouer la session entière. 20 × 320 Kio = 6,25 Mio.
 */
const CHUNK_SIZE = 20 * 320 * 1024

/**
 * Upload EN FLUX via session résumable (gros fichiers, mémoire constante).
 *
 * `openStream` est une FACTORY, pas un flux : la session résumable doit être
 * créée AVANT d'ouvrir la source. Un flux Graph ouvert puis laissé inactif
 * pendant la négociation de session est fermé par le serveur de stockage — c'est
 * le bug « 0 octets envoyés sur N annoncés » du module Drive.
 */
export async function uploadLargeFile(params: {
  driveId: string
  parentItemId: string
  name: string
  size: number
  openStream: () => Promise<ReadableStream<Uint8Array>>
  times: FileTimes
  replace?: boolean
}): Promise<string> {
  const { driveId, parentItemId, name, size, openStream, times } = params
  const item: Record<string, unknown> = {
    '@microsoft.graph.conflictBehavior': params.replace ? 'replace' : 'fail',
    name,
  }
  const fs = fileSystemInfo(times)
  if (fs) item['fileSystemInfo'] = fs

  const sessionRes = await graphFetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentItemId)}:/${encodeURIComponent(name)}:/createUploadSession`,
    TARGET,
    `createUploadSession ${name}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item }),
    },
  )
  if (!sessionRes.ok) {
    if (sessionRes.status === 409 && !params.replace) {
      const existing = await findChildByName(driveId, parentItemId, name)
      if (existing) return existing
    }
    throw new Error(
      `Session d'upload cible échouée (${sessionRes.status}): ${(await sessionRes.text()).slice(0, 300)}`,
    )
  }
  const { uploadUrl } = (await sessionRes.json()) as { uploadUrl: string }

  // La source n'est ouverte QU'ICI, session prête.
  const stream = await openStream()
  const reader = stream.getReader()
  let offset = 0
  let parts: Buffer[] = []
  let partsLen = 0
  let createdId: string | null = null

  /** Envoie un morceau aligné, avec retry (les 5xx d'un upload sont fréquents). */
  const flush = async (buf: Buffer): Promise<void> => {
    const start = offset
    const end = offset + buf.byteLength - 1
    let delay = 2000
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await fetchWithTimeout(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(buf.byteLength),
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
        body: buf,
        timeoutMs: 900_000,
      })
      if (res.status === 200 || res.status === 201) {
        createdId = ((await res.json()) as { id: string }).id
        offset = end + 1
        return
      }
      if (res.status === 202) {
        offset = end + 1
        return
      }
      if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(`Morceau ${start}-${end} refusé (${res.status}): ${(await res.text()).slice(0, 200)}`)
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 30_000)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) {
        parts.push(Buffer.from(value))
        partsLen += value.byteLength
      }
      // Un seul Buffer.concat par morceau : la concaténation incrémentale est
      // en O(n²) et devient le goulot d'étranglement sur un fichier de 1 Go.
      while (partsLen >= CHUNK_SIZE) {
        const merged = Buffer.concat(parts, partsLen)
        await flush(merged.subarray(0, CHUNK_SIZE))
        const rest = merged.subarray(CHUNK_SIZE)
        parts = rest.byteLength > 0 ? [Buffer.from(rest)] : []
        partsLen = rest.byteLength
      }
      if (done) break
    }
    if (partsLen > 0) await flush(Buffer.concat(parts, partsLen))
  } finally {
    reader.releaseLock()
  }

  if (!createdId) {
    throw new Error(
      `Upload streamé terminé sans confirmation de Graph (${offset} octets envoyés sur ${size} annoncés)`,
    )
  }
  await setFileTimes(driveId, createdId, times)
  return createdId
}

/**
 * Réapplique les dates d'origine. La session d'upload les pose déjà via
 * `fileSystemInfo`, mais SharePoint les écrase parfois à la finalisation :
 * ce PATCH de sécurité est le même filet que le module Drive.
 */
export async function setFileTimes(
  driveId: string,
  itemId: string,
  times: FileTimes,
): Promise<void> {
  const fs = fileSystemInfo(times)
  if (!fs) return
  await graphFetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`,
    TARGET,
    `setFileTimes ${itemId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileSystemInfo: fs }),
    },
  ).catch(() => {})
}

/**
 * Renomme et/ou déplace un item cible.
 *
 * C'est LA capacité qui manque au module Drive : un dossier renommé côté
 * SharePoint doit être renommé côté cible, sinon la passe suivante le prend
 * pour un nouveau dossier et duplique toute sa descendance.
 */
export async function moveOrRenameTarget(params: {
  driveId: string
  itemId: string
  newName?: string
  newParentItemId?: string
}): Promise<void> {
  const body: Record<string, unknown> = {}
  if (params.newName) body['name'] = params.newName
  if (params.newParentItemId) body['parentReference'] = { id: params.newParentItemId }
  if (Object.keys(body).length === 0) return
  const res = await graphFetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(params.driveId)}/items/${encodeURIComponent(params.itemId)}`,
    TARGET,
    `moveOrRenameTarget ${params.itemId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    throw new Error(`Déplacement/renommage cible échoué (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
}

/**
 * Supprime un item cible (→ corbeille du site, récupérable 93 jours).
 *
 * Un 404 est traité comme un succès : l'item a déjà disparu (suppression du
 * parent, ou passe précédente interrompue après la suppression mais avant
 * l'écriture en base). Échouer là-dessus ferait boucler la passe.
 */
export async function deleteTargetItem(driveId: string, itemId: string): Promise<void> {
  const res = await graphFetch(
    `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`,
    TARGET,
    `deleteTargetItem ${itemId}`,
    { method: 'DELETE' },
  )
  if (res.ok || res.status === 404) return
  throw new Error(`Suppression cible échouée (${res.status}): ${(await res.text()).slice(0, 300)}`)
}
