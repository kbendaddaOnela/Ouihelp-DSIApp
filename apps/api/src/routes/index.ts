import { Hono } from 'hono'
import { meRouter } from './me'
import { migrationRouter } from '../modules/migration/routes'
import { migrationTargetsRouter } from '../modules/migration/targetRoutes'

export const apiRouter = new Hono()

apiRouter.route('/me', meRouter)
apiRouter.route('/migration', migrationRouter)
apiRouter.route('/migration-targets', migrationTargetsRouter)

// Route de santé — accessible sans authentification
apiRouter.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env['npm_package_version'] ?? '0.0.1',
  })
})
