// Étapes Google du compte migré : alias, nouveau format, OU, vérification SCIM, licences.
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { requirePermission } from '../../../middleware/rbac'
import type { RbacVariables } from '../../../middleware/rbac'
import { getDb } from '../../../db/index'
import { migrations, licenseQuotas } from '../schema'
import { googleUserExists, addGoogleAlias, moveUserToOu } from '../../../integrations/google/directory'
import { listLicenseSkusWithUsage, assignLicense, skuDisplayName } from '../../../integrations/google/licensing'
import { ensureSendAs, setSendAsAsDefault } from '../../../integrations/google/gmailSettings'
import { serializeMigration } from '../serializers'

export const googleSetupRoutes = new Hono<{ Variables: RbacVariables }>()

// ── Activer le nouveau format prenom.nom@onela.com (alias + send-as) ────────
// Le user a déjà l'alias legacy pnom@onela.com ; on ajoute ici l'alias
// prenom.nom@onela.com PLUS une identité "Envoyer en tant que" pour qu'il
// puisse communiquer en sortant avec le nouveau format dès la migration.
googleSetupRoutes.post('/:id/activate-new-format', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé à cette migration' }, 400)

  // gohUpn = prenom.nom@mig.onela.com → alias = prenom.nom@onela.com
  const localPart = row.gohUpn.split('@')[0]
  if (!localPart) return c.json({ error: 'gohUpn invalide' }, 400)
  // Domaine cible : récupéré depuis onelaUpn (la BAL ONELA source)
  const targetDomain = row.onelaUpn.split('@')[1] ?? 'onela.com'
  const newAlias = `${localPart}@${targetDomain}`

  const result: {
    alias: string
    aliasAdded: boolean
    sendAsAdded: boolean
    setAsDefault: boolean
    warnings: string[]
  } = {
    alias: newAlias,
    aliasAdded: false,
    sendAsAdded: false,
    setAsDefault: false,
    warnings: [],
  }

  await db.update(migrations).set({ stepNewFormat: 'running', newFormatError: null }).where(eq(migrations.id, row.id))

  // 1. Ajouter l'alias sur le user Google (idempotent : 409 ignoré)
  try {
    await addGoogleAlias(row.gohUpn, newAlias)
    result.aliasAdded = true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('409')) {
      result.warnings.push(`Alias déjà présent`)
    } else {
      console.error('[activate-new-format] alias error:', msg)
      await db.update(migrations).set({ stepNewFormat: 'error', newFormatError: msg }).where(eq(migrations.id, row.id))
      return c.json({ error: 'alias', message: msg, ...result }, 502)
    }
  }

  // 2. Ajouter "Envoyer en tant que" sur le Gmail du user (idempotent)
  try {
    const sendAs = await ensureSendAs(row.gohUpn, newAlias, row.onelaDisplayName)
    result.sendAsAdded = sendAs.created
    if (!sendAs.created) result.warnings.push(`Send-as déjà présent`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[activate-new-format] sendas error:', msg)
    await db.update(migrations).set({ stepNewFormat: 'error', newFormatError: msg }).where(eq(migrations.id, row.id))
    return c.json({ error: 'sendas', message: msg, ...result }, 502)
  }

  // 3. Marquer cette identité comme adresse par défaut (PATCH isDefault: true)
  try {
    await setSendAsAsDefault(row.gohUpn, newAlias)
    result.setAsDefault = true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[activate-new-format] setDefault error:', msg)
    // Non bloquant : l'alias + send-as sont déjà ajoutés
    result.warnings.push(`Mise en défaut échouée : ${msg.slice(0, 200)}`)
  }

  // Étape considérée comme réussie même si setDefault a warningé
  await db.update(migrations).set({ stepNewFormat: 'success', newFormatError: null }).where(eq(migrations.id, row.id))

  return c.json({ ok: true, ...result })
})

// ── Ajouter l'alias Google (manuel, après SCIM sync) ─────────────────────────
googleSetupRoutes.post('/:id/google-alias', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration non réussie, impossible d\'ajouter l\'alias' }, 400)
  }

  // Vérifier que le compte Google existe (SCIM provisionné)
  const exists = await googleUserExists(row.gohUpn)
  if (!exists) {
    return c.json({ error: 'not_provisioned', message: `Le compte ${row.gohUpn} n'est pas encore disponible dans Google Workspace. Le SCIM sync peut prendre 5 à 40 minutes — réessaie dans quelques minutes.` }, 202)
  }

  // Alias : par défaut l'UPN ONELA, sinon override via body { alias }
  let aliasOverride: string | undefined
  try {
    const body = (await c.req.json<{ alias?: string }>().catch(() => ({}))) as { alias?: string }
    aliasOverride = body.alias?.trim()
  } catch { /* no body */ }
  const alias = aliasOverride || row.onelaUpn

  try {
    await addGoogleAlias(row.gohUpn, alias)
    await db.update(migrations)
      .set({ stepGoogleAlias: 'success', googleAliasError: null })
      .where(eq(migrations.id, row.id))
    const [updated] = await db.select().from(migrations).where(eq(migrations.id, row.id))
    if (!updated) return c.json({ error: 'Not Found' }, 404)
    return c.json(serializeMigration(updated))
  } catch (err) {
    const errorDetails = err instanceof Error ? err.message : String(err)
    await db.update(migrations)
      .set({ stepGoogleAlias: 'error', googleAliasError: errorDetails })
      .where(eq(migrations.id, row.id))
    return c.json({ error: 'Google alias error', message: errorDetails }, 502)
  }
})

// ── Déplacer le compte Google vers l'OU ONELA ────────────────────────────────
googleSetupRoutes.post('/:id/move-ou', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé à cette migration' }, 400)

  const ouPath = process.env['GOOGLE_ONELA_OU_PATH'] ?? '/onela.com'

  await db.update(migrations).set({ stepOuMove: 'running', ouMoveError: null }).where(eq(migrations.id, row.id))

  try {
    await moveUserToOu(row.gohUpn, ouPath)
    await db.update(migrations).set({ stepOuMove: 'success' }).where(eq(migrations.id, row.id))
    const [updated] = await db.select().from(migrations).where(eq(migrations.id, row.id))
    if (!updated) return c.json({ error: 'Not Found' }, 404)
    return c.json(serializeMigration(updated))
  } catch (err) {
    const errorDetails = err instanceof Error ? err.message : String(err)
    await db.update(migrations).set({ stepOuMove: 'error', ouMoveError: errorDetails }).where(eq(migrations.id, row.id))
    return c.json({ error: 'Google move OU error', message: errorDetails }, 502)
  }
})

// ── Vérifier si le compte Google existe (SCIM provisionné) ──────────────────
googleSetupRoutes.get('/:id/check-google', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ exists: false, email: null })
  const exists = await googleUserExists(row.gohUpn)
  return c.json({ exists, email: row.gohUpn })
})

// ── Licences Google Workspace ────────────────────────────────────────────────
// Découvre les licences en usage + le nombre assigné à chacune. On y ajoute le total
// de sièges (saisi manuellement dans license_quotas — Google n'expose pas les sièges
// achetés par API) pour afficher « restantes = total − utilisées ».
googleSetupRoutes.get('/license-skus', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  try {
    const [skus, quotas] = await Promise.all([
      listLicenseSkusWithUsage(),
      db.select().from(licenseQuotas),
    ])
    const totalBySku = new Map(quotas.map((q) => [q.skuId, q.totalSeats]))
    const enriched = skus.map((s) => {
      const total = totalBySku.get(s.skuId) ?? null
      return { ...s, total, remaining: total != null ? total - s.used : null }
    })
    // SKU avec un total saisi mais aucune assignation (absents de listForProduct)
    for (const q of quotas) {
      if (!enriched.some((e) => e.skuId === q.skuId)) {
        enriched.push({ productId: 'Google-Apps', skuId: q.skuId, name: skuDisplayName(q.skuId), used: 0, total: q.totalSeats, remaining: q.totalSeats })
      }
    }
    return c.json({ skus: enriched })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'Google Licensing error', message }, 502)
  }
})

// Définit (ou efface) le total de sièges achetés pour une licence.
googleSetupRoutes.put('/license-quotas', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const body = await c.req.json<{ skuId?: string; total?: number | null }>().catch(() => ({} as { skuId?: string; total?: number | null }))
  if (!body.skuId) return c.json({ error: 'skuId requis' }, 400)
  const updatedBy = c.get('dbUser').email
  // total absent / invalide → on efface le quota (revient à « utilisé seulement »)
  if (body.total == null || !Number.isFinite(body.total) || body.total < 0) {
    await db.delete(licenseQuotas).where(eq(licenseQuotas.skuId, body.skuId))
    return c.json({ ok: true, cleared: true })
  }
  const total = Math.floor(body.total)
  await db.insert(licenseQuotas).values({ skuId: body.skuId, totalSeats: total, updatedBy })
    .onDuplicateKeyUpdate({ set: { totalSeats: total, updatedBy } })
  return c.json({ ok: true })
})

// Assigne une licence (productId + skuId) au compte Google migré.
googleSetupRoutes.post('/:id/assign-license', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé à cette migration' }, 400)

  const body = await c.req.json<{ productId?: string; skuId?: string }>().catch(() => ({} as { productId?: string; skuId?: string }))
  if (!body.productId || !body.skuId) return c.json({ error: 'productId et skuId requis' }, 400)
  const { productId, skuId } = body

  await db.update(migrations).set({ stepLicense: 'running', licenseError: null }).where(eq(migrations.id, id))
  try {
    await assignLicense(row.gohUpn, productId, skuId)
    await db.update(migrations).set({
      stepLicense: 'success',
      licenseSkuId: skuId,
      licenseSkuName: skuDisplayName(skuId),
    }).where(eq(migrations.id, id))
    const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
    if (!updated) return c.json({ error: 'Not Found' }, 404)
    return c.json(serializeMigration(updated))
  } catch (err) {
    const errorDetails = err instanceof Error ? err.message : String(err)
    await db.update(migrations).set({ stepLicense: 'error', licenseError: errorDetails }).where(eq(migrations.id, id))
    return c.json({ error: 'Google license assign error', message: errorDetails }, 502)
  }
})
