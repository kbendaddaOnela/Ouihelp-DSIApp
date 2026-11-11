// Construction de l'application HTTP (sans effet de bord : ni écoute réseau, ni
// base, ni workers). `index.ts` la démarre ; les tests l'importent telle quelle.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { apiRouter } from './routes/index'
import { serveEmailLogo } from './routes/emailLogos'
import { requestLogger } from './middleware/logger'

/** État du démarrage (migrations de schéma), exposé sur /db-status. */
export const startupStatus: { dbReady: boolean; dbError: string | null } = {
  dbReady: false,
  dbError: null,
}

export const app = new Hono()

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

app.get('/assets/logo/:name', serveEmailLogo)

// Route racine
app.get('/', (c) => c.json({ name: 'DSI App API', status: 'running' }))

// Expose DB status on health endpoint
app.get('/db-status', (c) => c.json(startupStatus))

// 404 catch-all
app.notFound((c) => c.json({ error: 'Not Found' }, 404))

// Gestionnaire d'erreurs global
app.onError((err, c) => {
  console.error('[API Error]', err)
  return c.json({ error: 'Internal Server Error', message: err.message }, 500)
})
