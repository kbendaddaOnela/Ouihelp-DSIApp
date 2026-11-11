import { Hono } from 'hono'
import { eq, desc, and, asc, isNotNull } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { getDb } from '../../db/index'
import { normalizeNamePart } from '../../lib/names'
import { accountCreations, agencies } from './schema'
import { provisionBackground, finalizeGoogleBackground, parseDelegateMailboxes } from './provisioning'
import { searchGohUsers } from '../../integrations/microsoft/tenantDirectory'
import { assignLicense, skuDisplayName } from '../../integrations/google/licensing'
import { sharedMigrations } from '../shared-mailbox/schema'
import { buildRoutingAddress, removeOnelaRouting } from './onelaRoutingService'
import type {
  CreateAccountRequest,
  CreateAccountResponse,
  AccountHistoryResponse,
  SearchManagersResponse,
  AgenciesResponse,
  AgencyInput,
  MigratedSharedMailboxesResponse,
} from '@dsi-app/shared'

export const accountsRouter = new Hono<{ Variables: RbacVariables }>()

accountsRouter.use('*', authMiddleware, loadUserRole)

/** Parse la colonne JSON `delegate_mailboxes` (tableau d'adresses) de façon tolérante. */
function serialize(a: typeof accountCreations.$inferSelect) {
  return {
    ...a,
    delegateMailboxes: parseDelegateMailboxes(a.delegateMailboxes),
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
    mailbox: a.mailbox ?? null,
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
    mailbox: b.mailbox?.trim() || null,
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
    mailbox: b.mailbox?.trim() || null,
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

// ── Boîtes partagées déjà migrées (candidates à la délégation Gmail) ─────────
// Mode « compte Google classique » créé avec succès → on peut y déléguer le
// nouvel arrivant. On expose l'adresse PRIMAIRE Google (targetUserEmail) qui est
// la cible réelle de l'API de délégation.
accountsRouter.get('/shared-mailboxes', requirePermission('accounts:read'), async (c) => {
  const db = getDb()
  // NB : on n'exclut PAS les migrations archivées — une boîte migrée est archivée
  // (déplacée dans « Historique ») une fois terminée, mais reste une cible de
  // délégation parfaitement valide. Seul compte : compte Google créé (targetUserEmail).
  const rows = await db
    .select()
    .from(sharedMigrations)
    .where(
      and(
        eq(sharedMigrations.mode, 'account'),
        eq(sharedMigrations.stepCreateAccount, 'success'),
        isNotNull(sharedMigrations.targetUserEmail),
      ),
    )
    .orderBy(asc(sharedMigrations.onelaDisplayName))

  const mailboxes = rows
    .filter((r) => r.targetUserEmail)
    .map((r) => ({
      id: r.id,
      displayName: r.targetDisplayName || r.onelaDisplayName,
      onelaEmail: r.onelaEmail,
      alias: r.targetUserAlias ?? null,
      delegateEmail: r.targetUserEmail as string,
    }))
  return c.json<MigratedSharedMailboxesResponse>({ mailboxes })
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

  // Boîtes partagées à déléguer : normalisation (adresses minuscules, dédoublonnées)
  const delegateMailboxes = Array.isArray(body.delegateMailboxes)
    ? Array.from(
        new Set(
          body.delegateMailboxes
            .filter((m): m is string => typeof m === 'string')
            .map((m) => m.trim().toLowerCase())
            .filter((m) => m !== ''),
        ),
      )
    : []

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
    delegateMailboxes: delegateMailboxes.length > 0 ? JSON.stringify(delegateMailboxes) : null,
    licenseProductId: body.licenseSkuId ? (body.licenseProductId?.trim() || 'Google-Apps') : null,
    licenseSkuId: body.licenseSkuId?.trim() || null,
    licenseSkuName: body.licenseSkuId ? skuDisplayName(body.licenseSkuId.trim()) : null,
    stepCreateGoh: 'pending',
    stepSetAttributes: 'pending',
    stepOnelaRouting: 'pending',
    stepGoogleProvision: 'pending',
    stepOuMove: 'pending',
    stepLicense: 'pending',
    stepNewFormat: 'pending',
    stepSendAs: 'pending',
    stepContactsOnela: 'pending',
    stepDelegations: 'pending',
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

// ── Terminer / relancer la finalisation Google ───────────────────────────────
// Reprend la finalisation (SCIM → OU → licence → alias → send-as → contacts →
// délégations). Peut recevoir une licence et/ou des boîtes à déléguer à appliquer
// MAINTENANT — utile pour terminer les comptes créés AVANT l'ajout de la licence
// et des délégations (ces 2 étapes sont alors forcées à `pending` pour re-tourner).
accountsRouter.post('/:id/finalize-google', requirePermission('accounts:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (row.stepCreateGoh !== 'success') {
    return c.json({ error: 'Le compte GOH n\'est pas encore créé' }, 400)
  }

  const body = await c.req
    .json<{ licenseProductId?: string; licenseSkuId?: string; delegateMailboxes?: string[] }>()
    .catch(() => ({}) as { licenseProductId?: string; licenseSkuId?: string; delegateMailboxes?: string[] })

  // Licence passée explicitement → on l'enregistre et on force l'étape à re-tourner
  const newSkuId = body.licenseSkuId?.trim()
  const licenseUpdate = newSkuId
    ? {
        licenseProductId: body.licenseProductId?.trim() || 'Google-Apps',
        licenseSkuId: newSkuId,
        licenseSkuName: skuDisplayName(newSkuId),
        stepLicense: 'pending' as const,
      }
    : {}

  // Boîtes à déléguer passées explicitement → on remplace la liste et on force l'étape
  const hasDelegates = Array.isArray(body.delegateMailboxes)
  const normalizedDelegates = hasDelegates
    ? Array.from(
        new Set(
          body.delegateMailboxes!
            .filter((m): m is string => typeof m === 'string')
            .map((m) => m.trim().toLowerCase())
            .filter((m) => m !== ''),
        ),
      )
    : []
  const delegatesUpdate = hasDelegates
    ? {
        delegateMailboxes: normalizedDelegates.length > 0 ? JSON.stringify(normalizedDelegates) : null,
        stepDelegations: 'pending' as const,
      }
    : {}

  // Reset des étapes en error OU figées en running (tâche tuée par un recyclage) → pending
  const unstick = (s: string) => s === 'running' || s === 'error'
  await db.update(accountCreations).set({
    ...(unstick(row.stepGoogleProvision) ? { stepGoogleProvision: 'pending' as const } : {}),
    ...(unstick(row.stepOuMove) ? { stepOuMove: 'pending' as const } : {}),
    ...(unstick(row.stepLicense) ? { stepLicense: 'pending' as const } : {}),
    ...(unstick(row.stepNewFormat) ? { stepNewFormat: 'pending' as const } : {}),
    ...(unstick(row.stepSendAs) ? { stepSendAs: 'pending' as const } : {}),
    ...(unstick(row.stepContactsOnela) ? { stepContactsOnela: 'pending' as const } : {}),
    ...(unstick(row.stepDelegations) ? { stepDelegations: 'pending' as const } : {}),
    ...licenseUpdate,
    ...delegatesUpdate,
    errorDetails: null,
    delegationsError: null,
    licenseError: null,
  }).where(eq(accountCreations.id, id))
  void finalizeGoogleBackground(id)
  return c.json({ message: 'Finalisation Google relancée en background', id }, 202)
})

// ── Attribution manuelle d'une licence Google ────────────────────────────────
// Utile pour (ré)assigner une licence après coup — notamment pour les comptes
// créés sans sélection de licence. Enchaîne la finalisation si le compte est prêt.
accountsRouter.post('/:id/assign-license', requirePermission('accounts:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  const body = await c.req
    .json<{ productId?: string; skuId?: string }>()
    .catch(() => ({}) as { productId?: string; skuId?: string })
  const skuId = body.skuId?.trim()
  const productId = body.productId?.trim() || 'Google-Apps'
  if (!skuId) return c.json({ error: 'validation', message: 'skuId requis' }, 400)

  await db.update(accountCreations).set({
    stepLicense: 'running',
    licenseProductId: productId,
    licenseSkuId: skuId,
    licenseError: null,
  }).where(eq(accountCreations.id, id))

  try {
    await assignLicense(row.gohUpn, productId, skuId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.update(accountCreations).set({ stepLicense: 'error', licenseError: msg }).where(eq(accountCreations.id, id))
    return c.json({ error: 'Attribution de licence échouée', message: msg }, 502)
  }

  await db.update(accountCreations).set({
    stepLicense: 'success',
    licenseSkuName: skuDisplayName(skuId),
    licenseError: null,
  }).where(eq(accountCreations.id, id))

  // Si le compte est déjà remonté dans Google, enchaîner la finalisation (send-as,
  // contacts, délégations) maintenant que la boîte va s'initialiser.
  if (row.stepGoogleProvision === 'success') void finalizeGoogleBackground(id)

  const [updated] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  return c.json({ account: serialize(updated!) })
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
