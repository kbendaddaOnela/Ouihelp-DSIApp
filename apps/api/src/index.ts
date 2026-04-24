import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { apiRouter } from './routes/index'
import { requestLogger } from './middleware/logger'
import { runMigrations } from './db/migrate'

const app = new Hono()

// CORS — autorise uniquement l'origine du frontend
app.use(
  '*',
  cors({
    origin: process.env['APP_URL'] ?? 'http://localhost:5173',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  })
)

// Logging de toutes les requêtes
app.use('*', requestLogger)

// Routes API montées sous /api
app.route('/api', apiRouter)

// Route racine
app.get('/', (c) => c.json({ name: 'DSI App API', status: 'running' }))

// 404 catch-all
app.notFound((c) => c.json({ error: 'Not Found' }, 404))

// Gestionnaire d'erreurs global
app.onError((err, c) => {
  console.error('[API Error]', err)
  return c.json({ error: 'Internal Server Error', message: err.message }, 500)
})

const port = Number(process.env['PORT'] ?? 3000)

let dbReady = false
let dbError: string | null = null

async function start() {
  if (process.env['NODE_ENV'] === 'production') {
    try {
      await runMigrations()
      dbReady = true
      console.log('[startup] DB migrations OK')
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err)
      console.error('[startup] Migration failed (non-fatal):', dbError)
    }
  } else {
    dbReady = true
  }

  serve({ fetch: app.fetch, port }, () => {
    console.log(`API DSI App démarrée sur http://localhost:${port}`)
  })
}

// Expose DB status on health endpoint
app.get('/db-status', (c) => c.json({ dbReady, dbError }))

start().catch((err) => {
  console.error('[startup] Fatal error:', err)
  process.exit(1)
})

export default app
