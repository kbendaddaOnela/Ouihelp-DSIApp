import { createMiddleware } from 'hono/factory'
import { hasPermission, type Permission, type Role } from '@dsi-app/shared'
import type { AuthVariables } from './auth'

// Types pour le contexte RBAC (étend le contexte auth)
export type RbacVariables = AuthVariables & {
  userRole: Role
}

// Middleware RBAC — vérifie qu'un utilisateur possède une permission donnée
// À utiliser après authMiddleware
export function requirePermission(permission: Permission) {
  return createMiddleware<{ Variables: RbacVariables }>(async (c, next) => {
    const role = c.get('userRole')

    if (!role) {
      return c.json(
        { error: 'Forbidden', message: 'Rôle utilisateur non défini' },
        403
      )
    }

    if (!hasPermission(role, permission)) {
      return c.json(
        {
          error: 'Forbidden',
          message: `Permission manquante : ${permission}`,
        },
        403
      )
    }

    await next()
  })
}

// Middleware qui charge le rôle depuis la DB et l'injecte dans le contexte
// À placer après authMiddleware, avant les routes protégées
// Note : en Phase 1, retourne un rôle par défaut — remplacer par une vraie DB en Phase 2
export const loadUserRole = createMiddleware<{ Variables: RbacVariables }>(async (c, next) => {
  const userId = c.get('userId')

  // TODO Phase 2 : charger depuis Supabase/Drizzle
  // const user = await db.query.users.findFirst({ where: eq(users.id, userId) })
  // c.set('userRole', user?.role ?? 'collaborator')

  // Phase 1 : rôle par défaut pour les tests
  // À remplacer dès que la DB Supabase est configurée
  void userId
  c.set('userRole', 'it_team')

  await next()
})
