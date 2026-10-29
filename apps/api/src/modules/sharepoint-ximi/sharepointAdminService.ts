// Création des sites cibles et attribution des droits, côté tenant SharePoint
// Ouihelp — via l'API REST SharePoint (et non Graph).
//
// POURQUOI PAS GRAPH : Microsoft Graph v1.0 ne sait pas créer un site SharePoint
// autrement qu'en créant un groupe M365 (site d'équipe). Or on veut des SITES DE
// COMMUNICATION d'agence, et surtout on veut donner accès à un GROUPE DYNAMIQUE
// de sécurité — chose qu'un groupe M365 refuse (il n'accepte que des utilisateurs).
// Les deux opérations passent donc par REST : `/_api/SPSiteManager/create` sur le
// site d'admin, puis `/_api/web/sitegroups(...)/users` sur le site créé.
//
// AUTHENTIFICATION : SharePoint REST en app-only REFUSE les jetons obtenus avec
// un secret client (« Unsupported app only token »). Il faut une app Entra avec
// un CERTIFICAT et la permission SharePoint `Sites.FullControl.All`. On signe
// donc nous-mêmes une assertion JWT RS256 (client_assertion) — c'est le seul
// chemin supporté par Microsoft aujourd'hui.
//
// Variables d'environnement :
//   OUIHELP_SP_TENANT_NAME    ex. « ouihelp » → https://ouihelp.sharepoint.com
//   OUIHELP_SP_TENANT_ID      défaut : AZURE_TENANT_ID
//   OUIHELP_SP_CLIENT_ID      défaut : AZURE_CLIENT_ID
//   OUIHELP_SP_CERT_KEY       clé privée PEM (PKCS#8) de l'app
//   OUIHELP_SP_CERT_THUMBPRINT empreinte SHA-1 du certificat (hex)
//   OUIHELP_SP_OWNER          UPN propriétaire des sites créés
//   XIMI_SITE_LCID            défaut 1036 (français)

import { createSign, createHash, randomUUID } from 'crypto'
import { fetchWithTimeout } from '../migration/httpClient'

/** Modèle de site de communication (Topic). */
const WEB_TEMPLATE = 'SITEPAGEPUBLISHING#0'

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (!v) throw new Error(`Variable d'environnement ${name} manquante (module Ximi)`)
  return v
}

export function tenantName(): string {
  return env('OUIHELP_SP_TENANT_NAME')
}

export function siteHost(): string {
  return `https://${tenantName()}.sharepoint.com`
}

function adminHost(): string {
  return `https://${tenantName()}-admin.sharepoint.com`
}

/** URL cible complète pour un alias (/sites/<alias>). */
export function targetSiteUrlFor(alias: string): string {
  return `${siteHost()}/sites/${alias}`
}

// ── Jeton app-only SharePoint (client_assertion par certificat) ───────────────

interface CachedToken {
  token: string
  expiresAt: number
}
const spTokenCache = new Map<string, CachedToken>()

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Construit l'assertion JWT signée par le certificat de l'app.
 *
 * `x5t` porte l'empreinte SHA-1 du certificat en base64url : c'est ce qui permet
 * à Entra de retrouver la clé publique à utiliser pour vérifier la signature.
 */
function buildClientAssertion(tenantId: string, clientId: string): string {
  const thumbprintHex = env('OUIHELP_SP_CERT_THUMBPRINT').replace(/[:\s]/g, '')
  const privateKey = env('OUIHELP_SP_CERT_KEY').replace(/\\n/g, '\n')
  const x5t = base64url(Buffer.from(thumbprintHex, 'hex'))
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT', x5t }
  const payload = {
    aud: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    iss: clientId,
    sub: clientId,
    jti: randomUUID(),
    nbf: now - 60,
    exp: now + 600,
  }
  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  return `${signingInput}.${base64url(signer.sign(privateKey))}`
}

/**
 * Jeton app-only pour une ressource SharePoint donnée (site ou admin).
 * `resource` = origine complète, ex. https://ouihelp-admin.sharepoint.com
 */
async function getSharePointToken(resource: string): Promise<string> {
  const cached = spTokenCache.get(resource)
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token

  const tenantId = env('OUIHELP_SP_TENANT_ID', process.env['AZURE_TENANT_ID'])
  const clientId = env('OUIHELP_SP_CLIENT_ID', process.env['AZURE_CLIENT_ID'])
  const res = await fetchWithTimeout(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        scope: `${resource}/.default`,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: buildClientAssertion(tenantId, clientId),
      }),
    },
  )
  if (!res.ok) {
    throw new Error(`Jeton SharePoint (${resource}) refusé (${res.status}): ${(await res.text()).slice(0, 400)}`)
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  spTokenCache.set(resource, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  })
  return data.access_token
}

/** Appel REST SharePoint (odata=verbose, comme attendu par SPSiteManager). */
async function spRest(
  origin: string,
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<Response> {
  const token = await getSharePointToken(origin)
  return fetchWithTimeout(`${origin}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json;odata=verbose',
      'Content-Type': 'application/json;odata=verbose',
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    timeoutMs: init?.timeoutMs ?? 120_000,
  })
}

// ── Création de site ──────────────────────────────────────────────────────────

/** Statuts renvoyés par SPSiteManager. */
const SITE_STATUS = { NOT_FOUND: 0, PROVISIONING: 1, READY: 2, ERROR: 3 } as const

export interface CreatedSite {
  siteUrl: string
  siteId: string | null
}

/**
 * Normalise un alias d'URL : SharePoint n'accepte que [a-zA-Z0-9-] et refuse
 * les alias déjà pris (y compris par un site supprimé encore en corbeille).
 */
export function normalizeAlias(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

/**
 * Crée un site de communication sur le tenant Ouihelp.
 *
 * SPSiteManager est ASYNCHRONE : il répond souvent `SiteStatus = 1`
 * (provisioning). On attend la bascule en 2 (prêt) avant de rendre la main —
 * sinon l'appel Graph suivant (résolution du site, upload) échoue en 404 alors
 * que tout se passe bien.
 */
export async function createCommunicationSite(params: {
  title: string
  alias: string
  description?: string
}): Promise<CreatedSite> {
  const url = targetSiteUrlFor(params.alias)
  const owner = env('OUIHELP_SP_OWNER')
  const lcid = Number(process.env['XIMI_SITE_LCID'] ?? 1036)

  const res = await spRest(adminHost(), '/_api/SPSiteManager/create', {
    method: 'POST',
    body: {
      request: {
        Title: params.title,
        Url: url,
        Lcid: lcid,
        ShareByEmailEnabled: false,
        Description: params.description ?? '',
        WebTemplate: WEB_TEMPLATE,
        SiteDesignId: '00000000-0000-0000-0000-000000000000',
        Owner: owner,
      },
    },
    timeoutMs: 300_000,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Création du site cible échouée (${res.status}): ${text.slice(0, 500)}`)
  }
  const parsed = JSON.parse(text) as {
    d?: { Create?: { SiteId?: string; SiteStatus?: number; SiteUrl?: string } }
  }
  const created = parsed.d?.Create
  if (!created) throw new Error(`Réponse SPSiteManager inattendue : ${text.slice(0, 300)}`)
  if (created.SiteStatus === SITE_STATUS.ERROR) {
    throw new Error(`SPSiteManager a refusé la création (alias « ${params.alias} » déjà utilisé ?)`)
  }
  const siteUrl = created.SiteUrl ?? url
  if (created.SiteStatus !== SITE_STATUS.READY) {
    await waitForSiteReady(siteUrl)
  }
  return { siteUrl, siteId: created.SiteId ?? null }
}

/** Interroge SPSiteManager jusqu'à ce que le site soit provisionné. */
async function waitForSiteReady(siteUrl: string, maxWaitMs = 10 * 60_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs
  let delay = 5_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay))
    const res = await spRest(
      adminHost(),
      `/_api/SPSiteManager/status?url='${encodeURIComponent(siteUrl)}'`,
    )
    if (res.ok) {
      const data = (await res.json()) as { d?: { Status?: { SiteStatus?: number } } }
      const status = data.d?.Status?.SiteStatus
      if (status === SITE_STATUS.READY) return
      if (status === SITE_STATUS.ERROR) {
        throw new Error(`Provisionnement du site ${siteUrl} en erreur côté SharePoint`)
      }
    }
    delay = Math.min(delay * 1.5, 30_000)
  }
  throw new Error(
    `Site ${siteUrl} toujours en cours de provisionnement après ${Math.round(maxWaitMs / 60000)} min — ` +
      `relance la migration, la création sera reprise.`,
  )
}

/** Vrai si un site existe déjà à cette URL (évite un 400 « alias déjà pris »). */
export async function siteExists(siteUrl: string): Promise<boolean> {
  const res = await spRest(
    adminHost(),
    `/_api/SPSiteManager/status?url='${encodeURIComponent(siteUrl)}'`,
  )
  if (!res.ok) return false
  const data = (await res.json()) as { d?: { Status?: { SiteStatus?: number } } }
  const status = data.d?.Status?.SiteStatus
  return status === SITE_STATUS.READY || status === SITE_STATUS.PROVISIONING
}

// ── Attribution des droits au groupe dynamique d'agence ───────────────────────

/**
 * Nom de connexion SharePoint d'un groupe de sécurité Entra.
 * `c:0t.c|tenant|<objectId>` est la forme reconnue par la claim provider — un
 * groupe n'a PAS d'adresse de connexion utilisable autrement.
 */
function groupLoginName(groupObjectId: string): string {
  return `c:0t.c|tenant|${groupObjectId}`
}

export type SitePermissionLevel = 'members' | 'owners' | 'visitors'

/**
 * Donne accès au site au groupe dynamique de l'agence.
 *
 * On passe par le groupe SharePoint associé (Membres par défaut) plutôt que par
 * un partage direct : c'est ce que l'admin verra dans « Paramètres du site →
 * Autorisations », et ça reste modifiable à la main ensuite.
 */
export async function grantGroupAccess(params: {
  siteUrl: string
  groupObjectId: string
  level?: SitePermissionLevel
}): Promise<void> {
  const origin = new URL(params.siteUrl).origin
  const webPath = new URL(params.siteUrl).pathname.replace(/\/$/, '')
  const level = params.level ?? 'members'
  const assocPath =
    level === 'owners'
      ? 'AssociatedOwnerGroup'
      : level === 'visitors'
        ? 'AssociatedVisitorGroup'
        : 'AssociatedMemberGroup'

  const groupRes = await spRest(origin, `${webPath}/_api/web/${assocPath}?$select=Id`)
  if (!groupRes.ok) {
    throw new Error(
      `Lecture du groupe « ${assocPath} » du site échouée (${groupRes.status}): ${(await groupRes.text()).slice(0, 300)}`,
    )
  }
  const groupData = (await groupRes.json()) as { d?: { Id?: number } }
  const spGroupId = groupData.d?.Id
  if (!spGroupId) {
    throw new Error(`Le site ${params.siteUrl} n'a pas de groupe « ${assocPath} » associé`)
  }

  const addRes = await spRest(origin, `${webPath}/_api/web/sitegroups(${spGroupId})/users`, {
    method: 'POST',
    body: {
      __metadata: { type: 'SP.User' },
      LoginName: groupLoginName(params.groupObjectId),
    },
  })
  if (!addRes.ok) {
    throw new Error(
      `Ajout du groupe dynamique au site échoué (${addRes.status}): ${(await addRes.text()).slice(0, 300)}`,
    )
  }
}

/** Empreinte SHA-1 d'un certificat PEM — utilitaire de diagnostic. */
export function thumbprintOf(certPem: string): string {
  const der = Buffer.from(
    certPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''),
    'base64',
  )
  return createHash('sha1').update(der).digest('hex').toUpperCase()
}

// ── Droits au niveau d'un DOSSIER de la bibliothèque ──────────────────────────
//
// Les deux dossiers d'un site Ximi (« Clients », « Intervenants ») n'ont pas les
// mêmes destinataires : les RH voient les intervenants, le marketing et la
// finance voient les clients. Reproduire cela demande de casser l'héritage des
// droits sur le dossier, puis de poser des attributions explicites.
//
// POURQUOI PAS GRAPH : `/permissions` sur un driveItem crée des liens de partage,
// pas des attributions de rôle SharePoint. Un lien de partage n'apparaît pas
// dans « Autorisations », expire, et ne sait pas viser un groupe de sécurité.

/** Nom de connexion d'un utilisateur (claims d'appartenance au tenant). */
export function userLoginName(upn: string): string {
  return `i:0#.f|membership|${upn}`
}

/** Nom de connexion d'un groupe de sécurité Entra. */
export function securityGroupLoginName(groupObjectId: string): string {
  return groupLoginName(groupObjectId)
}

/**
 * `RoleTypeKind` plutôt que le nom du rôle : les noms des niveaux
 * d'autorisation sont LOCALISÉS (« Contribuer », « Contrôle total » sur un site
 * créé en LCID 1036). Chercher « Contribute » par son nom échouerait sur tous
 * les sites que ce module crée.
 */
const ROLE_TYPE = { READER: 2, CONTRIBUTOR: 3, ADMINISTRATOR: 5, EDITOR: 6 } as const

interface RoleDefs {
  contributor: number
  fullControl: number
}
const roleDefCache = new Map<string, RoleDefs>()

async function roleDefinitions(origin: string, webPath: string): Promise<RoleDefs> {
  const key = `${origin}${webPath}`
  const cached = roleDefCache.get(key)
  if (cached) return cached
  const res = await spRest(origin, `${webPath}/_api/web/roledefinitions?$select=Id,RoleTypeKind,Name`)
  if (!res.ok) {
    throw new Error(
      `Lecture des niveaux d'autorisation échouée (${res.status}): ${(await res.text()).slice(0, 300)}`,
    )
  }
  const data = (await res.json()) as {
    d?: { results?: Array<{ Id: number; RoleTypeKind: number; Name: string }> }
  }
  const defs = data.d?.results ?? []
  const wanted = Number(process.env['XIMI_FOLDER_ROLE_TYPE'] ?? ROLE_TYPE.CONTRIBUTOR)
  const contributor =
    defs.find((d) => d.RoleTypeKind === wanted)?.Id ??
    defs.find((d) => d.RoleTypeKind === ROLE_TYPE.EDITOR)?.Id
  const fullControl = defs.find((d) => d.RoleTypeKind === ROLE_TYPE.ADMINISTRATOR)?.Id
  if (!contributor || !fullControl) {
    throw new Error(
      `Niveaux d'autorisation introuvables sur ${webPath} (reçus : ${defs.map((d) => `${d.Name}#${d.RoleTypeKind}`).join(', ')})`,
    )
  }
  const out = { contributor, fullControl }
  roleDefCache.set(key, out)
  return out
}

/** Id de principal SharePoint d'un compte ou d'un groupe, créé au besoin. */
async function ensurePrincipalId(
  origin: string,
  webPath: string,
  loginName: string,
): Promise<number> {
  const res = await spRest(origin, `${webPath}/_api/web/ensureuser`, {
    method: 'POST',
    body: { logonName: loginName },
  })
  if (!res.ok) {
    throw new Error(
      `Principal « ${loginName} » introuvable sur le site (${res.status}): ${(await res.text()).slice(0, 200)}`,
    )
  }
  const data = (await res.json()) as { d?: { Id?: number } }
  const id = data.d?.Id
  if (!id) throw new Error(`Réponse ensureuser inattendue pour « ${loginName} »`)
  return id
}

export interface FolderAclPrincipal {
  /** Libellé lisible, pour le compte rendu (nom du groupe ou UPN). */
  label: string
  loginName: string
}

export interface FolderAclResult {
  applied: string[]
  failures: string[]
}

/**
 * Pose le plan de droits sur un dossier : héritage cassé, puis une attribution
 * « Contribuer » par principal du plan.
 *
 * L'héritage est cassé SANS recopier les attributions (`copyRoleAssignments:
 * false`) : recopier aurait laissé le groupe « Membres » du site — donc toute
 * l'agence — sur les deux dossiers, ce qui annulerait la séparation voulue entre
 * Clients et Intervenants. On réinjecte en revanche le groupe « Propriétaires »
 * en contrôle total : sans lui, les administrateurs du site perdent la main sur
 * un dossier de leur propre site, et plus personne ne peut corriger les droits
 * depuis l'interface.
 *
 * Idempotent : l'héritage n'est cassé que s'il ne l'est pas déjà, et
 * `addroleassignment` sur un principal déjà présent est sans effet.
 */
export async function applyFolderAcl(params: {
  siteUrl: string
  /** Chemin relatif au serveur du dossier, ex. /sites/ximi-arge/Documents/Clients */
  folderServerRelativePath: string
  principals: FolderAclPrincipal[]
}): Promise<FolderAclResult> {
  const origin = new URL(params.siteUrl).origin
  const webPath = new URL(params.siteUrl).pathname.replace(/\/$/, '')
  const folderApi = `${webPath}/_api/web/GetFolderByServerRelativePath(decodedurl='${params.folderServerRelativePath.replace(/'/g, "''")}')`

  const itemRes = await spRest(
    origin,
    `${folderApi}/ListItemAllFields?$select=Id,HasUniqueRoleAssignments`,
  )
  if (!itemRes.ok) {
    throw new Error(
      `Dossier « ${params.folderServerRelativePath} » introuvable côté SharePoint (${itemRes.status}): ${(await itemRes.text()).slice(0, 300)}`,
    )
  }
  const itemData = (await itemRes.json()) as {
    d?: { Id?: number; HasUniqueRoleAssignments?: boolean }
  }
  if (!itemData.d?.Id) {
    throw new Error(`Le dossier « ${params.folderServerRelativePath} » n'a pas d'élément de liste`)
  }

  if (!itemData.d.HasUniqueRoleAssignments) {
    const breakRes = await spRest(
      origin,
      `${folderApi}/ListItemAllFields/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=false)`,
      { method: 'POST' },
    )
    if (!breakRes.ok) {
      throw new Error(
        `Rupture d'héritage des droits échouée (${breakRes.status}): ${(await breakRes.text()).slice(0, 300)}`,
      )
    }
  }

  const roles = await roleDefinitions(origin, webPath)
  const assignPath = `${folderApi}/ListItemAllFields/roleassignments/addroleassignment`
  const applied: string[] = []
  const failures: string[] = []

  // Propriétaires du site d'abord : si la suite échoue, le dossier reste
  // administrable.
  try {
    const ownerRes = await spRest(origin, `${webPath}/_api/web/AssociatedOwnerGroup?$select=Id`)
    if (ownerRes.ok) {
      const ownerId = ((await ownerRes.json()) as { d?: { Id?: number } }).d?.Id
      if (ownerId) {
        await spRest(
          origin,
          `${assignPath}(principalid=${ownerId},roledefid=${roles.fullControl})`,
          { method: 'POST' },
        )
      }
    }
  } catch (err) {
    console.warn(`[ximi] propriétaires non réinjectés sur ${params.folderServerRelativePath}:`, err)
  }

  // Un principal par un : sur un dossier ouvert à sept groupes, l'échec de l'un
  // ne doit pas priver les six autres.
  for (const p of params.principals) {
    try {
      const principalId = await ensurePrincipalId(origin, webPath, p.loginName)
      const res = await spRest(
        origin,
        `${assignPath}(principalid=${principalId},roledefid=${roles.contributor})`,
        { method: 'POST' },
      )
      if (!res.ok) {
        throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
      }
      applied.push(p.label)
    } catch (err) {
      failures.push(`${p.label} : ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { applied, failures }
}
