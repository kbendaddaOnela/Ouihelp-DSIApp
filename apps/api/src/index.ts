import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { apiRouter } from './routes/index'
import { requestLogger } from './middleware/logger'

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

serve({ fetch: app.fetch, port }, () => {
  console.log(`🚀 API DSI App démarrée sur http://localhost:${port}`)
})

export default app
