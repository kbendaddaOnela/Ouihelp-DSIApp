import { createMiddleware } from 'hono/factory'

// Middleware de logging HTTP minimal
export const requestLogger = createMiddleware(async (c, next) => {
  const start = Date.now()
  const method = c.req.method
  const path = c.req.path

  await next()

  const ms = Date.now() - start
  const status = c.res.status
  const color = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m'
  const reset = '\x1b[0m'

  console.log(`${color}${method}${reset} ${path} ${status} ${ms}ms`)
})
