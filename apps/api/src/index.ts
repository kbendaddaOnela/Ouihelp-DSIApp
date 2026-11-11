// Point d'entrée du process : charge l'environnement, écoute, applique les
// migrations de schéma puis démarre les workers.
// `dotenv/config` doit rester le PREMIER import : des modules lisent
// process.env dès leur chargement.
import 'dotenv/config'
import { serve } from '@hono/node-server'
import { app, startupStatus } from './app'
import { runMigrations } from './db/migrate'
import { startWorkers } from './workers'

const port = Number(process.env['PORT'] ?? 3000)

async function start() {
  // Start listening immediately so Azure health checks pass
  serve({ fetch: app.fetch, port }, () => {
    console.log(`API DSI App démarrée sur http://localhost:${port}`)
  })

  // En dev, ni migrations ni workers : on ne migre pas « pour de vrai » en local.
  if (process.env['NODE_ENV'] === 'production') {
    runMigrations()
      .then(() => {
        startupStatus.dbReady = true
        console.log('[startup] DB migrations OK')
        startWorkers()
      })
      .catch((err) => {
        startupStatus.dbError = err instanceof Error ? err.message : String(err)
        console.error('[startup] Migration failed (non-fatal):', startupStatus.dbError)
      })
  } else {
    startupStatus.dbReady = true
  }
}

start().catch((err) => {
  console.error('[startup] Fatal error:', err)
  process.exit(1)
})

export default app
