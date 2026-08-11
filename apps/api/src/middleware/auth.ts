import { createMiddleware } from 'hono/factory'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { EntraIdJwtPayload } from '@dsi-app/shared'

// Types Hono pour le contexte enrichi par le middleware
export type AuthVariables = {
  jwtPayload: EntraIdJwtPayload
  userId: string // OID Microsoft — identifiant universel
  userTenantId: string
}

// Cache du JWKS — rechargé automatiquement par jose si les clés changent
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null

function getJwks() {
  if (jwksCache) return jwksCache

  const tenantId = process.env['AZURE_TENANT_ID']
  if (!tenantId) {
    throw new Error("AZURE_TENANT_ID est manquant dans les variables d'environnement")
  }

  const jwksUri = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`
  jwksCache = createRemoteJWKSet(new URL(jwksUri), {
    // Le défaut (5 s) expire quand l'event loop est chargé (worker de migration
    // en cours) → validation en échec alors que le token est valide.
    timeoutDuration: 15_000,
    // Les clés Microsoft tournent rarement ; jose refetch de toute façon dès
    // qu'un `kid` inconnu apparaît, donc un cache long est sûr.
    cacheMaxAge: 24 * 60 * 60 * 1000,
  })
  return jwksCache
}

/**
 * Distingue « je n'ai pas PU vérifier le token » de « le token est invalide ».
 * Renvoyer 401 dans le premier cas est un mensonge : le client conclut que la
 * session a expiré et déclenche une redirection de login (page rechargée).
 */
function isTransientAuthFailure(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ''
  if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JWKS_NO_MATCHING_KEY') return true
  const msg = err instanceof Error ? err.message.toLowerCase() : ''
  return (
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up')
  )
}

// Middleware de validation JWT Microsoft Entra ID
// Vérifie : signature, audience, issuer, expiration
export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const authorization = c.req.header('Authorization')

  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', message: 'Token Bearer manquant' }, 401)
  }

  const token = authorization.slice(7)
  const tenantId = process.env['AZURE_TENANT_ID']
  const clientId = process.env['AZURE_CLIENT_ID']

  if (!tenantId || !clientId) {
    console.error('[auth] Variables AZURE_TENANT_ID ou AZURE_CLIENT_ID manquantes')
    return c.json({ error: 'Internal Server Error' }, 500)
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: [
        `https://login.microsoftonline.com/${tenantId}/v2.0`,
        `https://sts.windows.net/${tenantId}/`,
      ],
      audience: [clientId, `api://${clientId}`],
    })

    const jwtPayload = payload as unknown as EntraIdJwtPayload

    c.set('jwtPayload', jwtPayload)
    c.set('userId', jwtPayload.oid)
    c.set('userTenantId', jwtPayload.tid)

    await next()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token invalide'
    // Panne transitoire (JWKS injoignable) → 503 : le client réessaie au lieu de
    // croire à une session expirée et de relancer un login (rechargement de page).
    if (isTransientAuthFailure(err)) {
      console.warn('[auth] Validation JWT indisponible (transitoire) :', message)
      c.header('Retry-After', '5')
      return c.json(
        { error: 'Service Unavailable', message: 'Validation du token temporairement indisponible' },
        503,
      )
    }
    console.warn('[auth] Validation JWT échouée :', message)
    return c.json({ error: 'Unauthorized', message: 'Token invalide ou expiré' }, 401)
  }
})
