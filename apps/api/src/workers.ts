// Workers in-process (polling de la base). Démarrés une seule fois, en
// production uniquement, après les migrations de schéma — voir index.ts.
import { startMailWorker } from './modules/migration/mailWorker'
import { startSharedMailboxWorker } from './modules/shared-mailbox/worker'
import { startSharepointMigrationWorker } from './modules/sharepoint-migration/worker'
import { startXimiMigrationWorker } from './modules/sharepoint-ximi/worker'

export function startWorkers(): void {
  startMailWorker()
  startSharedMailboxWorker()
  startSharepointMigrationWorker()
  startXimiMigrationWorker()
}
