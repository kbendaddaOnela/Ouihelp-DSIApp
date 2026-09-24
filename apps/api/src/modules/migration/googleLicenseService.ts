import { fetchWithTimeout } from './httpClient'
import { getGoogleAccessTokenForUser } from './googleService'

// ── Enterprise License Manager API ────────────────────────────────────────────
// Doc : https://developers.google.com/admin-sdk/licensing/reference/rest
// Scope DwD requis (à autoriser côté Admin console pour le compte de service) :
//   https://www.googleapis.com/auth/apps.licensing
// Sans cette autorisation, l'API renvoie 401/403.

const LICENSING_SCOPE = 'https://www.googleapis.com/auth/apps.licensing'
const LICENSING_BASE = 'https://licensing.googleapis.com/apps/licensing/v1'

// Produit(s) License Manager à interroger pour découvrir les licences en usage.
// 'Google-Apps' couvre toute la famille Google Workspace (Business/Enterprise/
// Frontline...). Surchargeable via GOOGLE_LICENSE_PRODUCT_IDS (liste séparée par
// des virgules) si le tenant expose ses sièges sous d'autres productId.
function getProductIds(): string[] {
  const raw = process.env['GOOGLE_LICENSE_PRODUCT_IDS']
  if (raw && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return ['Google-Apps']
}

// customerId attendu par License Manager = domaine primaire du client (ou l'ID
// client). On le déduit du GOOGLE_ADMIN_EMAIL, surchargeable via GOOGLE_CUSTOMER_ID.
function getCustomerId(): string {
  const override = process.env['GOOGLE_CUSTOMER_ID']
  if (override && override.trim()) return override.trim()
  const admin = process.env['GOOGLE_ADMIN_EMAIL'] ?? ''
  const domain = admin.split('@')[1]
  if (!domain) throw new Error('Impossible de déduire le customerId (GOOGLE_ADMIN_EMAIL sans domaine) — définir GOOGLE_CUSTOMER_ID')
  return domain
}

// Noms lisibles pour les SKU Google Workspace les plus courants (best-effort).
// Un SKU inconnu est affiché tel quel (son skuId).
const SKU_NAMES: Record<string, string> = {
  '1010020027': 'Business Starter',
  '1010020028': 'Business Standard',
  '1010020025': 'Business Plus',
  '1010020026': 'Enterprise Standard',
  '1010020020': 'Enterprise Plus',
  '1010020029': 'Enterprise Starter',
  '1010020030': 'Frontline Starter',
  '1010020031': 'Frontline Standard',
  '1010060001': 'Enterprise Essentials',
  '1010060003': 'Enterprise Essentials Plus',
  '1010010001': 'Cloud Identity Free',
  '1010050001': 'Cloud Identity Premium',
  'Google-Apps-Unlimited': 'G Suite Business (legacy)',
  'Google-Apps-For-Business': 'G Suite Basic (legacy)',
}

export function skuDisplayName(skuId: string): string {
  return SKU_NAMES[skuId] ?? skuId
}

interface LicenseAssignment {
  productId: string
  skuId: string
  skuName?: string
  userId: string
}

export interface LicenseSkuUsage {
  productId: string
  skuId: string
  name: string
  used: number
}

// Parcourt tous les assignments d'un produit (paginé) et les yield.
async function* iterateAssignments(productId: string, token: string): AsyncGenerator<LicenseAssignment> {
  const customerId = getCustomerId()
  let pageToken: string | undefined
  do {
    const url = new URL(`${LICENSING_BASE}/product/${encodeURIComponent(productId)}/users`)
    url.searchParams.set('customerId', customerId)
    url.searchParams.set('maxResults', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetchWithTimeout(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 404) return // produit sans aucun assignment → rien à lister
    if (!res.ok) throw new Error(`License list error (${res.status}) pour ${productId}: ${(await res.text()).slice(0, 300)}`)
    const data = (await res.json()) as { items?: LicenseAssignment[]; nextPageToken?: string }
    for (const it of data.items ?? []) yield it
    pageToken = data.nextPageToken
  } while (pageToken)
}

// Découvre les licences EN USAGE et le nombre assigné à chacune (utilisé seulement).
export async function listLicenseSkusWithUsage(): Promise<LicenseSkuUsage[]> {
  const adminEmail = process.env['GOOGLE_ADMIN_EMAIL']
  if (!adminEmail) throw new Error('GOOGLE_ADMIN_EMAIL manquant')
  const token = await getGoogleAccessTokenForUser(adminEmail, LICENSING_SCOPE)

  // clé = productId|skuId → { productId, skuId, used }
  const byKey = new Map<string, LicenseSkuUsage>()
  for (const productId of getProductIds()) {
    for await (const a of iterateAssignments(productId, token)) {
      const key = `${a.productId}|${a.skuId}`
      const existing = byKey.get(key)
      if (existing) existing.used++
      else byKey.set(key, { productId: a.productId, skuId: a.skuId, name: skuDisplayName(a.skuId), used: 1 })
    }
  }
  return [...byKey.values()].sort((x, y) => y.used - x.used)
}

// Assigne une licence (productId + skuId) à un utilisateur. Idempotent : un
// assignment déjà existant (409) est traité comme un succès.
export async function assignLicense(userEmail: string, productId: string, skuId: string): Promise<void> {
  const adminEmail = process.env['GOOGLE_ADMIN_EMAIL']
  if (!adminEmail) throw new Error('GOOGLE_ADMIN_EMAIL manquant')
  const token = await getGoogleAccessTokenForUser(adminEmail, LICENSING_SCOPE)

  const url = `${LICENSING_BASE}/product/${encodeURIComponent(productId)}/sku/${encodeURIComponent(skuId)}/user`
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: userEmail }),
  })
  if (res.ok) return
  // 409 Conflict = déjà assignée à ce SKU → OK (idempotent)
  if (res.status === 409) return
  const err = await res.text()
  throw new Error(`License assign error (${res.status}): ${err.slice(0, 400)}`)
}
