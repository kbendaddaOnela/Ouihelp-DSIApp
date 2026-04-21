import type { Role } from './roles'

// Utilisateur applicatif — identifié par l'OID Microsoft, indépendant du tenant
export interface AppUser {
  id: string // OID Microsoft Entra ID
  email: string
  name: string
  tenantId: string // tenant Microsoft courant (ONELA ou Ouihelp)
  role: Role
  createdAt: string
  updatedAt: string
}

// Payload renvoyé par GET /api/me
export interface MeResponse {
  user: AppUser
}

// Payload JWT Microsoft Entra ID (claims standards)
export interface EntraIdJwtPayload {
  oid: string // Object ID — identifiant universel Microsoft
  tid: string // Tenant ID
  email?: string
  preferred_username?: string
  name?: string
  aud: string // Audience (client_id)
  iss: string // Issuer
  iat: number
  exp: number
  scp?: string // Scopes
}
