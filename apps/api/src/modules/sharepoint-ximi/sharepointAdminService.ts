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
