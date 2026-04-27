import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { hasPermission, type Permission, type Role } from '@dsi-app/shared'
import { db } from '../db/index'
import { users, type User } from '../modules/auth/schema'
import type { AuthVariables } from './auth'

export type RbacVariables = AuthVariables & {
  userRole: Role
  dbUser: User
}

export function requirePermission(permission: Permission) {
  return createMiddleware<{ Variables: RbacVariables }>(async (c, next) => {
    const role = c.get('userRole')

    if (!role) {
      return c.json({ error: 'Forbidden', message: 'Rôle utilisateur non défini' }, 403)
    }

    if (!hasPermission(role, permission)) {
      return c.json({ error: 'Forbidden', message: `Permission manquante : ${permission}` }, 403)
    }

    await next()
  })
}

// Upsert l'utilisateur à chaque requête authentifiée :
// - Premier login : crée le compte avec rôle collaborator
// - Logins suivants : met à jour email/nom si changés dans Entra ID
// - Injecte userRole et dbUser dans le contexte Hono
export const loadUserRole = createMiddleware<{ Variables: RbacVariables }>(async (c, next) => {
  const userId = c.get('userId')
  const jwtPayload = c.get('jwtPayload')

  const p = jwtPayload as unknown as Record<string, string>
  const email = jwtPayload.email ?? jwtPayload.preferred_username ?? p['unique_name'] ?? p['upn'] ?? ''
  const name = jwtPayload.name ?? ''
  const tenantId = jwtPayload.tid

  // Auto-promote to admin if email is in the ADMIN_EMAILS env var (comma-separated)
  const adminEmails = (process.env['ADMIN_EMAILS'] ?? '').split(',').map((e) => e.trim().toLowerCase())
  const autoRole = adminEmails.includes(email.toLowerCase()) ? 'admin' : 'collaborator'
  console.log(`[rbac] email="${email}" autoRole="${autoRole}" claims=${JSON.stringify(Object.keys(jwtPayload))}`)

  await db
    .insert(users)
    .values({ id: userId, email, name, tenantId, role: autoRole })
    .onDuplicateKeyUpdate({ set: { email, name, tenantId, role: autoRole } })

  const [user] = await db.select().from(users).where(eq(users.id, userId))

  if (!user) {
    return c.json({ error: 'Internal Server Error', message: 'Utilisateur introuvable après upsert' }, 500)
  }

  c.set('userRole', user.role)
  c.set('dbUser', user)

  await next()
})
