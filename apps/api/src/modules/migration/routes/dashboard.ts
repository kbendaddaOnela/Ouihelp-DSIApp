// Tableau de bord : compteurs en direct depuis les tenants, effectifs par service et par agence.
import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { requirePermission } from '../../../middleware/rbac'
import type { RbacVariables } from '../../../middleware/rbac'
import { getDb } from '../../../db/index'
import { migrations, licenseQuotas } from '../schema'
import { countOnelaUsersByDepartment, getOnelaGroupMembers, getOnelaGroupUsers } from '../../../integrations/microsoft/tenantDirectory'
import { getServiceGroups } from '../onelaServiceGroups'
import { REGION_ORDER } from '../onelaAgencyGroups'
import { countUsersInOu } from '../../../integrations/google/directory'
import { listLicenseSkusWithUsage, skuDisplayName } from '../../../integrations/google/licensing'
import { getAgencyMembership, NO_REGION } from '../agencyMembership'
import type { MembershipSnapshot } from '../agencyMembership'
import { loadUserStatus } from '../userStatus'

export const dashboardRoutes = new Hono<{ Variables: RbacVariables }>()

// ── Stats LIVE (source de vérité : les tenants, pas le CSV importé) ───────────
// - onelaTotal   : population à migrer, comptée en direct dans le tenant ONELA
// - googleMigrated : comptes déjà présents dans l'OU /onela.com côté Ouihelp
// - activeMigrations : migrations réellement actives (table migrations, non archivées)
// - licenses     : total de sièges dispo (somme des « restantes » saisies)
// Chaque source est isolée : si un appel tenant échoue, son champ vaut null et
// le front retombe sur le CSV — rien ne casse.
dashboardRoutes.get('/live-stats', requirePermission('migration:read'), async (c) => {
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
dashboardRoutes.get('/service-group-counts', requirePermission('migration:read'), async (c) => {
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
dashboardRoutes.get('/agencies-tree', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const fresh = ['1', 'true'].includes(c.req.query('fresh') ?? '')
  let cache: MembershipSnapshot
  try {
    cache = await getAgencyMembership(fresh)
  } catch (err) {
    return c.json({ error: 'ONELA groups', message: err instanceof Error ? err.message : String(err) }, 502)
  }

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
dashboardRoutes.get('/group-members/:groupId', requirePermission('migration:read'), async (c) => {
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
