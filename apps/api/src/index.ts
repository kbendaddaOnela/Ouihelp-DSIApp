import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { apiRouter } from './routes/index'
import { requestLogger } from './middleware/logger'
import { ONELA_LOGO_PNG_B64, OUIHELP_LOGO_PNG_B64 } from './modules/migration/emailAssets'
import { SIG_BLOCK_PNG_B64, SIG_LINKEDIN_PNG_B64, SIG_FACEBOOK_PNG_B64, SIG_INSTAGRAM_PNG_B64 } from './modules/migration/signatureAssets'
import { runMigrations } from './db/migrate'
import { startMailWorker } from './modules/migration/mailWorker'
import { startSharedMailboxWorker } from './modules/shared-mailbox/worker'
import { startSharepointMigrationWorker } from './modules/sharepoint-migration/worker'
import { startXimiMigrationWorker } from './modules/sharepoint-ximi/worker'

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

// Logos publics (sans auth) pour les e-mails — référencés en URL absolue car les
// images inline CID ne s'affichent pas dans Outlook Web.
const EMAIL_LOGOS: Record<string, string> = {
  'onela.png': ONELA_LOGO_PNG_B64,
  'ouihelp.png': OUIHELP_LOGO_PNG_B64,
  // Signature ONELA (bloc marque + icônes réseaux)
  'sig-block.png': SIG_BLOCK_PNG_B64,
  'sig-linkedin.png': SIG_LINKEDIN_PNG_B64,
  'sig-facebook.png': SIG_FACEBOOK_PNG_B64,
  'sig-instagram.png': SIG_INSTAGRAM_PNG_B64,
}
app.get('/assets/logo/:name', (c) => {
  const b64 = EMAIL_LOGOS[c.req.param('name')]
  if (!b64) return c.json({ error: 'Not Found' }, 404)
  return c.body(Buffer.from(b64, 'base64'), 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=604800',
  })
})

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
  // Start listening immediately so Azure health checks pass
  serve({ fetch: app.fetch, port }, () => {
    console.log(`API DSI App démarrée sur http://localhost:${port}`)
  })

  if (process.env['NODE_ENV'] === 'production') {
    runMigrations()
      .then(() => {
        dbReady = true
        console.log('[startup] DB migrations OK')
        startMailWorker()
        startSharedMailboxWorker()
        startSharepointMigrationWorker()
        startXimiMigrationWorker()
      })
      .catch((err) => {
        dbError = err instanceof Error ? err.message : String(err)
        console.error('[startup] Migration failed (non-fatal):', dbError)
      })
  } else {
    dbReady = true
  }
}

// Expose DB status on health endpoint
app.get('/db-status', (c) => c.json({ dbReady, dbError }))

start().catch((err) => {
  console.error('[startup] Fatal error:', err)
  process.exit(1)
})

export default app
