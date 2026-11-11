// Jetons Microsoft (client credentials) et identifiants des tenants ONELA /
// Ouihelp, partagés par tous les modules.
import { fetchWithTimeout } from '../../lib/httpClient'

interface TokenCache {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, TokenCache>()

export async function getAccessToken(tenantId: string, clientId: string, clientSecret: string, scope = 'https://graph.microsoft.com/.default'): Promise<string> {
  const cacheKey = `${tenantId}:${clientId}:${scope}`
  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token

  const res = await fetchWithTimeout(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Token error (${res.status}): ${err}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 })
  return data.access_token
}

export async function getOnelaToken(): Promise<string> {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('ONELA Graph credentials manquantes')
  return getAccessToken(tid, cid, sec)
}

/**
 * Jeton Graph (client credentials) d'un tenant. Alias historique de
 * `getAccessToken` avec le scope Graph par défaut : même cache, même délai
 * d'expiration réseau (l'ancienne copie appelait `fetch` sans timeout et tenait
 * un second cache pour les mêmes jetons).
 */
export function getMsToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  return getAccessToken(tenantId, clientId, clientSecret)
}

export function ouihelpCreds() {
  const tid = process.env['AZURE_TENANT_ID']
  const cid = process.env['AZURE_CLIENT_ID']
  const sec = process.env['AZURE_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('Credentials Ouihelp (AZURE_*) manquants')
  return { tid, cid, sec }
}

export function onelaCreds() {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('Credentials ONELA manquants')
  return { tid, cid, sec }
}
