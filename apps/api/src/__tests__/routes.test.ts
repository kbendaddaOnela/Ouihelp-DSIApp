// Garde-fous sur la table des routes — sans base ni réseau (l'app est importée
// telle quelle, aucun handler métier n'est atteint).
//   pnpm --filter @dsi-app/api test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { app } from '../app'

interface RouteDef {
  method: string
  path: string
}

/** Routes déclarées (hors middlewares `ALL`), dans l'ordre d'enregistrement, sans doublon. */
function declaredRoutes(): RouteDef[] {
  const seen = new Set<string>()
  const out: RouteDef[] = []
  for (const r of app.routes) {
    if (r.method === 'ALL') continue
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ method: r.method, path: r.path })
  }
  return out
}

const isParam = (segment: string) => segment.startsWith(':')

/** true si `earlier` capture toutes les URL de `later` (même méthode, même forme). */
function shadows(earlier: RouteDef, later: RouteDef): boolean {
  if (earlier.method !== later.method) return false
  const a = earlier.path.split('/')
  const b = later.path.split('/')
  if (a.length !== b.length) return false
  let earlierIsWider = false
  for (let i = 0; i < a.length; i++) {
    const sa = a[i]!
    const sb = b[i]!
    if (isParam(sa)) {
      if (!isParam(sb)) earlierIsWider = true
      continue
    }
    if (isParam(sb) || sa !== sb) return false
  }
  return earlierIsWider
}

// Hono retient la première route enregistrée qui correspond : une route statique
// (`/history`) déclarée APRÈS une route paramétrée de même forme (`/:id`) n'est
// jamais atteinte — et rien ne le signale à la compilation.
test('aucune route statique masquée par une route paramétrée déclarée avant elle', () => {
  const routes = declaredRoutes()
  const masked: string[] = []
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      if (shadows(routes[i]!, routes[j]!)) {
        masked.push(`${routes[j]!.method} ${routes[j]!.path} est masquée par ${routes[i]!.path}`)
      }
    }
  }
  assert.deepEqual(masked, [])
})

// Routes volontairement accessibles sans jeton Entra.
const PUBLIC_ROUTES = [
  /^GET \/$/,
  /^GET \/db-status$/,
  /^GET \/assets\/logo\/:name$/,
  /^GET \/api\/health$/,
  // Agent des postes : authentification propre (clé d'enrôlement + jeton par poste).
  /^[A-Z]+ \/api\/device-agent\//,
]

test('toute route /api hors liste publique répond 401 sans jeton', async () => {
  // L'authentification lit ces variables avant de vérifier le jeton.
  process.env['AZURE_TENANT_ID'] ??= '00000000-0000-0000-0000-000000000000'
  process.env['AZURE_CLIENT_ID'] ??= '00000000-0000-0000-0000-000000000001'

  const open: string[] = []
  for (const r of declaredRoutes()) {
    const key = `${r.method} ${r.path}`
    if (PUBLIC_ROUTES.some((re) => re.test(key))) continue
    const url = r.path.replace(/:[A-Za-z0-9_]+/g, 'x')
    const res = await app.request(url, { method: r.method })
    if (res.status !== 401) open.push(`${key} → ${res.status}`)
  }
  assert.deepEqual(open, [])
})
