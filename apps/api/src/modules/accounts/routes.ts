import { Hono } from 'hono'
import { eq, desc, and, asc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { getDb } from '../../db/index'
import { accountCreations, agencies } from './schema'
import {
  createGohUser,
  setGohUserAttributes,
  setGohUserManager,
  searchGohUsers,
  checkGohUserExists,
} from '../migration/service'
import { googleUserExists, moveUserToOu, addGoogleAlias } from '../migration/googleService'
import { ensureSendAs, setSendAsAsDefault } from '../shared-mailbox/gmailUserSetupService'
import { ensureOnelaRouting, buildRoutingAddress, removeOnelaRouting } from './onelaRoutingService'
import type {
  CreateAccountRequest,
  CreateAccountResponse,
  AccountHistoryResponse,
  SearchManagersResponse,
  AgenciesResponse,
  AgencyInput,
} from '@dsi-app/shared'

export const accountsRouter = new Hono<{ Variables: RbacVariables }>()

accountsRouter.use('*', authMiddleware, loadUserRole)

// ── Normalisation prenom/nom → partie locale (a-z, sans accents) ─────────────
function normalizeNamePart(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '')
}

function serialize(a: typeof accountCreations.$inferSelect) {
  return {
    ...a,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

// ── Référentiel agences (CRUD) ────────────────────────────────────────────────
function serializeAgency(a: typeof agencies.$inferSelect) {
  return {
    id: a.id,
    name: a.name,
    trigramme: a.trigramme,
    region: a.region,
    address: a.address,
    postalCode: a.postalCode,
    city: a.city,
  }
}

accountsRouter.get('/agencies', requirePermission('accounts:read'), async (c) => {
  const db = getDb()
  const rows = await db.select().from(agencies).orderBy(asc(agencies.name))
  return c.json<AgenciesResponse>({ agencies: rows.map(serializeAgency) })
})

function validateAgency(b: Partial<AgencyInput>): string | null {
  for (const f of ['name', 'trigramme', 'region', 'address', 'postalCode', 'city'] as const) {
    if (!b[f] || String(b[f]).trim() === '') return `Champ manquant : ${f}`
  }
  return null
}

accountsRouter.post('/agencies', requirePermission('accounts:write'), async (c) => {
  const db = getDb()
  const b = await c.req.json<AgencyInput>()
  const err = validateAgency(b)
  if (err) return c.json({ error: 'validation', message: err }, 400)

  const existing = await db.select({ id: agencies.id }).from(agencies).where(eq(agencies.name, b.name.trim())).limit(1)
  if (existing.length > 0) return c.json({ error: 'conflict', message: `Agence « ${b.name} » déjà existante` }, 409)

  const id = randomUUID()
  await db.insert(agencies).values({
    id,
    name: b.name.trim(),
    trigramme: b.trigramme.trim(),
    region: b.region.trim(),
    address: b.address.trim(),
    postalCode: b.postalCode.trim(),
    city: b.city.trim(),
  })
  const [row] = await db.select().from(agencies).where(eq(agencies.id, id))
  return c.json(serializeAgency(row!), 201)
})

accountsRouter.put('/agencies/:id', requirePermission('accounts:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(agencies).where(eq(agencies.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  const b = await c.req.json<AgencyInput>()
  const err = validateAgency(b)
  if (err) return c.json({ error: 'validation', message: err }, 400)

  await db.update(agencies).set({
    name: b.name.trim(),
    trigramme: b.trigramme.trim(),
    region: b.region.trim(),
    address: b.address.trim(),
    postalCode: b.postalCode.trim(),
    city: b.city.trim(),
  }).where(eq(agencies.id, id))
  const [updated] = await db.select().from(agencies).where(eq(agencies.id, id))
  return c.json(serializeAgency(updated!))
})

accountsRouter.delete('/agencies/:id', requirePermission('accounts:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.delete(agencies).where(eq(agencies.id, id))
  return c.json({ deleted: id })
})

// ── Recherche manager (tenant GOH) ───────────────────────────────────────────
accountsRouter.get('/search-managers', requirePermission('accounts:read'), async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q || q.length < 2) return c.json<SearchManagersResponse>({ managers: [] })
  try {
    const users = await searchGohUsers(q)
    return c.json<SearchManagersResponse>({
      managers: users.map((u) => ({
        id: u.id,
        displayName: u.displayName,
        upn: u.userPrincipalName,
        jobTitle: u.jobTitle ?? null,
      })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[accounts/search-managers] Graph error:', msg)
    return c.json({ error: 'Graph error', message: msg }, 502)
  }
})

// ── Création d'un compte ──────────────────────────────────────────────────────
// On insère le record en pending, on répond 202, puis on provisionne en background
// (GOH → attributs → routage ONELA), puis on finalise sur Google dès que le SCIM
// a provisionné le compte (OU /onela.com + alias + send-as).
accountsRouter.post('/', requirePermission('accounts:write'), async (c) => {
  const body = await c.req.json<CreateAccountRequest>()
  const initiatedBy = c.get('dbUser').email
  const db = getDb()

  // Validation minimale
  const required: Array<[string, unknown]> = [
    ['firstName', body.firstName],
    ['lastName', body.lastName],
    ['emailPrefix', body.emailPrefix],
    ['emailDomain', body.emailDomain],
    ['assignmentType', body.assignmentType],
    ['department', body.department],
    ['jobTitle', body.jobTitle],
    ['password', body.password],
  ]
  for (const [name, value] of required) {
    if (!value || String(value).trim() === '') {
      return c.json({ error: 'validation', message: `Champ manquant : ${name}` }, 400)
    }
  }
  if (body.password.length < 8) {
    return c.json({ error: 'validation', message: 'Le mot de passe doit contenir au moins 8 caractères' }, 400)
  }

  const firstName = body.firstName.trim()
  const lastName = body.lastName.trim()
  const displayName = body.displayName?.trim() || `${firstName} ${lastName.toUpperCase()}`
  const localPart = `${normalizeNamePart(firstName)}.${normalizeNamePart(lastName)}`
  const onelaUpn = `${body.emailPrefix.trim().toLowerCase()}${body.emailDomain}`
  const gohUpn = `${localPart}@mig.onela.com`
  const routingAddress = buildRoutingAddress(onelaUpn)

  // Idempotence : refuser si un onboarding existe déjà pour ce compte
  const existing = await db
    .select({ id: accountCreations.id })
    .from(accountCreations)
    .where(and(eq(accountCreations.gohUpn, gohUpn)))
    .limit(1)
  if (existing.length > 0) {
    return c.json({ error: 'conflict', message: `Un onboarding existe déjà pour ${gohUpn}` }, 409)
  }

  const id = randomUUID()
  await db.insert(accountCreations).values({
    id,
    firstName,
    lastName,
    displayName,
    onelaUpn,
    gohUpn,
    routingAddress,
    tempPassword: body.password,
    assignmentType: body.assignmentType,
    department: body.department.trim(),
    jobTitle: body.jobTitle.trim(),
    managerUpn: body.managerUpn?.trim() || null,
    officeLocation: body.officeLocation?.trim() || null,
    state: body.state?.trim() || null,
    streetAddress: body.streetAddress?.trim() || null,
    postalCode: body.postalCode?.trim() || null,
    city: body.city?.trim() || null,
    stepCreateGoh: 'pending',
    stepSetAttributes: 'pending',
    stepOnelaRouting: 'pending',
    stepGoogleProvision: 'pending',
    stepOuMove: 'pending',
    stepNewFormat: 'pending',
    stepSendAs: 'pending',
    initiatedBy,
  })

  void provisionBackground(id, {
    firstName,
    lastName,
    displayName,
    gohUpn,
    onelaUpn,
    department: body.department.trim(),
    jobTitle: body.jobTitle.trim(),
    managerUpn: body.managerUpn?.trim() || null,
    officeLocation: body.officeLocation?.trim() || null,
    state: body.state?.trim() || null,
    streetAddress: body.streetAddress?.trim() || null,
    postalCode: body.postalCode?.trim() || null,
    city: body.city?.trim() || null,
    password: body.password,
    forceChangePassword: body.forceChangePassword,
  })

  const [row] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!row) return c.json({ error: 'Erreur interne' }, 500)
  return c.json<CreateAccountResponse>({ account: serialize(row) }, 202)
})

// ── Provisioning background : GOH → attributs → routage ONELA ─────────────────
interface ProvisionParams {
  firstName: string
  lastName: string
  displayName: string
  gohUpn: string
  onelaUpn: string
  department: string
  jobTitle: string
  managerUpn: string | null
  officeLocation: string | null
  state: string | null
  streetAddress: string | null
  postalCode: string | null
  city: string | null
  password: string
  forceChangePassword: boolean
}

async function provisionBackground(id: string, p: ProvisionParams) {
  const db = getDb()
  const [current] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!current) {
    console.error(`[accounts] ${id} introuvable, abandon`)
    return
  }

  const localPart = p.gohUpn.split('@')[0] ?? ''
  const ext10 = `${localPart}@onela.fr`
  const ext11 = p.onelaUpn

  // ── Étape 1 : créer le compte GOH ──
  let gohUserId: string | null = current.gohUserId
  if (current.stepCreateGoh !== 'success') {
    await db.update(accountCreations).set({ stepCreateGoh: 'running' }).where(eq(accountCreations.id, id))
    try {
      if (await checkGohUserExists(p.gohUpn)) {
        throw new Error(`Le compte ${p.gohUpn} existe déjà dans Entra GOH`)
      }
      const gohUser = await createGohUser({
        givenName: p.firstName,
        surname: p.lastName,
        upn: p.gohUpn,
        displayName: p.displayName,
        department: p.department,
        jobTitle: p.jobTitle,
        tempPassword: p.password,
        officeLocation: p.officeLocation,
        streetAddress: p.streetAddress,
        postalCode: p.postalCode,
        city: p.city,
        state: p.state,
        usageLocation: 'FR',
        country: 'France',
        preferredLanguage: 'fr-FR',
        forceChangePassword: p.forceChangePassword,
      })
      gohUserId = gohUser.id
      await db.update(accountCreations)
        .set({ gohUserId, stepCreateGoh: 'success', errorDetails: null })
        .where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} createGoh error:`, msg)
      await db.update(accountCreations).set({ stepCreateGoh: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  // ── Étape 2 : attributs (ext10/ext11) + manager ──
  if (current.stepSetAttributes !== 'success') {
    if (!gohUserId) {
      await db.update(accountCreations).set({ stepSetAttributes: 'error', errorDetails: 'gohUserId manquant' }).where(eq(accountCreations.id, id))
      return
    }
    await db.update(accountCreations).set({ stepSetAttributes: 'running' }).where(eq(accountCreations.id, id))
    try {
      await setGohUserAttributes(gohUserId, ext10, ext11)
      // Manager : optionnel et non bloquant (le manager peut ne pas encore exister dans GOH)
      if (p.managerUpn) {
        try {
          await setGohUserManager(gohUserId, p.managerUpn)
        } catch (mErr) {
          console.warn(`[accounts] ${id} manager non appliqué (${p.managerUpn}):`, mErr instanceof Error ? mErr.message : String(mErr))
        }
      }
      await db.update(accountCreations).set({ stepSetAttributes: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} setAttributes error:`, msg)
      await db.update(accountCreations).set({ stepSetAttributes: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  // ── Étape 3 : objet de routage Exchange ONELA (onela.com → Google) ──
  if (current.stepOnelaRouting !== 'success') {
    await db.update(accountCreations).set({ stepOnelaRouting: 'running' }).where(eq(accountCreations.id, id))
    console.log(`[accounts] ${id} step3 routage ONELA: start (${p.onelaUpn})`)
    try {
      // Garde-fou : l'étape ne peut pas rester bloquée. Si ensureOnelaRouting ne
      // rend pas la main sous 100 s, on force l'échec (au lieu de figer 'running').
      const watchdog = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('Timeout routage ONELA (>100s) — voir logs [routing] pour le cmdlet en cause')), 100_000),
      )
      const r = await Promise.race([
        ensureOnelaRouting({
          displayName: p.displayName,
          firstName: p.firstName,
          lastName: p.lastName,
          onelaAddress: p.onelaUpn,
        }),
        watchdog,
      ])
      console.log(`[accounts] ${id} step3 routage ONELA: OK (${r.routingAddress}, created=${r.created})`)
      await db.update(accountCreations).set({ stepOnelaRouting: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} onelaRouting error:`, msg)
      await db.update(accountCreations).set({ stepOnelaRouting: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  console.log(`[accounts] ${id} provisioning OK (${p.gohUpn}) → finalisation Google en attente du SCIM`)
  // Enchaîner sur la finalisation Google (polling SCIM)
  void finalizeGoogleBackground(id)
}

// ── Finalisation Google : attente SCIM puis OU /onela.com + alias + send-as ──
const SCIM_POLL_INTERVAL_MS = 60_000 // 1 min
const SCIM_MAX_ATTEMPTS = 45 // ~45 min

async function finalizeGoogleBackground(id: string) {
  const db = getDb()
  const [row] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!row) return

  const ouPath = process.env['GOOGLE_ONELA_OU_PATH'] ?? '/onela.com'
  const gohUpn = row.gohUpn
  const onelaUpn = row.onelaUpn

  // 1. Attendre que le compte remonte dans Google (SCIM, 5-40 min)
  if (row.stepGoogleProvision !== 'success') {
    await db.update(accountCreations).set({ stepGoogleProvision: 'running' }).where(eq(accountCreations.id, id))
    let provisioned = false
    for (let attempt = 0; attempt < SCIM_MAX_ATTEMPTS; attempt++) {
      try {
        if (await googleUserExists(gohUpn)) { provisioned = true; break }
      } catch (err) {
        console.warn(`[accounts] ${id} check-google échec (tentative ${attempt + 1}):`, err instanceof Error ? err.message : String(err))
      }
      await new Promise((r) => setTimeout(r, SCIM_POLL_INTERVAL_MS))
    }
    if (!provisioned) {
      await db.update(accountCreations).set({
        stepGoogleProvision: 'error',
        errorDetails: `Compte ${gohUpn} toujours absent de Google après ~${SCIM_MAX_ATTEMPTS} min — relance "Finaliser sur Google" plus tard.`,
      }).where(eq(accountCreations.id, id))
      return
    }
    await db.update(accountCreations).set({ stepGoogleProvision: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
  }

  // 2. Bascule sur l'OU /onela.com
  if (row.stepOuMove !== 'success') {
    await db.update(accountCreations).set({ stepOuMove: 'running' }).where(eq(accountCreations.id, id))
    try {
      await moveUserToOu(gohUpn, ouPath)
      await db.update(accountCreations).set({ stepOuMove: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} moveOu error:`, msg)
      await db.update(accountCreations).set({ stepOuMove: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  // 3. Alias prenom.nom@onela.com (le compte reçoit dès que c'est fait)
  if (row.stepNewFormat !== 'success') {
    await db.update(accountCreations).set({ stepNewFormat: 'running' }).where(eq(accountCreations.id, id))
    try {
      await addGoogleAlias(gohUpn, onelaUpn) // 409 (déjà présent) ignoré côté service
      await db.update(accountCreations).set({ stepNewFormat: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} alias error:`, msg)
      await db.update(accountCreations).set({ stepNewFormat: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  // 4. Send-as par défaut (étape séparée : Gmail doit être initialisé, ce qui peut
  //    lagguer après la création/bascule d'OU → on retry, et ça ne bloque pas l'alias).
  if (row.stepSendAs !== 'success') {
    await db.update(accountCreations).set({ stepSendAs: 'running' }).where(eq(accountCreations.id, id))
    try {
      // Erreurs transitoires Gmail : mailbox pas encore prête (failedPrecondition) ou
      // alias pas encore propagé (invalidArgument). On réessaie ~3 min.
      let done = false
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 9 && !done; attempt++) {
        try {
          await ensureSendAs(gohUpn, onelaUpn, row.displayName)
          done = true
        } catch (sErr) {
          lastErr = sErr
          const m = sErr instanceof Error ? sErr.message : String(sErr)
          const transient = /not a valid user or group|invalidArgument|INVALID_ARGUMENT|Precondition check failed|failedPrecondition|FAILED_PRECONDITION/i.test(m)
          if (!transient) throw sErr
          console.warn(`[accounts] ${id} send-as pas encore prêt (tentative ${attempt + 1}/9), retry dans 20s`)
          await new Promise((r) => setTimeout(r, 20_000))
        }
      }
      if (!done) {
        const m = lastErr instanceof Error ? lastErr.message : String(lastErr)
        throw new Error(`Boîte Gmail pas encore prête pour le send-as (peut prendre quelques minutes) — reclique « Finaliser sur Google » un peu plus tard. Détail : ${m}`)
      }
      try {
        await setSendAsAsDefault(gohUpn, onelaUpn)
      } catch (dErr) {
        console.warn(`[accounts] ${id} setDefault non bloquant:`, dErr instanceof Error ? dErr.message : String(dErr))
      }
      await db.update(accountCreations).set({ stepSendAs: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
      console.log(`[accounts] ${id} finalisation Google terminée (${gohUpn} → OU ${ouPath} + ${onelaUpn} + send-as)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} sendAs error:`, msg)
      await db.update(accountCreations).set({ stepSendAs: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
    }
  }
}

// ── Relancer la finalisation Google manuellement (si le SCIM a traîné) ────────
accountsRouter.post('/:id/finalize-google', requirePermission('accounts:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (row.stepCreateGoh !== 'success') {
    return c.json({ error: 'Le compte GOH n\'est pas encore créé' }, 400)
  }
  // Reset des étapes en error OU figées en running (tâche tuée par un recyclage) → pending
  const unstick = (s: string) => s === 'running' || s === 'error'
  await db.update(accountCreations).set({
    ...(unstick(row.stepGoogleProvision) ? { stepGoogleProvision: 'pending' as const } : {}),
    ...(unstick(row.stepOuMove) ? { stepOuMove: 'pending' as const } : {}),
    ...(unstick(row.stepNewFormat) ? { stepNewFormat: 'pending' as const } : {}),
    ...(unstick(row.stepSendAs) ? { stepSendAs: 'pending' as const } : {}),
    errorDetails: null,
  }).where(eq(accountCreations.id, id))
  void finalizeGoogleBackground(id)
  return c.json({ message: 'Finalisation Google relancée en background', id }, 202)
})

// ── Relancer le provisioning (étapes GOH/attributs/routage en erreur) ────────
accountsRouter.post('/:id/retry', requirePermission('accounts:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  // Débloque une étape figée en 'running' (tâche background tuée par un recyclage
  // du conteneur) ou en 'error' → 'pending' pour un re-run propre. provisionBackground
  // rejoue toute étape != 'success' (idempotent) puis enchaîne la finalisation Google.
  const unstick = (s: string) => (s === 'running' || s === 'error' ? ('pending' as const) : undefined)
  await db.update(accountCreations).set({
    errorDetails: null,
    ...(unstick(row.stepCreateGoh) ? { stepCreateGoh: 'pending' as const } : {}),
    ...(unstick(row.stepSetAttributes) ? { stepSetAttributes: 'pending' as const } : {}),
    ...(unstick(row.stepOnelaRouting) ? { stepOnelaRouting: 'pending' as const } : {}),
  }).where(eq(accountCreations.id, id))

  void provisionBackground(id, {
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    gohUpn: row.gohUpn,
    onelaUpn: row.onelaUpn,
    department: row.department ?? '',
    jobTitle: row.jobTitle ?? '',
    managerUpn: row.managerUpn,
    officeLocation: row.officeLocation,
    state: row.state,
    streetAddress: row.streetAddress,
    postalCode: row.postalCode,
    city: row.city,
    password: row.tempPassword ?? `Tmp-${Math.random().toString(36).slice(2, 8)}#Az1`,
    forceChangePassword: true,
  })
  return c.json({ message: 'Retry lancé en background', id }, 202)
})

// ── Historique ────────────────────────────────────────────────────────────────
accountsRouter.get('/history', requirePermission('accounts:read'), async (c) => {
  const db = getDb()
  const page = Number(c.req.query('page') ?? 1)
  const limit = 50
  const offset = (page - 1) * limit
  const rows = await db.select().from(accountCreations).orderBy(desc(accountCreations.createdAt)).limit(limit).offset(offset)
  return c.json<AccountHistoryResponse>({ accounts: rows.map(serialize), total: rows.length })
})

// ── Détail ────────────────────────────────────────────────────────────────────
accountsRouter.get('/:id', requirePermission('accounts:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(accountCreations).where(eq(accountCreations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  return c.json({ account: serialize(row) })
})

// ── Supprimer le suivi (et optionnellement l'objet de routage ONELA) ─────────
accountsRouter.delete('/:id', requirePermission('accounts:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  // Supprime le MailContact de routage seulement si demandé (?purgeRouting=1)
  if (c.req.query('purgeRouting') === '1') {
    try {
      await removeOnelaRouting(row.onelaUpn)
    } catch (err) {
      console.warn(`[accounts] ${id} suppression routage ONELA échouée:`, err instanceof Error ? err.message : String(err))
    }
  }

  await db.delete(accountCreations).where(eq(accountCreations.id, id))
  return c.json({ deleted: id })
})
