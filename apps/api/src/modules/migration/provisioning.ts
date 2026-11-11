import { eq } from 'drizzle-orm'
import { getDb } from '../../db/index'
import { migrations, migrationTargets } from './schema'
import { createGohUser, setGohUserAttributes, checkGohUserExists } from '../../integrations/microsoft/tenantDirectory'

// ── Provisioning Entra en background (séparé pour éviter le timeout HTTP) ────
// Chaque étape (create / setAttributes / link target) est tracée individuellement :
// si l'une échoue, seules les étapes effectivement échouées passent en 'error',
// pas les précédentes qui ont réussi.
export async function provisionAccountBackground(params: {
  migrationId: string
  givenName: string
  surname: string
  gohUpn: string
  onelaEmail: string
  onelaUpn: string
  onelaDisplayName: string
  onelaDepartment: string | null
  onelaJobTitle: string | null
  tempPassword: string
  ext10: string
  ext11: string
}) {
  const db = getDb()
  const { migrationId, gohUpn, onelaUpn, onelaEmail, onelaDisplayName, onelaDepartment, onelaJobTitle, tempPassword, ext10, ext11, givenName, surname } = params

  // Relire l'état actuel pour ne re-faire que les étapes pas encore en success
  const [current] = await db.select().from(migrations).where(eq(migrations.id, migrationId))
  if (!current) {
    console.error(`[provisioning] ${migrationId} introuvable, abandon`)
    return
  }

  // ── Étape 1 : créer le compte GOH ──
  let gohUserId: string | null = current.gohUserId
  if (current.stepCreateAccount !== 'success') {
    await db.update(migrations).set({ stepCreateAccount: 'running' }).where(eq(migrations.id, migrationId))
    try {
      const exists = await checkGohUserExists(gohUpn)
      if (exists) throw new Error(`Le compte ${gohUpn} existe déjà dans Entra GOH`)
      const gohUser = await createGohUser({
        givenName, surname, upn: gohUpn, displayName: onelaDisplayName,
        department: onelaDepartment, jobTitle: onelaJobTitle, tempPassword,
      })
      gohUserId = gohUser.id
      await db.update(migrations)
        .set({ gohUserId, stepCreateAccount: 'success' })
        .where(eq(migrations.id, migrationId))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[provisioning] ${migrationId} create error:`, msg)
      await db.update(migrations)
        .set({ stepCreateAccount: 'error', errorDetails: msg })
        .where(eq(migrations.id, migrationId))
      return
    }
  }

  // ── Étape 2 : poser extensionAttribute10 + 11 ──
  if (current.stepSetAttributes !== 'success') {
    if (!gohUserId) {
      await db.update(migrations).set({ stepSetAttributes: 'error', errorDetails: 'gohUserId manquant' }).where(eq(migrations.id, migrationId))
      return
    }
    await db.update(migrations).set({ stepSetAttributes: 'running' }).where(eq(migrations.id, migrationId))
    try {
      await setGohUserAttributes(gohUserId, ext10, ext11)
      await db.update(migrations)
        .set({ stepSetAttributes: 'success' })
        .where(eq(migrations.id, migrationId))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[provisioning] ${migrationId} setAttributes error:`, msg)
      await db.update(migrations)
        .set({ stepSetAttributes: 'error', errorDetails: msg })
        .where(eq(migrations.id, migrationId))
      return
    }
  }

  // ── Étape 3 : groupe dynamique (auto-géré par companyName=ONELA, mais on le marque) ──
  // Génération du script PowerShell + liaison target → considérés comme l'étape 3
  if (current.stepGroupMembership !== 'success') {
    try {
      const psScript = [
        `# Forwarding Exchange ONELA → Google pour ${onelaDisplayName}`,
        `# À exécuter dans Exchange Online PowerShell`,
        `Connect-ExchangeOnline -UserPrincipalName admin@onelaservices.onmicrosoft.com -Device`,
        `Set-Mailbox -Identity "${onelaEmail}" \\`,
        `  -ForwardingSMTPAddress "${ext10}" \\`,
        `  -DeliverToMailboxAndForward $true`,
        `# Vérification`,
        `Get-Mailbox -Identity "${onelaEmail}" | Select ForwardingSMTPAddress, DeliverToMailboxAndForward`,
      ].join('\n')

      await db.update(migrations)
        .set({ stepGroupMembership: 'success', exchangePsScript: psScript })
        .where(eq(migrations.id, migrationId))

      await db.update(migrationTargets)
        .set({ status: 'in_progress', migrationId })
        .where(eq(migrationTargets.onelaUpn, onelaUpn))

      console.log(`[provisioning] ${migrationId} OK (${onelaUpn} → ${gohUpn})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[provisioning] ${migrationId} groupMembership error:`, msg)
      await db.update(migrations)
        .set({ stepGroupMembership: 'error', errorDetails: msg })
        .where(eq(migrations.id, migrationId))
    }
  }
}
