import { Hono } from 'hono'
import { eq, desc, and, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { getDb } from '../../db/index'
import { migrations, migratedMessages, migratedEvents, migratedContacts, migrationTargets, licenseQuotas } from './schema'
import {
  searchOnelaUsers,
  createGohUser,
  setGohUserAttributes,
  checkGohUserExists,
  setOnelaMailForwarding,
  removeOnelaMailForwarding,
  checkOnelaMailForwarding,
  countOnelaUsersByDepartment,
  getOnelaGroupMembers,
  getOnelaGroupUsers,
  sendOnelaMail,
} from './service'

// Base URL publique pour les logos des e-mails (images servies par l'API, car
// l'inline CID ne s'affiche pas dans Outlook Web). Priorité à CREDENTIALS_LOGO_BASE_URL,
// sinon l'origine HTTPS de la requête courante.
function logoBaseUrl(c: { req: { header: (n: string) => string | undefined; url: string } }): string {
  const env = process.env['CREDENTIALS_LOGO_BASE_URL']?.trim()
  if (env) return env
  const host = c.req.header('host') ?? new URL(c.req.url).host
  return `https://${host}`
}
import { getServiceGroups } from './onelaServiceGroups'
import { getAgencyGroups, REGION_ORDER } from './onelaAgencyGroups'
import { agencyContactByCode, getAgencyContacts } from './onelaAgencyContacts'
import { googleUserExists, addGoogleAlias, moveUserToOu, countUsersInOu, setGmailSignature } from './googleService'
import { listLicenseSkusWithUsage, assignLicense, skuDisplayName } from './googleLicenseService'
import { ensureSendAs, setSendAsAsDefault } from '../shared-mailbox/gmailUserSetupService'
import { enqueueMailMigration, enqueueCalendarMigration, enqueueContactsMigration, signalStop, relabelMail } from './mailWorker'
import { gmailDedupeMailbox, fetchOnelaMessageMime, gmailImportMime } from './mailService'
import type {
  SearchOnelaUsersResponse,
  MigrateUsersRequest,
  MigrateExistingRequest,
  MigrateUsersResponse,
  MigrationHistoryResponse,
  MigratedUpnsResponse,
} from '@dsi-app/shared'

// Normalise une partie de nom (prénom / nom) pour la partie locale d'email.
// Conserve les tirets des prénoms/noms composés (ex. « Anne-Marie » →
// « anne-marie »), comme le module de création de compte. Les espaces et « _ »
// deviennent des tirets, on ne garde que lettres et tiret, tirets multiples
// réduits à un seul, pas de tiret en début/fin.
function normalizeNamePart(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Exécute `fn` sur `items` avec au plus `limit` appels en parallèle (évite de
// saturer / faire throttler Graph quand on interroge des dizaines de groupes).
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let i = 0
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Cache mémoire de l'appartenance agence → région (calculée en direct via Graph :
// les membres d'une agence appartiennent tous à une seule Direction Régionale).
// Coûteux (≈70 appels) → mis en cache ; les compteurs de statut sont recalculés
// à chaque requête depuis la BDD (donc toujours frais).
interface AgencyMembership { code: string; name: string; groupId: string; regionLabel: string; upns: string[]; mails: string[] }
let membershipCache: { at: number; agencies: AgencyMembership[]; errors: string[] } | null = null
const MEMBERSHIP_TTL = 5 * 60_000
const NO_REGION = 'Sans région'

// La région vient du mapping statique (onelaAgencyGroups.ts) ; on ne fait qu'un
// appel Graph par agence pour compter ses membres actifs.
async function buildAgencyMembership(): Promise<{ agencies: AgencyMembership[]; errors: string[] }> {
  const agencies = getAgencyGroups()
  const errors: string[] = []

  const agencyResults = await mapLimit(agencies, 6, async (a) => {
    try { return { def: a, members: await getOnelaGroupMembers(a.groupId) } }
    catch (e) { errors.push(`Agence ${a.code}: ${e instanceof Error ? e.message : String(e)}`); return null }
  })
  const built: AgencyMembership[] = []
  for (const ar of agencyResults) {
    if (!ar) continue
    built.push({
      code: ar.def.code,
      name: ar.def.name,
      groupId: ar.def.groupId,
      regionLabel: ar.def.region || NO_REGION,
      upns: ar.members.map((m) => m.upn),
      mails: ar.members.map((m) => m.mail ?? ''),
    })
  }
  return { agencies: built, errors }
}

// ── Statut de migration par utilisateur (source autoritaire : table `migrations`) ─
// Dérivé des mêmes champs que les cartes, pour que compteurs (arbre agences,
// effectifs services) et sélecteur de membres soient toujours cohérents entre eux.
// Indexé en CASSE INSENSIBLE par UPN ET e-mail (les UPN/mails ONELA ont parfois des
// majuscules, ex. EALMEIDADESOUSA@onela.com) + par identifiant Graph (le plus fiable).
//  • 'done'        = migration archivée OU les 3 phases data réussies.
//  • 'in_progress' = migration lancée mais pas encore terminée (compte provisionné,
//                    mail en cours / en pause, etc.).
type UserMigStatus = 'done' | 'in_progress'
function deriveMigStatus(r: { archived: number; mail: string; cal: string; con: string }): UserMigStatus {
  const dataDone = r.mail === 'success' && r.cal === 'success' && r.con === 'success'
  return r.archived === 1 || dataDone ? 'done' : 'in_progress'
}
async function loadUserStatus(db: ReturnType<typeof getDb>): Promise<{
  byKey: Map<string, UserMigStatus>
  byId: Map<string, UserMigStatus>
}> {
  const rows = await db
    .select({
      userId: migrations.onelaUserId,
      upn: migrations.onelaUpn,
      email: migrations.onelaEmail,
      archived: migrations.archived,
      mail: migrations.stepMailMigration,
      cal: migrations.stepCalendarMigration,
      con: migrations.stepContactsMigration,
    })
    .from(migrations)
  const byKey = new Map<string, UserMigStatus>()
  const byId = new Map<string, UserMigStatus>()
  const rank: Record<UserMigStatus, number> = { in_progress: 1, done: 2 }
  const put = (map: Map<string, UserMigStatus>, k: string | null | undefined, s: UserMigStatus) => {
    if (!k) return
    const cur = map.get(k)
    if (!cur || rank[s] > rank[cur]) map.set(k, s) // 'done' l'emporte en cas de doublon
  }
  for (const r of rows) {
    const s = deriveMigStatus({ archived: r.archived, mail: r.mail, cal: r.cal, con: r.con })
    put(byKey, r.upn?.toLowerCase(), s)
    put(byKey, r.email?.toLowerCase(), s)
    put(byId, r.userId, s)
  }
  return { byKey, byId }
}

// E-mail d'accès envoyé à l'utilisateur migré (login Google + mot de passe
// temporaire + consignes de 1ʳᵉ connexion). Surchargeable via env.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
export function buildCredentialsEmail(displayName: string, gohUpn: string, tempPassword: string, logoBase: string): { subject: string; html: string } {
  const subject = process.env['CREDENTIALS_EMAIL_SUBJECT'] || 'Vos accès à votre nouvelle messagerie Google Workspace'
  const firstName = escapeHtml(displayName.split(' ')[0] || displayName)
  const login = escapeHtml(gohUpn)
  const pwd = escapeHtml(tempPassword)
  const base = logoBase.replace(/\/$/, '')
  // Charte : ONELA violet #662D91 / magenta #E5007D · Ouihelp navy #10243E / vert #3ECF8E
  const html = `
<div style="margin:0;padding:0;background:#f4f4f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(17,24,39,.08);font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
        <tr><td style="height:6px;line-height:6px;font-size:0;background:#662D91;background:linear-gradient(90deg,#662D91 0%,#E5007D 50%,#3ECF8E 100%);">&nbsp;</td></tr>
        <tr><td style="padding:26px 32px 6px;text-align:center;">
          <img src="${base}/assets/logo/onela.png" alt="ONELA" width="104" style="height:auto;vertical-align:middle;" />
          <span style="color:#c4c4cc;font-size:20px;padding:0 16px;vertical-align:middle;">&#8594;</span>
          <img src="${base}/assets/logo/ouihelp.png" alt="Ouihelp" width="124" style="height:auto;vertical-align:middle;" />
        </td></tr>
        <tr><td style="padding:8px 32px 0;text-align:center;">
          <h1 style="margin:10px 0 2px;font-size:21px;color:#111827;font-weight:700;">Votre nouvelle messagerie est prête</h1>
          <p style="margin:0;color:#8b8f98;font-size:13px;">Migration vers Google&nbsp;Workspace</p>
        </td></tr>
        <tr><td style="padding:22px 32px 6px;color:#374151;font-size:14px;line-height:1.6;">
          <p style="margin:0 0 10px;">Bonjour <b>${firstName}</b>,</p>
          <p style="margin:0;">Votre boîte mail a été migrée avec succès. Voici vos accès pour votre <b>première connexion</b>&nbsp;:</p>
        </td></tr>
        <tr><td style="padding:10px 32px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf5ff;border:1px solid #ecd9fb;border-radius:12px;">
            <tr><td style="padding:18px 22px;">
              <p style="margin:0 0 3px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9333ea;">Identifiant</p>
              <p style="margin:0 0 14px;font-family:'Courier New',monospace;font-size:16px;color:#111827;word-break:break-all;">${login}</p>
              <p style="margin:0 0 3px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9333ea;">Mot de passe temporaire</p>
              <p style="margin:0;font-family:'Courier New',monospace;font-size:16px;color:#111827;">${pwd}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 32px 6px;text-align:center;">
          <a href="https://accounts.google.com" style="display:inline-block;background:#3ECF8E;color:#06351f;text-decoration:none;font-weight:700;font-size:15px;padding:13px 30px;border-radius:10px;">Créer mon profil Chrome Pro &#8594;</a>
        </td></tr>
        <tr><td style="padding:14px 32px 2px;color:#374151;font-size:13px;line-height:1.7;">
          <p style="margin:0 0 8px;font-weight:700;color:#111827;">Créez votre profil professionnel sur Google&nbsp;Chrome&nbsp;:</p>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:top;color:#E5007D;font-weight:bold;padding-right:8px;">1.</td><td style="padding-bottom:4px;">Dans Google&nbsp;Chrome, cliquez sur votre <b>photo de profil</b> (en haut à droite) puis sur <b>«&nbsp;Ajouter&nbsp;»</b> &rarr; <b>«&nbsp;Se connecter&nbsp;»</b>.</td></tr>
          <tr><td style="vertical-align:top;color:#E5007D;font-weight:bold;padding-right:8px;">2.</td><td style="padding-bottom:4px;">Connectez-vous avec l'identifiant et le mot de passe temporaire ci-dessus. Chrome créera automatiquement votre <b>profil professionnel ONELA</b>.</td></tr>
          <tr><td style="vertical-align:top;color:#E5007D;font-weight:bold;padding-right:8px;">3.</td><td style="padding-bottom:4px;">Définissez votre nouveau mot de passe personnel.</td></tr>
          <tr><td style="vertical-align:top;color:#E5007D;font-weight:bold;padding-right:8px;">4.</td><td>Utilisez désormais ce profil Pro pour votre messagerie et vos outils ONELA.</td></tr></table>
        </td></tr>
        <tr><td style="padding:14px 32px 0;">
          <p style="margin:0;background:#fff7ed;border-left:3px solid #f59e0b;padding:11px 14px;border-radius:6px;font-size:12px;color:#92400e;line-height:1.5;">🔒 Pour votre sécurité, un nouveau mot de passe vous sera demandé dès la première connexion.</p>
        </td></tr>
        <tr><td style="padding:24px 32px 26px;text-align:center;border-top:1px solid #f0f0f2;">
          <p style="margin:18px 0 2px;color:#6b7280;font-size:12px;">Une question&nbsp;? Écrivez-nous à <a href="mailto:dsi@onela.com" style="color:#662D91;font-weight:600;">dsi@onela.com</a></p>
          <p style="margin:0;color:#b9bcc3;font-size:11px;">Service Informatique ONELA · <span style="color:#E5007D;">être bien chez soi</span></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</div>`.trim()
  return { subject, html }
}

// Adresse du siège (pas de téléphone — tout le monde n'a pas de ligne).
const SIG_HQ = { adresse: '8 rue François Ory', cpVille: '92120 Montrouge', tel: '' }

// Signature ONELA fidèle au modèle validé Marketing (bloc gauche + bloc texte +
// icônes réseaux). Images servies en URL publique (base). Lignes vides masquées.
function buildSignatureHtml(p: { name: string; poste: string; tel: string; adresse: string; cpVille: string; email: string; base: string }): string {
  const base = p.base.replace(/\/$/, '')
  const e = escapeHtml
  const maps = (q: string) => `https://www.google.com/maps/search/${encodeURIComponent(q)}`
  const localPart = e(p.email.split('@')[0] ?? p.email)
  const domain = e(p.email.split('@')[1] ?? 'onela.com')
  const telLine = p.tel ? `<div style="font-size:10pt;color:#595857;">${e(p.tel)}</div>` : ''
  const addrLines = p.adresse && p.cpVille
    ? `<div style="font-size:8pt;"><a href="${maps(`${p.adresse} ${p.cpVille}`)}" target="_blank" style="color:#1155CC;text-decoration:none;">${e(p.adresse)}</a></div>`
      + `<div style="font-size:8pt;"><a href="${maps(`${p.adresse} ${p.cpVille}`)}" target="_blank" style="color:#1155CC;text-decoration:none;">${e(p.cpVille)}</a></div>`
    : ''
  return `<table cellspacing="0" cellpadding="0" style="background:#fff;border-collapse:collapse;">
 <tr style="height:67.5pt">
  <td width="162" rowspan="2" style="border-right:1px solid #623D8F;padding:3px;vertical-align:top;">
    <a href="https://www.onela.com/" target="_blank"><img src="${base}/assets/logo/sig-block.png" width="140" height="106" border="0" style="display:block" alt="ONELA - être bien chez soi"></a>
  </td>
  <td style="padding:3px 3px 3px 10px;vertical-align:top;font-family:'Century Gothic',Arial,sans-serif;">
    <div><b style="font-size:11pt;color:#623D8F;">${e(p.name)}</b></div>
    ${p.poste ? `<div><b style="font-size:9pt;color:#595857;">${e(p.poste)}</b></div>` : ''}
    ${telLine}
    ${addrLines}
    <div style="font-size:8pt;"><a href="mailto:${e(p.email)}" target="_blank" style="color:#0563C1;"><u>${localPart}</u>@${domain}</a></div>
  </td>
 </tr>
 <tr style="height:16.5pt">
  <td style="padding:3px 3px 3px 10px;vertical-align:top;">
    <a href="https://www.linkedin.com/company/onela-etre-bien-chez-soi/" target="_blank"><img src="${base}/assets/logo/sig-linkedin.png" width="12" height="12" border="0" style="margin-right:5px" alt="LinkedIn"></a>
    <a href="https://www.facebook.com/people/ONELA/100076338856489/" target="_blank"><img src="${base}/assets/logo/sig-facebook.png" width="13" height="13" border="0" style="margin-right:5px" alt="Facebook"></a>
    <a href="https://www.instagram.com/onela_france/" target="_blank"><img src="${base}/assets/logo/sig-instagram.png" width="13" height="13" border="0" alt="Instagram"></a>
  </td>
 </tr>
</table>`
}

// Adresse d'envoi « nouveau format » prenom.nom@onela.com (ou domaine onelaUpn).
function newFormatEmail(gohUpn: string, onelaUpn: string): string {
  const local = gohUpn.split('@')[0] ?? gohUpn
  const domain = onelaUpn.split('@')[1] ?? 'onela.com'
  return `${local}@${domain}`
}

export const migrationRouter = new Hono<{ Variables: RbacVariables }>()

migrationRouter.use('*', authMiddleware, loadUserRole)

// ── Recherche users ONELA ─────────────────────────────────────────────────────
migrationRouter.get('/search', requirePermission('migration:read'), async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q || q.length < 2) {
    return c.json<SearchOnelaUsersResponse>({ users: [] })
  }

  let graphUsers
  try {
    graphUsers = await searchOnelaUsers(q)
  } catch (err) {
    console.error('[migration/search] Graph error:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Graph error', message: err instanceof Error ? err.message : String(err) }, 502)
  }

  const users = graphUsers.map((u) => ({
    id: u.id,
    displayName: u.displayName,
    givenName: u.givenName ?? '',
    surname: u.surname ?? '',
    upn: u.userPrincipalName,
    email: u.mail ?? u.userPrincipalName,
    department: u.department ?? null,
    jobTitle: u.jobTitle ?? null,
    companyName: u.companyName ?? null,
  }))

  return c.json<SearchOnelaUsersResponse>({ users })
})

// ── Lancer la migration ───────────────────────────────────────────────────────
// Stratégie : on insère TOUS les records en pending immédiatement (synchrone, rapide),
// on répond 202 au front, puis on traite les étapes Graph en background (par user, en
// parallèle limité). Évite le timeout HTTP Azure (~230s) sur les gros lots.
migrationRouter.post('/run', requirePermission('migration:read'), async (c) => {
  const body = await c.req.json<MigrateUsersRequest>()
  const initiatedBy = c.get('dbUser').email
  const db = getDb()

  const inserted: Array<typeof migrations.$inferSelect> = []
  const skipped: Array<{ onelaUpn: string; reason: string; existingMigrationId: string }> = []

  for (const u of body.users) {
    // ── Idempotency : refuser si déjà une migration non-archivée pour ce user ──
    const existing = await db
      .select({ id: migrations.id })
      .from(migrations)
      .where(and(eq(migrations.onelaUserId, u.onelaUserId), eq(migrations.archived, 0)))
      .limit(1)
    if (existing.length > 0) {
      skipped.push({
        onelaUpn: u.onelaUpn,
        reason: 'Migration déjà en cours / existante pour ce compte (archive-la d\'abord pour relancer)',
        existingMigrationId: existing[0]!.id,
      })
      continue
    }

    const migrationId = randomUUID()

    // Générer UPN GOH : prenom.nom@mig.onela.com (tirets des noms composés conservés)
    const firstName = normalizeNamePart(u.givenName)
    const lastName = normalizeNamePart(u.surname)
    const gohUpn = `${firstName}.${lastName}@mig.onela.com`
    const onelaDomain = u.onelaEmail.split('@')[1] ?? 'onela.com'
    const ext10 = `${firstName}.${lastName}@onela.fr`
    const ext11 = `${firstName}.${lastName}@${onelaDomain}`
    const tempPassword = `Tmp-${Math.random().toString(36).slice(2, 8)}#Az1`

    // Insérer l'enregistrement avec stepCreateAccount='pending' (sera passé à 'running' par le job background)
    await db.insert(migrations).values({
      id: migrationId,
      onelaUserId: u.onelaUserId,
      onelaUpn: u.onelaUpn,
      onelaDisplayName: u.onelaDisplayName,
      onelaEmail: u.onelaEmail,
      onelaDepartment: u.onelaDepartment,
      onelaJobTitle: u.onelaJobTitle,
      gohUpn,
      tempPassword,
      initiatedBy,
      stepCreateAccount: 'pending',
      stepSetAttributes: 'pending',
      stepGroupMembership: 'pending',
      stepMailMigration: 'skipped',
      stepCalendarMigration: 'skipped',
      stepContactsMigration: 'skipped',
      stepGoogleAlias: 'skipped',
      stepOuMove: 'skipped',
    })

    const [row] = await db.select().from(migrations).where(eq(migrations.id, migrationId))
    if (row) inserted.push(row)

    // Lancer le provisioning en background (fire-and-forget)
    void provisionAccountBackground({
      migrationId,
      givenName: u.givenName,
      surname: u.surname,
      gohUpn,
      onelaEmail: u.onelaEmail,
      onelaUpn: u.onelaUpn,
      onelaDisplayName: u.onelaDisplayName,
      onelaDepartment: u.onelaDepartment,
      onelaJobTitle: u.onelaJobTitle,
      tempPassword,
      ext10,
      ext11,
    })
  }

  const response: MigrateUsersResponse & { skipped?: typeof skipped } = {
    migrations: inserted.map(serializeMigration),
    ...(skipped.length > 0 ? { skipped } : {}),
  }
  return c.json(response, 202)
})

// ── Provisioning Entra en background (séparé pour éviter le timeout HTTP) ────
// Chaque étape (create / setAttributes / link target) est tracée individuellement :
// si l'une échoue, seules les étapes effectivement échouées passent en 'error',
// pas les précédentes qui ont réussi.
async function provisionAccountBackground(params: {
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

// ── Retry du provisioning (pour les comptes qui ont échoué) ──────────────────
migrationRouter.post('/:id/retry-provisioning', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'gohUpn manquant — record corrompu' }, 400)

  // On ne relance que les étapes qui sont en 'error' ou 'pending', pas celles déjà 'success'
  const needsCreate = row.stepCreateAccount === 'error' || row.stepCreateAccount === 'pending'
  const needsAttrs = row.stepSetAttributes === 'error' || row.stepSetAttributes === 'pending'
  const needsGroup = row.stepGroupMembership === 'error' || row.stepGroupMembership === 'pending'

  if (!needsCreate && !needsAttrs && !needsGroup) {
    return c.json({ error: 'Toutes les étapes sont déjà en success ou skipped' }, 400)
  }

  // Reconstituer les inputs depuis le record
  const firstName = row.gohUpn.split('.')[0] ?? ''
  const lastName = (row.gohUpn.split('@')[0] ?? '').split('.').slice(1).join('.')
  const onelaDomain = row.onelaEmail.split('@')[1] ?? 'onela.com'
  const ext10 = `${firstName}.${lastName}@onela.fr`
  const ext11 = `${firstName}.${lastName}@${onelaDomain}`

  // Reset error fields avant retry
  await db.update(migrations).set({ errorDetails: null }).where(eq(migrations.id, row.id))

  void provisionAccountBackground({
    migrationId: row.id,
    givenName: firstName,
    surname: lastName,
    gohUpn: row.gohUpn,
    onelaEmail: row.onelaEmail,
    onelaUpn: row.onelaUpn,
    onelaDisplayName: row.onelaDisplayName,
    onelaDepartment: row.onelaDepartment,
    onelaJobTitle: row.onelaJobTitle,
    tempPassword: row.tempPassword ?? `Tmp-${Math.random().toString(36).slice(2, 8)}#Az1`,
    ext10, ext11,
  })

  return c.json({ message: 'Retry lancé en background', migrationId: row.id }, 202)
})

// ── Migration vers compte Google existant (sans création Entra GOH) ──────────
migrationRouter.post('/run-existing', requirePermission('migration:read'), async (c) => {
  const body = await c.req.json<MigrateExistingRequest>()
  const initiatedBy = c.get('dbUser').email
  const db = getDb()

  if (!body.targetGoogleEmail?.includes('@')) {
    return c.json({ error: 'targetGoogleEmail invalide' }, 400)
  }

  const migrationId = randomUUID()
  const now = new Date()

  // Insérer le record avec toutes les étapes Entra/compte marquées 'skipped'
  await db.insert(migrations).values({
    id: migrationId,
    onelaUserId: body.onelaUserId,
    onelaUpn: body.onelaUpn,
    onelaDisplayName: body.onelaDisplayName,
    onelaEmail: body.onelaEmail,
    onelaDepartment: body.onelaDepartment,
    onelaJobTitle: body.onelaJobTitle,
    gohUpn: body.targetGoogleEmail,
    initiatedBy,
    stepCreateAccount: 'skipped',
    stepSetAttributes: 'skipped',
    stepGroupMembership: 'skipped',
    stepGoogleAlias: 'skipped',
    stepMailMigration: 'skipped',
    stepCalendarMigration: 'skipped',
    stepContactsMigration: 'skipped',
    stepOuMove: 'skipped',
    createdAt: now,
    updatedAt: now,
  })

  // Lier la cible de migration si elle existe
  await db.update(migrationTargets)
    .set({ status: 'in_progress', migrationId })
    .where(eq(migrationTargets.onelaUpn, body.onelaUpn))

  const [row] = await db.select().from(migrations).where(eq(migrations.id, migrationId))
  if (!row) return c.json({ error: 'Erreur interne' }, 500)

  const response: MigrateUsersResponse = { migrations: [serializeMigration(row)] }
  return c.json(response, 201)
})

// ── Historique des migrations ─────────────────────────────────────────────────
// `archived=1` renvoie l'historique paginé, sinon les migrations actives.
// Les deux jeux sont filtrés côté SQL : sans ça, un lot d'archives récentes
// pouvait pousser des migrations actives hors de la page 1 et les faire
// disparaître de l'écran.
const HISTORY_MAX_LIMIT = 200

migrationRouter.get('/history', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const archivedFlag = ['1', 'true'].includes(c.req.query('archived') ?? '') ? 1 : 0
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const requestedLimit = Number(c.req.query('limit')) || (archivedFlag ? 50 : HISTORY_MAX_LIMIT)
  const limit = Math.min(HISTORY_MAX_LIMIT, Math.max(1, requestedLimit))
  const offset = (page - 1) * limit
  const where = eq(migrations.archived, archivedFlag)

  const [rows, countRows] = await Promise.all([
    db.select().from(migrations).where(where).orderBy(desc(migrations.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(migrations).where(where),
  ])

  const total = Number(countRows[0]?.n ?? rows.length)
  const response: MigrationHistoryResponse = {
    migrations: rows.map(serializeMigrationLight),
    total,
    page,
    limit,
    hasMore: offset + rows.length < total,
  }
  return c.json(response)
})

// ── UPN déjà migrés (badge « déjà migré » dans la recherche) ──────────────────
// Endpoint dédié : la liste des actives ne suffit plus pour ce test depuis que
// l'historique est paginé séparément.
migrationRouter.get('/migrated-upns', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const rows = await db
    .selectDistinct({ upn: migrations.onelaUpn })
    .from(migrations)
    .where(inArray(migrations.stepCreateAccount, ['success', 'skipped']))

  const response: MigratedUpnsResponse = { upns: rows.map((r) => r.upn) }
  return c.json(response)
})

// ── Activer le nouveau format prenom.nom@onela.com (alias + send-as) ────────
// Le user a déjà l'alias legacy pnom@onela.com ; on ajoute ici l'alias
// prenom.nom@onela.com PLUS une identité "Envoyer en tant que" pour qu'il
// puisse communiquer en sortant avec le nouveau format dès la migration.
migrationRouter.post('/:id/activate-new-format', requirePermission('migration:write'), async (c) => {
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
migrationRouter.post('/:id/google-alias', requirePermission('migration:read'), async (c) => {
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
migrationRouter.post('/:id/move-ou', requirePermission('migration:read'), async (c) => {
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

// ── Lancer la migration mail (worker en background) ──────────────────────────
migrationRouter.post('/:id/migrate-mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration de compte non réussie, mail impossible' }, 400)
  }
  if (row.stepMailMigration === 'running' || row.stepMailMigration === 'pending') {
    return c.json({ error: 'Migration mail déjà en cours' }, 409)
  }

  // Sens du parcours : 'desc' = récents d'abord (défaut), 'asc' = anciens d'abord.
  // beforeDays (optionnel) : ne migrer que les mails reçus il y a plus de N jours
  // (passe « anciens » bornée à J-N). Borné à [1, 3650] ; sinon pas de plafond.
  const body = await c.req.json<{ order?: string; beforeDays?: number }>().catch(() => ({} as { order?: string; beforeDays?: number }))
  const order: 'asc' | 'desc' = body.order === 'asc' ? 'asc' : 'desc'
  const beforeDays =
    typeof body.beforeDays === 'number' && Number.isFinite(body.beforeDays) && body.beforeDays >= 1
      ? Math.min(Math.floor(body.beforeDays), 3650)
      : null

  await enqueueMailMigration(id, order, beforeDays)
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated), 202)
})

// ── Licences Google Workspace ────────────────────────────────────────────────
// Découvre les licences en usage + le nombre assigné à chacune. On y ajoute le total
// de sièges (saisi manuellement dans license_quotas — Google n'expose pas les sièges
// achetés par API) pour afficher « restantes = total − utilisées ».
migrationRouter.get('/license-skus', requirePermission('migration:read'), async (c) => {
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

// ── Stats LIVE (source de vérité : les tenants, pas le CSV importé) ───────────
// - onelaTotal   : population à migrer, comptée en direct dans le tenant ONELA
// - googleMigrated : comptes déjà présents dans l'OU /onela.com côté Ouihelp
// - activeMigrations : migrations réellement actives (table migrations, non archivées)
// - licenses     : total de sièges dispo (somme des « restantes » saisies)
// Chaque source est isolée : si un appel tenant échoue, son champ vaut null et
// le front retombe sur le CSV — rien ne casse.
migrationRouter.get('/live-stats', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const ouPath = process.env['GOOGLE_ONELA_OU_PATH'] ?? '/onela.com'

  const [onelaRes, googleRes, activeRes, licRes] = await Promise.allSettled([
    countOnelaUsersByDepartment(),
    countUsersInOu(ouPath),
    db.select({ n: sql<number>`COUNT(*)` }).from(migrations).where(eq(migrations.archived, 0)),
    (async () => {
      const [skus, quotas] = await Promise.all([listLicenseSkusWithUsage(), db.select().from(licenseQuotas)])
      const usedBySku = new Map(skus.map((s) => [s.skuId, s.used]))
      let totalSeats = 0
      let totalUsed = 0
      let hasQuota = false
      const perSku = quotas.map((q) => {
        hasQuota = true
        const used = usedBySku.get(q.skuId) ?? 0
        totalSeats += q.totalSeats
        totalUsed += used
        return { skuId: q.skuId, name: skuDisplayName(q.skuId), total: q.totalSeats, used, remaining: q.totalSeats - used }
      })
      return { hasQuota, totalSeats, totalUsed, totalRemaining: totalSeats - totalUsed, perSku }
    })(),
  ])

  const errors: string[] = []
  const pick = <T,>(r: PromiseSettledResult<T>, label: string): T | null => {
    if (r.status === 'fulfilled') return r.value
    errors.push(`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
    return null
  }

  const activeRows = pick(activeRes, 'migrations')
  const licenses = pick(licRes, 'licences')
  const onela = pick(onelaRes, 'ONELA')

  return c.json({
    onelaTotal: onela ? onela.total : null,
    onelaByDept: onela ? onela.byDept : null,
    googleMigrated: pick(googleRes, 'Google'),
    activeMigrations: activeRows ? Number(activeRows[0]?.n ?? 0) : null,
    licenses: licenses && licenses.hasQuota ? licenses : null,
    errors,
  })
})

// ── Effectifs par service via les groupes de sécurité ONELA ───────────────────
// total = membres actifs @onela.com du groupe (live) ; terminés / en cours =
// statut de ces membres dans le suivi (migration_targets, lookup par UPN/mail).
// Les départs sortent du total (plus dans le groupe), les arrivées y entrent
// (comptées « en attente »). Chaque groupe est isolé : un échec ne casse pas les
// autres et le service concerné est listé dans `errors`.
migrationRouter.get('/service-group-counts', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const groups = getServiceGroups()

  const { byKey } = await loadUserStatus(db)

  const settled = await Promise.allSettled(groups.map((g) => getOnelaGroupMembers(g.groupId)))

  const errors: string[] = []
  const rows = groups.map((g, i) => {
    const r = settled[i]!
    if (r.status === 'rejected') {
      errors.push(`${g.label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
      return null
    }
    let done = 0
    let inProgress = 0
    for (const m of r.value) {
      const status = byKey.get(m.upn.toLowerCase()) ?? (m.mail ? byKey.get(m.mail.toLowerCase()) : undefined)
      if (status === 'done') done++
      else if (status === 'in_progress') inProgress++
    }
    return { label: g.label, groupId: g.groupId, total: r.value.length, done, in_progress: inProgress }
  }).filter((r): r is { label: string; groupId: string; total: number; done: number; in_progress: number } => r !== null)

  return c.json({ rows, errors })
})

// ── Arbre agences par région (pour la migration des agences) ──────────────────
// Régions → agences avec effectifs (membres actifs du groupe) et statut de suivi.
// L'appartenance agence→région (Graph) est mise en cache ; les compteurs de
// statut sont recalculés à chaque requête. `?fresh=1` force le recalcul Graph.
migrationRouter.get('/agencies-tree', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const fresh = ['1', 'true'].includes(c.req.query('fresh') ?? '')
  if (fresh || !membershipCache || Date.now() - membershipCache.at > MEMBERSHIP_TTL) {
    try {
      const built = await buildAgencyMembership()
      membershipCache = { at: Date.now(), ...built }
    } catch (err) {
      return c.json({ error: 'ONELA groups', message: err instanceof Error ? err.message : String(err) }, 502)
    }
  }
  const cache = membershipCache

  const { byKey } = await loadUserStatus(db)

  interface RegionAcc { label: string; total: number; done: number; in_progress: number; agencies: Array<{ code: string; name: string; groupId: string; total: number; done: number; in_progress: number }> }
  const byRegion = new Map<string, RegionAcc>()
  const region = (label: string): RegionAcc => {
    let r = byRegion.get(label)
    if (!r) { r = { label, total: 0, done: 0, in_progress: 0, agencies: [] }; byRegion.set(label, r) }
    return r
  }

  for (const a of cache.agencies) {
    let done = 0
    let inProgress = 0
    for (let k = 0; k < a.upns.length; k++) {
      const status = byKey.get(a.upns[k]!.toLowerCase()) ?? (a.mails[k] ? byKey.get(a.mails[k]!.toLowerCase()) : undefined)
      if (status === 'done') done++
      else if (status === 'in_progress') inProgress++
    }
    const r = region(a.regionLabel)
    r.agencies.push({ code: a.code, name: a.name, groupId: a.groupId, total: a.upns.length, done, in_progress: inProgress })
    r.total += a.upns.length; r.done += done; r.in_progress += inProgress
  }

  const orderIdx = (label: string) => {
    const i = REGION_ORDER.indexOf(label)
    return i === -1 ? (label === NO_REGION ? 999 : 500) : i
  }
  const regions = [...byRegion.values()]
    .map((r) => ({ ...r, agencies: r.agencies.sort((x, y) => x.name.localeCompare(y.name, 'fr')) }))
    .sort((x, y) => orderIdx(x.label) - orderIdx(y.label))

  return c.json({ regions, errors: cache.errors, cachedAt: cache.at })
})

// Membres (détaillés) d'un groupe ONELA, avec statut migration, pour sélection
// avant lancement. Utilisé par le drill-down d'agence.
migrationRouter.get('/group-members/:groupId', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const groupId = c.req.param('groupId')
  let graphUsers
  try {
    graphUsers = await getOnelaGroupUsers(groupId)
  } catch (err) {
    return c.json({ error: 'ONELA group', message: err instanceof Error ? err.message : String(err) }, 502)
  }
  const { byKey, byId } = await loadUserStatus(db)
  // 'done' = migré (ou archivé) · 'active' = en cours · 'none' = pas encore lancé.
  // Match par id Graph (fiable) puis repli UPN/mail en minuscules.
  const statusFor = (u: { id: string; userPrincipalName: string; mail?: string | null }): 'done' | 'active' | 'none' => {
    const s = byId.get(u.id)
      ?? byKey.get(u.userPrincipalName.toLowerCase())
      ?? (u.mail ? byKey.get(u.mail.toLowerCase()) : undefined)
    return s === 'done' ? 'done' : s === 'in_progress' ? 'active' : 'none'
  }

  const users = graphUsers
    .map((u) => ({
      id: u.id,
      displayName: u.displayName,
      givenName: u.givenName ?? '',
      surname: u.surname ?? '',
      upn: u.userPrincipalName,
      email: u.mail ?? u.userPrincipalName,
      department: u.department ?? null,
      jobTitle: u.jobTitle ?? null,
      migrationStatus: statusFor(u),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'))

  return c.json({ users })
})

// ── Envoi des accès (login + mot de passe) par e-mail ─────────────────────────
// Un compte est « prêt à envoyer » s'il a gohUpn + tempPassword et que la
// création du compte a réussi. On envoie à l'adresse @onela.com (Outlook, encore
// consultée). Trace `credentialsSentAt` pour éviter les doublons.
function readyToSend(m: typeof migrations.$inferSelect): boolean {
  return !!m.gohUpn && !!m.tempPassword && m.stepCreateAccount === 'success' && m.archived === 0
}

migrationRouter.post('/:id/send-credentials', requirePermission('migration:write'), async (c) => {
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
migrationRouter.post('/send-credentials-bulk', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const body = await c.req.json<{ agencyGroupId?: string; region?: string; force?: boolean }>().catch(() => ({} as { agencyGroupId?: string; region?: string; force?: boolean }))

  // Ensemble des UPN ciblés (minuscule)
  const targetUpns = new Set<string>()
  try {
    if (body.agencyGroupId) {
      for (const m of await getOnelaGroupMembers(body.agencyGroupId)) targetUpns.add(m.upn)
    } else if (body.region) {
      if (!membershipCache || Date.now() - membershipCache.at > MEMBERSHIP_TTL) {
        const built = await buildAgencyMembership()
        membershipCache = { at: Date.now(), ...built }
      }
      for (const a of membershipCache.agencies) {
        if (a.regionLabel === body.region) for (const u of a.upns) targetUpns.add(u)
      }
    } else {
      return c.json({ error: 'agencyGroupId ou region requis' }, 400)
    }
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

// ── Application de la signature Gmail ─────────────────────────────────────────
// Construit la signature (nom/poste/email via Graph + adresse/tél de l'agence via
// le CSV, siège = Montrouge sans tél), la pose sur le send-as prenom.nom@onela.com
// et en fait l'adresse par défaut. Trace signatureAppliedAt.
async function agencyCodeByUpnMap(): Promise<Map<string, string>> {
  if (!membershipCache || Date.now() - membershipCache.at > MEMBERSHIP_TTL) {
    const built = await buildAgencyMembership()
    membershipCache = { at: Date.now(), ...built }
  }
  const map = new Map<string, string>()
  for (const a of membershipCache.agencies) {
    for (const upn of a.upns) map.set(upn, a.code)
    for (const mail of a.mails) if (mail) map.set(mail.toLowerCase(), a.code)
  }
  return map
}

// Repli : déduire le code agence de l'attribut `department` (code « NOI » ou nom
// « Noisy-le-sec »), quand l'appartenance au groupe de sécurité ne l'a pas donné.
function normKey(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
}
function codeFromDepartment(dept: string | null | undefined): string | undefined {
  if (!dept) return undefined
  const key = normKey(dept)
  if (!key) return undefined
  for (const c of getAgencyContacts()) {
    if (normKey(c.code) === key || normKey(c.site) === key) return c.code
  }
  return undefined
}

function signatureForUser(row: typeof migrations.$inferSelect, codeMap: Map<string, string>, base: string): { sendAs: string; html: string } {
  const agencyCode = codeMap.get(row.onelaUpn.toLowerCase())
    ?? codeMap.get(row.onelaEmail.toLowerCase())
    ?? codeFromDepartment(row.onelaDepartment)
  const contact = agencyCode ? agencyContactByCode().get(agencyCode.toUpperCase()) : undefined
  const loc = contact ?? SIG_HQ
  const sendAs = newFormatEmail(row.gohUpn!, row.onelaUpn)
  const html = buildSignatureHtml({
    name: row.onelaDisplayName,
    poste: row.onelaJobTitle ?? '',
    tel: loc.tel ?? '',
    adresse: 'adresse' in loc ? loc.adresse : '',
    cpVille: 'cpVille' in loc ? loc.cpVille : '',
    email: sendAs,
    base,
  })
  return { sendAs, html }
}

migrationRouter.post('/:id/apply-signature', requirePermission('migration:write'), async (c) => {
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

migrationRouter.post('/apply-signature-bulk', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const body = await c.req.json<{ agencyGroupId?: string; region?: string; force?: boolean }>().catch(() => ({} as { agencyGroupId?: string; region?: string; force?: boolean }))

  const targetUpns = new Set<string>()
  try {
    if (body.agencyGroupId) {
      for (const m of await getOnelaGroupMembers(body.agencyGroupId)) targetUpns.add(m.upn)
    } else if (body.region) {
      if (!membershipCache || Date.now() - membershipCache.at > MEMBERSHIP_TTL) {
        const built = await buildAgencyMembership()
        membershipCache = { at: Date.now(), ...built }
      }
      for (const a of membershipCache.agencies) if (a.regionLabel === body.region) for (const u of a.upns) targetUpns.add(u)
    } else {
      return c.json({ error: 'agencyGroupId ou region requis' }, 400)
    }
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

// Définit (ou efface) le total de sièges achetés pour une licence.
migrationRouter.put('/license-quotas', requirePermission('migration:write'), async (c) => {
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
migrationRouter.post('/:id/assign-license', requirePermission('migration:write'), async (c) => {
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

// ── Lancer migration calendrier ──────────────────────────────────────────────
migrationRouter.post('/:id/migrate-calendar', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration de compte non réussie' }, 400)
  }
  if (row.stepCalendarMigration === 'running' || row.stepCalendarMigration === 'pending') {
    return c.json({ error: 'Migration calendrier déjà en cours' }, 409)
  }
  await enqueueCalendarMigration(id)
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated), 202)
})

// ── Lancer migration contacts ────────────────────────────────────────────────
migrationRouter.post('/:id/migrate-contacts', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration de compte non réussie' }, 400)
  }
  if (row.stepContactsMigration === 'running' || row.stepContactsMigration === 'pending') {
    return c.json({ error: 'Migration contacts déjà en cours' }, 409)
  }
  await enqueueContactsMigration(id)
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated), 202)
})

// ── Vérifier si le compte Google existe (SCIM provisionné) ──────────────────
migrationRouter.get('/:id/check-google', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ exists: false, email: null })
  const exists = await googleUserExists(row.gohUpn)
  return c.json({ exists, email: row.gohUpn })
})

// ── Archiver / désarchiver une migration ─────────────────────────────────────
migrationRouter.post('/:id/archive', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.update(migrations).set({ archived: 1, archivedAt: new Date() }).where(eq(migrations.id, id))
  // Passer la cible de migration en "done"
  await db.update(migrationTargets).set({ status: 'done' }).where(eq(migrationTargets.migrationId, id))
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

migrationRouter.post('/:id/unarchive', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.update(migrations).set({ archived: 0, archivedAt: null }).where(eq(migrations.id, id))
  // Remettre la cible en "in_progress"
  await db.update(migrationTargets).set({ status: 'in_progress' }).where(eq(migrationTargets.migrationId, id))
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Supprimer une migration (cascade : messages/events/contacts trackés) ────
migrationRouter.delete('/:id', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.delete(migratedMessages).where(eq(migratedMessages.migrationId, id))
  await db.delete(migratedEvents).where(eq(migratedEvents.migrationId, id))
  await db.delete(migratedContacts).where(eq(migratedContacts.migrationId, id))
  await db.delete(migrations).where(eq(migrations.id, id))
  return c.json({ deleted: id })
})

// ── Re-labelliser les messages déjà migrés (corrige les labels sans re-migrer) ──
migrationRouter.post('/:id/relabel-mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)

  // Mettre un statut temporaire pour indiquer que c'est en cours
  await db.update(migrations).set({ mailError: 'Re-labellisation en cours…' }).where(eq(migrations.id, id))

  // Lancer en background (ne bloque pas la réponse HTTP)
  relabelMail(id)
    .then(async (result) => {
      let msg: string
      if (result.errors > 0) {
        const samples = result.errorSamples.length > 0
          ? ` — Ex: ${result.errorSamples[0]?.slice(0, 100)}`
          : ''
        msg = `Re-labellisation : ${result.relabeled} corrigés, ${result.skipped} ignorés, ${result.errors} erreurs${samples}`
      } else {
        msg = `Re-labellisation terminée : ${result.relabeled} corrigés, ${result.skipped} ignorés`
      }
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })
    .catch(async (err) => {
      const msg = `Re-labellisation échouée : ${err instanceof Error ? err.message : String(err)}`
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })

  return c.json({ message: 'Re-labellisation lancée en background' }, 202)
})

// ── Déduplication Gmail : nettoie les doublons par Message-ID ───────────────
// Scanne toute la mailbox, groupe par Message-ID RFC822 et envoie les doublons
// à la Corbeille (purge auto 30j, donc réversible si erreur).
migrationRouter.post('/:id/dedupe-mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)

  await db.update(migrations).set({ mailError: 'Déduplication Gmail en cours…' }).where(eq(migrations.id, id))

  gmailDedupeMailbox(row.gohUpn, async (scanned, removed) => {
    const msg = `Déduplication : ${scanned} scannés, ${removed} doublons supprimés…`
    await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
  })
    .then(async (result) => {
      const msg = `Déduplication terminée : ${result.duplicatesRemoved} doublons supprimés sur ${result.scanned} messages scannés${result.errors > 0 ? ` (${result.errors} erreurs)` : ''}`
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })
    .catch(async (err) => {
      const msg = `Déduplication échouée : ${err instanceof Error ? err.message : String(err)}`
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })

  return c.json({ message: 'Déduplication lancée en background' }, 202)
})

// ── Réessayer uniquement les messages mail en erreur ────────────────────────
// Fast lane : on force labelIds=['INBOX'] pour éviter la résolution de labels
// custom qui causait justement les erreurs "Invalid label: Label_XX". Les
// messages atterrissent dans la boîte de réception Gmail, l'utilisateur peut
// ensuite cliquer "Re-labelliser" pour leur remettre la hiérarchie propre.
migrationRouter.post('/:id/retry-errors/mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)
  const gohUpn = row.gohUpn
  const onelaUserId = row.onelaUserId

  // Lister les messages en erreur (sans rien charger d'autre)
  const errors = await db
    .select({
      id: migratedMessages.id,
      graphMessageId: migratedMessages.graphMessageId,
      internetMessageId: migratedMessages.internetMessageId,
      subject: migratedMessages.subject,
      receivedAt: migratedMessages.receivedAt,
    })
    .from(migratedMessages)
    .where(and(eq(migratedMessages.migrationId, id), eq(migratedMessages.status, 'error')))

  if (errors.length === 0) {
    return c.json({ message: 'Aucune erreur à réessayer', count: 0 }, 200)
  }

  await db.update(migrations).set({ mailError: `Reprise des erreurs : 0/${errors.length}…` }).where(eq(migrations.id, id))

  // Background — pas de blocage HTTP
  ;(async () => {
    let recovered = 0
    let stillFailed = 0
    const total = errors.length
    const startedAt = Date.now()
    console.log(`[retry-errors] ${id}: démarrage sur ${total} messages → INBOX`)

    for (let i = 0; i < errors.length; i++) {
      const msg = errors[i]!
      try {
        const rawMime = await fetchOnelaMessageMime(onelaUserId, msg.graphMessageId)
        // Fast lane : INBOX direct, pas de label custom — atterrit en boîte
        // de réception même si la hiérarchie a changé. "Re-labelliser" peut
        // ensuite remettre les labels propres sans re-télécharger les MIME.
        const result = await gmailImportMime({
          userEmail: gohUpn,
          rawMime,
          labelIds: ['INBOX'],
        })
        await db.update(migratedMessages)
          .set({ status: 'success', gmailMessageId: result.id, errorDetails: null })
          .where(eq(migratedMessages.id, msg.id))
        recovered++
        // Recompter migrated/failed depuis la DB en live (cohérent)
        await db.update(migrations).set({
          mailMigrated: row.mailMigrated + recovered,
          mailFailed: Math.max(0, row.mailFailed - recovered),
          mailError: `Reprise des erreurs : ${recovered + stillFailed}/${total} (${recovered} OK, ${stillFailed} échec)…`,
        }).where(eq(migrations.id, id))
      } catch (err) {
        stillFailed++
        const errorDetails = err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000)
        await db.update(migratedMessages)
          .set({ errorDetails })
          .where(eq(migratedMessages.id, msg.id))
        console.warn(`[retry-errors] ${msg.graphMessageId} fail: ${errorDetails.slice(0, 200)}`)
      }
      // Log de progression toutes les 20 messages pour le suivi en stdout
      if ((i + 1) % 20 === 0) {
        const pct = Math.round(((i + 1) / total) * 100)
        console.log(`[retry-errors] ${id}: ${i + 1}/${total} (${pct}%) — ${recovered} OK, ${stillFailed} échec`)
      }
      // Tempo léger entre messages pour ne pas saturer
      if (i + 1 < errors.length) await new Promise((r) => setTimeout(r, 300))
    }

    const durationS = Math.round((Date.now() - startedAt) / 1000)
    const allRecovered = stillFailed === 0
    const finalMsg = allRecovered
      ? `Reprise terminée en ${durationS}s : ${recovered}/${total} récupérés`
      : `Reprise terminée en ${durationS}s : ${recovered} OK, ${stillFailed} encore en erreur (sur ${total})`
    // Si plus aucune erreur restante, la phase mail n'est plus "en erreur" :
    // on repasse le step en success (badge vert) et on met mailFailed à jour.
    // Sinon on laisse le step en error avec le nombre d'échecs restants.
    await db.update(migrations).set({
      mailError: finalMsg,
      mailFailed: stillFailed,
      ...(allRecovered ? { stepMailMigration: 'success' as const, mailFinishedAt: new Date() } : {}),
    }).where(eq(migrations.id, id))
    console.log(`[retry-errors] ${id}: ${finalMsg}`)
  })().catch(async (err) => {
    const msg = `Reprise des erreurs échouée : ${err instanceof Error ? err.message : String(err)}`
    await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
  })

  return c.json({ message: `Reprise lancée en background sur ${errors.length} messages`, count: errors.length }, 202)
})

// ── Débloquer une phase coincée en 'running' sans worker actif (worker mort/hangé) ──
// Utilisé quand le bouton Pause ne répond plus (worker hung sur un appel Graph
// qui n'a jamais réveillé) ou après un crash silencieux du process Node.
// Force la phase en 'error' sans toucher au tracking → la reprise via "Reprendre"
// fonctionnera et le skipSet reprendra exactement au point d'arrêt.
migrationRouter.post('/:id/unstick/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  const stamp = new Date()
  if (phase === 'mail') {
    await db.update(migrations).set({
      stepMailMigration: 'error',
      mailError: `Déblocage manuel à ${row.mailMigrated}/${row.mailTotal} mails — clique "Reprendre" pour continuer`,
      mailFinishedAt: stamp,
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar') {
    await db.update(migrations).set({
      stepCalendarMigration: 'error',
      calError: `Déblocage manuel à ${row.calMigrated}/${row.calTotal} événements — clique "Reprendre" pour continuer`,
      calFinishedAt: stamp,
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts') {
    await db.update(migrations).set({
      stepContactsMigration: 'error',
      contactsError: `Déblocage manuel à ${row.contactsMigrated}/${row.contactsTotal} contacts — clique "Reprendre" pour continuer`,
      contactsFinishedAt: stamp,
    }).where(eq(migrations.id, id))
  } else {
    return c.json({ error: 'Phase invalide (mail, calendar, contacts)' }, 400)
  }

  // Best-effort : signaler le stop au cas où le worker reprend conscience
  signalStop(id, phase as 'mail' | 'calendar' | 'contacts')

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Forcer l'arrêt d'une phase (running → error) ────────────────────────────
migrationRouter.post('/:id/stop/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  if (phase === 'mail' && (row.stepMailMigration === 'running' || row.stepMailMigration === 'pending')) {
    // Signaler au worker de s'arrêter au prochain batch
    signalStop(id, 'mail')
    // Marquer immédiatement en DB pour le frontend
    await db.update(migrations).set({
      mailError: 'Arrêt en cours…',
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar' && (row.stepCalendarMigration === 'running' || row.stepCalendarMigration === 'pending')) {
    signalStop(id, 'calendar')
    await db.update(migrations).set({
      calError: 'Arrêt en cours…',
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts' && (row.stepContactsMigration === 'running' || row.stepContactsMigration === 'pending')) {
    signalStop(id, 'contacts')
    await db.update(migrations).set({
      contactsError: 'Arrêt en cours…',
    }).where(eq(migrations.id, id))
  } else {
    return c.json({ error: 'Phase non en cours' }, 400)
  }

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Réinitialiser une phase (pour re-migrer depuis 0 après suppression Google) ──
migrationRouter.post('/:id/reset/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  if (phase === 'mail') {
    await db.delete(migratedMessages).where(eq(migratedMessages.migrationId, id))
    await db.update(migrations).set({
      stepMailMigration: 'pending',
      mailTotal: 0, mailMigrated: 0, mailFailed: 0,
      mailError: null, mailLastSyncAt: null, mailStartedAt: null, mailFinishedAt: null,
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar') {
    await db.delete(migratedEvents).where(eq(migratedEvents.migrationId, id))
    await db.update(migrations).set({
      stepCalendarMigration: 'pending',
      calTotal: 0, calMigrated: 0, calFailed: 0,
      calError: null, calLastSyncAt: null, calStartedAt: null, calFinishedAt: null,
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts') {
    await db.delete(migratedContacts).where(eq(migratedContacts.migrationId, id))
    await db.update(migrations).set({
      stepContactsMigration: 'pending',
      contactsTotal: 0, contactsMigrated: 0, contactsFailed: 0,
      contactsError: null, contactsLastSyncAt: null, contactsStartedAt: null, contactsFinishedAt: null,
    }).where(eq(migrations.id, id))
  } else {
    return c.json({ error: 'Phase invalide' }, 400)
  }

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Reprise COMPLÈTE de la migration mail (efface lastSyncAt, garde le tracking) ──
// Utilisé pour réparer une migration marquée "terminée" à tort (ex: bug signet de
// reprise sur Esther) : on remet mailLastSyncAt à null → la relance fait un re-parcours
// COMPLET (et non un delta) qui skippe les déjà-migrés (skipSet) et complète le reste.
// Ne supprime PAS migrated_messages → les milliers déjà faits ne sont pas refaits.
migrationRouter.post('/:id/resume-full', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)

  await db.update(migrations).set({
    mailLastSyncAt: null,           // force un re-parcours complet (pas un delta)
    stepMailMigration: 'pending',   // le worker le récupère
    mailError: null, mailFinishedAt: null,
  }).where(eq(migrations.id, id))

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Erreurs détaillées par phase ─────────────────────────────────────────────
migrationRouter.get('/:id/errors/:phase', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')

  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)

  if (phase === 'mail') {
    const rows = await db.select({
      id: migratedMessages.id,
      graphId: migratedMessages.graphMessageId,
      internetMessageId: migratedMessages.internetMessageId,
      errorDetails: migratedMessages.errorDetails,
      createdAt: migratedMessages.createdAt,
    })
      .from(migratedMessages)
      .where(and(eq(migratedMessages.migrationId, id), eq(migratedMessages.status, 'error')))
      .orderBy(desc(migratedMessages.createdAt))
      .limit(limit)
    return c.json({ phase, errors: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) })
  }

  if (phase === 'calendar') {
    const rows = await db.select({
      id: migratedEvents.id,
      graphId: migratedEvents.graphEventId,
      iCalUid: migratedEvents.iCalUid,
      errorDetails: migratedEvents.errorDetails,
      createdAt: migratedEvents.createdAt,
    })
      .from(migratedEvents)
      .where(and(eq(migratedEvents.migrationId, id), eq(migratedEvents.status, 'error')))
      .orderBy(desc(migratedEvents.createdAt))
      .limit(limit)
    return c.json({ phase, errors: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) })
  }

  if (phase === 'contacts') {
    const rows = await db.select({
      id: migratedContacts.id,
      graphId: migratedContacts.graphContactId,
      errorDetails: migratedContacts.errorDetails,
      createdAt: migratedContacts.createdAt,
    })
      .from(migratedContacts)
      .where(and(eq(migratedContacts.migrationId, id), eq(migratedContacts.status, 'error')))
      .orderBy(desc(migratedContacts.createdAt))
      .limit(limit)
    return c.json({ phase, errors: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) })
  }

  return c.json({ error: 'Phase invalide (mail, calendar, contacts)' }, 400)
})

// ── Télécharger les erreurs en CSV ───────────────────────────────────────────
migrationRouter.get('/:id/errors/:phase/download', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')

  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  let rows: Array<{ graphId: string; refId: string | null; subject: string | null; receivedAt: Date | null; errorDetails: string | null; createdAt: Date }> = []

  if (phase === 'mail') {
    const data = await db.select({
      graphId: migratedMessages.graphMessageId,
      refId: migratedMessages.internetMessageId,
      subject: migratedMessages.subject,
      receivedAt: migratedMessages.receivedAt,
      errorDetails: migratedMessages.errorDetails,
      createdAt: migratedMessages.createdAt,
    }).from(migratedMessages)
      .where(and(eq(migratedMessages.migrationId, id), eq(migratedMessages.status, 'error')))
      .orderBy(desc(migratedMessages.createdAt))
    rows = data
  } else if (phase === 'calendar') {
    const data = await db.select({
      graphId: migratedEvents.graphEventId,
      refId: migratedEvents.iCalUid,
      errorDetails: migratedEvents.errorDetails,
      createdAt: migratedEvents.createdAt,
    }).from(migratedEvents)
      .where(and(eq(migratedEvents.migrationId, id), eq(migratedEvents.status, 'error')))
      .orderBy(desc(migratedEvents.createdAt))
    rows = data.map((r) => ({ ...r, subject: null, receivedAt: null }))
  } else if (phase === 'contacts') {
    const data = await db.select({
      graphId: migratedContacts.graphContactId,
      refId: migratedContacts.googleResourceName,
      errorDetails: migratedContacts.errorDetails,
      createdAt: migratedContacts.createdAt,
    }).from(migratedContacts)
      .where(and(eq(migratedContacts.migrationId, id), eq(migratedContacts.status, 'error')))
      .orderBy(desc(migratedContacts.createdAt))
    rows = data.map((r) => ({ ...r, subject: null, receivedAt: null }))
  } else {
    return c.json({ error: 'Phase invalide' }, 400)
  }

  // Construire le CSV
  const csvEscape = (s: string | null) => {
    if (!s) return ''
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const csvLines = ['subject,receivedAt,graphId,referenceId,errorDetails,createdAt']
  for (const r of rows) {
    csvLines.push([
      csvEscape(r.subject),
      r.receivedAt ? r.receivedAt.toISOString() : '',
      csvEscape(r.graphId),
      csvEscape(r.refId),
      csvEscape(r.errorDetails),
      r.createdAt.toISOString(),
    ].join(','))
  }

  const filename = `errors-${phase}-${row.onelaUpn.replace('@', '_')}-${new Date().toISOString().slice(0, 10)}.csv`
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  return c.body(csvLines.join('\n'))
})

// ── Forwarding Exchange ONELA → mig.onela.com ──────────────────────────────
migrationRouter.post('/:id/forwarding', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte GOH' }, 400)

  try {
    await setOnelaMailForwarding(row.onelaUpn, row.gohUpn)
    return c.json({ success: true, forwardTo: row.gohUpn })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[forwarding] set error for ${row.onelaUpn}:`, msg)
    return c.json({ error: 'Forwarding error', message: msg }, 502)
  }
})

migrationRouter.delete('/:id/forwarding', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  try {
    await removeOnelaMailForwarding(row.onelaUpn)
    return c.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'Forwarding error', message: msg }, 502)
  }
})

migrationRouter.get('/:id/forwarding', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  try {
    const status = await checkOnelaMailForwarding(row.onelaUpn)
    return c.json(status)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'Check forwarding error', message: msg }, 502)
  }
})

// ── Détail d'une migration ────────────────────────────────────────────────────
migrationRouter.get('/:id', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const [row] = await db.select().from(migrations).where(eq(migrations.id, c.req.param('id')))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(row))
})

function serializeMigration(m: typeof migrations.$inferSelect) {
  return {
    ...m,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    tempPassword: m.tempPassword ?? null,
    mailStartedAt: m.mailStartedAt ? m.mailStartedAt.toISOString() : null,
    mailFinishedAt: m.mailFinishedAt ? m.mailFinishedAt.toISOString() : null,
    mailLastSyncAt: m.mailLastSyncAt ? m.mailLastSyncAt.toISOString() : null,
    calStartedAt: m.calStartedAt ? m.calStartedAt.toISOString() : null,
    calFinishedAt: m.calFinishedAt ? m.calFinishedAt.toISOString() : null,
    calLastSyncAt: m.calLastSyncAt ? m.calLastSyncAt.toISOString() : null,
    contactsStartedAt: m.contactsStartedAt ? m.contactsStartedAt.toISOString() : null,
    contactsFinishedAt: m.contactsFinishedAt ? m.contactsFinishedAt.toISOString() : null,
    contactsLastSyncAt: m.contactsLastSyncAt ? m.contactsLastSyncAt.toISOString() : null,
    archived: m.archived === 1,
    archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null,
    credentialsSentAt: m.credentialsSentAt ? m.credentialsSentAt.toISOString() : null,
    signatureAppliedAt: m.signatureAppliedAt ? m.signatureAppliedAt.toISOString() : null,
  }
}

// Variante pour les listes : `exchangePsScript` est une colonne TEXT que le front
// ne lit jamais. La garder dans /history alourdissait chaque poll (toutes les 5 s
// pendant une migration) sans rien afficher. Elle reste servie par /migration/:id.
function serializeMigrationLight(m: typeof migrations.$inferSelect) {
  const { exchangePsScript: _omit, ...rest } = serializeMigration(m)
  return rest
}
