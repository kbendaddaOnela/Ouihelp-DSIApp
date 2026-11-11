// Routes du module « Migration ONELA » (/api/migration).
//
// Le routeur était un seul fichier de ~1 850 lignes ; il est découpé par domaine
// fonctionnel. Tous les sous-routeurs sont montés à la racine du module : les
// chemins sont inchangés.
import { Hono } from 'hono'
import { authMiddleware } from '../../../middleware/auth'
import { loadUserRole } from '../../../middleware/rbac'
import type { RbacVariables } from '../../../middleware/rbac'
import { accountRoutes } from './accounts'
import { dashboardRoutes } from './dashboard'
import { googleSetupRoutes } from './googleSetup'
import { dataMigrationRoutes } from './dataMigration'
import { communicationRoutes } from './communications'
import { forwardingRoutes } from './forwarding'
import { lifecycleRoutes } from './lifecycle'

export const migrationRouter = new Hono<{ Variables: RbacVariables }>()

migrationRouter.use('*', authMiddleware, loadUserRole)

// L'ORDRE COMPTE : Hono retient la première route enregistrée qui correspond.
// Les routes statiques (`/history`, `/license-skus`, `/live-stats`…) doivent
// rester avant `GET /:id`, défini dans `lifecycle` — à garder en dernier.
migrationRouter.route('/', accountRoutes)
migrationRouter.route('/', dashboardRoutes)
migrationRouter.route('/', googleSetupRoutes)
migrationRouter.route('/', dataMigrationRoutes)
migrationRouter.route('/', communicationRoutes)
migrationRouter.route('/', forwardingRoutes)
migrationRouter.route('/', lifecycleRoutes)
