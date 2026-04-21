import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import { loadUserRole } from '../middleware/rbac'
import type { RbacVariables } from '../middleware/rbac'
import type { MeResponse } from '@dsi-app/shared'

export const meRouter = new Hono<{ Variables: RbacVariables }>()

// GET /api/me — retourne le profil et le rôle de l'utilisateur connecté
meRouter.get('/', authMiddleware, loadUserRole, (c) => {
  const jwtPayload = c.get('jwtPayload')
  const role = c.get('userRole')

  const response: MeResponse = {
    user: {
      id: jwtPayload.oid,
      email: jwtPayload.email ?? jwtPayload.preferred_username ?? '',
      name: jwtPayload.name ?? '',
      tenantId: jwtPayload.tid,
      role,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }

  return c.json(response)
})
