// Communication : envoi des accès par e-mail et pose de la signature Gmail.
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { requirePermission } from '../../../middleware/rbac'
import type { RbacVariables } from '../../../middleware/rbac'
import { getDb } from '../../../db/index'
import { migrations } from '../schema'
import { sendOnelaMail } from '../../../integrations/microsoft/tenantDirectory'
import { setGmailSignature } from '../../../integrations/google/directory'
import { mapLimit } from '../../../lib/mapLimit'
import { resolveBulkTargetUpns } from '../agencyMembership'
import { logoBaseUrl, buildCredentialsEmail } from '../emailTemplates'
import { agencyCodeByUpnMap, signatureForUser } from '../signature'
import { serializeMigration } from '../serializers'

export const communicationRoutes = new Hono<{ Variables: RbacVariables }>()

// ── Envoi des accès (login + mot de passe) par e-mail ─────────────────────────
// Un compte est « prêt à envoyer » s'il a gohUpn + tempPassword et que la
// création du compte a réussi. On envoie à l'adresse @onela.com (Outlook, encore
// consultée). Trace `credentialsSentAt` pour éviter les doublons.
function readyToSend(m: typeof migrations.$inferSelect): boolean {
  return !!m.gohUpn && !!m.tempPassword && m.stepCreateAccount === 'success' && m.archived === 0
}

communicationRoutes.post('/:id/send-credentials', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  if (!row.gohUpn || !row.tempPassword) return c.json({ error: 'Compte Google non provisionné (pas de login / mot de passe)' }, 400)

  const { subject, html } = buildCredentialsEmail(row.onelaDisplayName, row.gohUpn, row.tempPassword, logoBaseUrl(c))
  try {
    await sendOnelaMail({ to: row.onelaEmail, subject, html })
  } catch (err) {
    return c.json({ error: 'Envoi e-mail échoué', message: err instanceof Error ? err.message : String(err) }, 502)
  }
  // En mode test, on ne marque pas l'envoi (pour que l'envoi réel reste possible).
  if (!process.env['CREDENTIALS_TEST_RECIPIENT']?.trim()) {
    await db.update(migrations).set({ credentialsSentAt: new Date() }).where(eq(migrations.id, id))
  }
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  return c.json(serializeMigration(updated!))
})

// Envoi groupé : par agence (agencyGroupId) ou par région (region).
communicationRoutes.post('/send-credentials-bulk', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const body = await c.req.json<{ agencyGroupId?: string; region?: string; force?: boolean }>().catch(() => ({} as { agencyGroupId?: string; region?: string; force?: boolean }))

  // Ensemble des UPN ciblés (minuscule)
  let targetUpns: Set<string>
  try {
    const resolved = await resolveBulkTargetUpns(body)
    if (!resolved) return c.json({ error: 'agencyGroupId ou region requis' }, 400)
    targetUpns = resolved
  } catch (err) {
    return c.json({ error: 'Lecture groupe ONELA échouée', message: err instanceof Error ? err.message : String(err) }, 502)
  }

  if (targetUpns.size === 0) return c.json({ sent: 0, skipped: 0, notReady: 0, failed: [] })

  const all = await db.select().from(migrations).where(eq(migrations.archived, 0))
  const candidates = all.filter((m) => targetUpns.has(m.onelaUpn.toLowerCase()))

  let sent = 0
  let skipped = 0
  let notReady = 0
  const failed: Array<{ upn: string; error: string }> = []

  const toSend = candidates.filter((m) => {
    if (!readyToSend(m)) { notReady++; return false }
    if (!body.force && m.credentialsSentAt) { skipped++; return false }
    return true
  })

  const testMode = !!process.env['CREDENTIALS_TEST_RECIPIENT']?.trim()
  const base = logoBaseUrl(c)
  await mapLimit(toSend, 4, async (m) => {
    const { subject, html } = buildCredentialsEmail(m.onelaDisplayName, m.gohUpn!, m.tempPassword!, base)
    try {
      await sendOnelaMail({ to: m.onelaEmail, subject, html })
      if (!testMode) await db.update(migrations).set({ credentialsSentAt: new Date() }).where(eq(migrations.id, m.id))
      sent++
    } catch (err) {
      failed.push({ upn: m.onelaUpn, error: err instanceof Error ? err.message : String(err) })
    }
  })

  return c.json({ sent, skipped, notReady, failed })
})

communicationRoutes.post('/:id/apply-signature', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Migration introuvable' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Compte Google non provisionné' }, 400)
  const codeMap = await agencyCodeByUpnMap()
  const { sendAs, html } = signatureForUser(row, codeMap, logoBaseUrl(c))
  try {
    await setGmailSignature(row.gohUpn, sendAs, html)
  } catch (err) {
    return c.json({ error: 'Signature échouée', message: err instanceof Error ? err.message : String(err) }, 502)
  }
  await db.update(migrations).set({ signatureAppliedAt: new Date() }).where(eq(migrations.id, id))
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  return c.json(serializeMigration(updated!))
})

communicationRoutes.post('/apply-signature-bulk', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const body = await c.req.json<{ agencyGroupId?: string; region?: string; force?: boolean }>().catch(() => ({} as { agencyGroupId?: string; region?: string; force?: boolean }))

  let targetUpns: Set<string>
  try {
    const resolved = await resolveBulkTargetUpns(body)
    if (!resolved) return c.json({ error: 'agencyGroupId ou region requis' }, 400)
    targetUpns = resolved
  } catch (err) {
    return c.json({ error: 'Lecture groupe ONELA échouée', message: err instanceof Error ? err.message : String(err) }, 502)
  }
  if (targetUpns.size === 0) return c.json({ applied: 0, skipped: 0, notReady: 0, failed: [] })

  const base = logoBaseUrl(c)
  const codeMap = await agencyCodeByUpnMap()
  const all = await db.select().from(migrations).where(eq(migrations.archived, 0))
  const candidates = all.filter((m) => targetUpns.has(m.onelaUpn.toLowerCase()))

  let applied = 0, skipped = 0, notReady = 0
  const failed: Array<{ upn: string; error: string }> = []
  const toApply = candidates.filter((m) => {
    if (!m.gohUpn || m.stepCreateAccount !== 'success') { notReady++; return false }
    if (!body.force && m.signatureAppliedAt) { skipped++; return false }
    return true
  })

  await mapLimit(toApply, 4, async (m) => {
    const { sendAs, html } = signatureForUser(m, codeMap, base)
    try {
      await setGmailSignature(m.gohUpn!, sendAs, html)
      await db.update(migrations).set({ signatureAppliedAt: new Date() }).where(eq(migrations.id, m.id))
      applied++
    } catch (err) {
      failed.push({ upn: m.onelaUpn, error: err instanceof Error ? err.message : String(err) })
    }
  })
  return c.json({ applied, skipped, notReady, failed })
})
