import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth'
import { loadUserRole } from '../middleware/rbac'
import type { RbacVariables } from '../middleware/rbac'
import type { MeResponse } from '@dsi-app/shared'

export const meRouter = new Hono<{ Variables: RbacVariables }>()

meRouter.get('/', authMiddleware, loadUserRole, (c) => {
  const user = c.get('dbUser')

  const response: MeResponse = {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      tenantId: user.tenantId,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
  }

  return c.json(response)
})
