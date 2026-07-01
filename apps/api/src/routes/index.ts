import { Hono } from 'hono'
import { meRouter } from './me'
import { migrationRouter } from '../modules/migration/routes'
import { migrationTargetsRouter } from '../modules/migration/targetRoutes'
import { inventoryRouter } from '../modules/inventory/routes'
import { budgetRouter } from '../modules/budget/routes'
import { sharedMailboxRouter } from '../modules/shared-mailbox/routes'
import { sharepointMigrationRouter } from '../modules/sharepoint-migration/routes'
import { onelaContactsRouter } from '../modules/onela-contacts/routes'
import { accountsRouter } from '../modules/accounts/routes'

export const apiRouter = new Hono()

apiRouter.route('/me', meRouter)
apiRouter.route('/migration', migrationRouter)
apiRouter.route('/migration-targets', migrationTargetsRouter)
apiRouter.route('/inventory', inventoryRouter)
apiRouter.route('/budget', budgetRouter)
apiRouter.route('/shared-mailbox', sharedMailboxRouter)
apiRouter.route('/sharepoint-migration', sharepointMigrationRouter)
apiRouter.route('/onela-contacts', onelaContactsRouter)
apiRouter.route('/accounts', accountsRouter)

// Route de santé — accessible sans authentification
apiRouter.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env['npm_package_version'] ?? '0.0.1',
  })
})
