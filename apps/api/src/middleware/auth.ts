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
  jwksCache = createRemoteJWKSet(new URL(jwksUri))
  return jwksCache
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
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: clientId,
    })

    const jwtPayload = payload as unknown as EntraIdJwtPayload

    c.set('jwtPayload', jwtPayload)
    c.set('userId', jwtPayload.oid)
    c.set('userTenantId', jwtPayload.tid)

    await next()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token invalide'
    console.warn('[auth] Validation JWT échouée :', message)
    return c.json({ error: 'Unauthorized', message: 'Token invalide ou expiré' }, 401)
  }
})
