import { getOnelaGroupMembers } from '../../integrations/microsoft/tenantDirectory'
import { getAgencyGroups } from './onelaAgencyGroups'
import { mapLimit } from '../../lib/mapLimit'

// Cache mémoire de l'appartenance agence → région (calculée en direct via Graph :
// les membres d'une agence appartiennent tous à une seule Direction Régionale).
// Coûteux (≈70 appels) → mis en cache ; les compteurs de statut sont recalculés
// à chaque requête depuis la BDD (donc toujours frais).
interface AgencyMembership { code: string; name: string; groupId: string; regionLabel: string; upns: string[]; mails: string[] }
export type MembershipSnapshot = { at: number; agencies: AgencyMembership[]; errors: string[] }
let membershipCache: MembershipSnapshot | null = null
let membershipInFlight: Promise<MembershipSnapshot> | null = null
const MEMBERSHIP_TTL = 5 * 60_000
export const NO_REGION = 'Sans région'

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

/**
 * Appartenance agences → régions, depuis le cache si frais. Point d'entrée unique
 * (arbre agences, envois groupés, signatures) : une reconstruction déjà en cours
 * est partagée, au lieu que deux requêtes simultanées lancent chacune ~70 appels
 * Graph. `fresh` force le recalcul (bouton « Rafraîchir » de l'arbre).
 */
export async function getAgencyMembership(fresh = false): Promise<MembershipSnapshot> {
  if (!fresh && membershipCache && Date.now() - membershipCache.at <= MEMBERSHIP_TTL) return membershipCache
  if (membershipInFlight) return membershipInFlight
  const pending: Promise<MembershipSnapshot> = buildAgencyMembership()
    .then((built) => (membershipCache = { at: Date.now(), ...built }))
    .finally(() => {
      if (membershipInFlight === pending) membershipInFlight = null
    })
  membershipInFlight = pending
  return pending
}

/**
 * UPN (minuscules) ciblés par un envoi groupé : membres d'une agence ou de toutes
 * les agences d'une région. Renvoie null si aucune cible n'est précisée.
 */
export async function resolveBulkTargetUpns(body: { agencyGroupId?: string; region?: string }): Promise<Set<string> | null> {
  const targetUpns = new Set<string>()
  if (body.agencyGroupId) {
    for (const m of await getOnelaGroupMembers(body.agencyGroupId)) targetUpns.add(m.upn)
  } else if (body.region) {
    const { agencies } = await getAgencyMembership()
    for (const a of agencies) if (a.regionLabel === body.region) for (const u of a.upns) targetUpns.add(u)
  } else {
    return null
  }
  return targetUpns
}
