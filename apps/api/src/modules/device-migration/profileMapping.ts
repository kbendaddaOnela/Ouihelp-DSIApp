import { eq, or } from 'drizzle-orm'
import type { DeviceAgentProfile, MigrationProfileMapping } from '@dsi-app/shared'
import { db } from '../../db/index'
import { getMsToken, ouihelpCreds } from '../inventory/syncService'
import { migrations } from '../migration/schema'

/**
 * Bascule en place : quel compte Ouihelp hérite de chaque profil Windows ONELA.
 *
 * Le transfert (Win32_UserProfile.ChangeOwner, côté agent) demande le SID du compte Ouihelp.
 * Pour un compte Entra, c'est l'attribut `securityIdentifier` (S-1-12-1-…), lisible par Graph
 * avec les droits applicatifs : contrairement au script d'origine, l'utilisateur n'a pas à se
 * connecter à Ouihelp pendant la bascule.
 *
 * Correspondance ONELA → Ouihelp, dans l'ordre :
 *  1. table `migrations` (création des comptes Ouihelp) : onela_upn / onela_email → goh_upn ;
 *  2. compte Ouihelp dont une adresse (mail ou proxyAddresses) est l'UPN ONELA ;
 *  3. saisie de la DSI à la programmation (prioritaire si fournie).
 */

const GRAPH = 'https://graph.microsoft.com/v1.0'
// Comptes techniques (support, admin) : ils se connectent pour dépanner, leur profil n'est
// pas celui d'un utilisateur du poste. Même règle que les dernières connexions (routes.ts).
const TECHNICAL_ACCOUNT = /^(admin|adm[._-]|administrat|support)/i

interface OuihelpUser {
  id: string
  userPrincipalName: string
  securityIdentifier: string | null
  accountEnabled: boolean
}

const SELECT = '$select=id,userPrincipalName,securityIdentifier,accountEnabled'

async function graphGet<T>(token: string, url: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${GRAPH}${url}`, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
  })
  if (!res.ok) return { status: res.status, body: null }
  return { status: res.status, body: (await res.json()) as T }
}

async function ouihelpUserByUpn(token: string, upn: string): Promise<OuihelpUser | null> {
  const r = await graphGet<OuihelpUser>(token, `/users/${encodeURIComponent(upn)}?${SELECT}`)
  if (r.status === 404) return null
  if (r.status !== 200) throw new Error(`Lecture du compte Ouihelp ${upn} : HTTP ${r.status}`)
  return r.body
}

async function ouihelpUserByAddress(token: string, address: string): Promise<OuihelpUser | null> {
  const a = address.replace(/'/g, "''")
  const filter = `mail eq '${a}' or proxyAddresses/any(p:p eq 'smtp:${a}')`
  const r = await graphGet<{ value: OuihelpUser[] }>(
    token,
    `/users?$filter=${encodeURIComponent(filter)}&$count=true&${SELECT}`
  )
  if (r.status !== 200) return null
  const hits = r.body?.value ?? []
  return hits.length === 1 ? hits[0]! : null
}

/** UPN Ouihelp connu par la création des comptes (table migrations). */
async function upnFromAccountMigrations(onelaUpn: string): Promise<string | null> {
  const rows = await db
    .select({ gohUpn: migrations.gohUpn })
    .from(migrations)
    .where(or(eq(migrations.onelaUpn, onelaUpn), eq(migrations.onelaEmail, onelaUpn)))
  return rows.find((r) => r.gohUpn)?.gohUpn?.toLowerCase() ?? null
}

/** Profils candidats au transfert : comptes AD / Entra d'utilisateurs (pas locaux, pas techniques). */
export function candidateProfiles(profiles: DeviceAgentProfile[]): DeviceAgentProfile[] {
  return profiles.filter((p) => {
    if (p.kind !== 'ad' && p.kind !== 'entra') return false
    const account = p.upn ?? p.account ?? ''
    const local = account.split('\\').pop()!.split('@')[0]!
    return !!account && !TECHNICAL_ACCOUNT.test(local)
  })
}

/**
 * Calcule la correspondance pour les profils du poste. `targets` (saisie DSI) : SID → UPN
 * Ouihelp, ou null pour ne pas transférer le profil.
 */
export async function resolveProfileMap(
  profiles: DeviceAgentProfile[],
  targets: Record<string, string | null> = {}
): Promise<MigrationProfileMapping[]> {
  const c = ouihelpCreds()
  const token = await getMsToken(c.tid, c.cid, c.sec)
  const out: MigrationProfileMapping[] = []
  for (const p of candidateProfiles(profiles)) {
    const base: MigrationProfileMapping = {
      oldSid: p.sid,
      oldAccount: p.account,
      oldUpn: p.upn ?? null,
      localDataMb: p.localDataMb,
      newUpn: null,
      newSid: null,
      newSam: null,
      source: null,
      error: null,
    }
    try {
      let user: OuihelpUser | null = null
      let source: MigrationProfileMapping['source'] = null
      if (Object.prototype.hasOwnProperty.call(targets, p.sid)) {
        const wanted = targets[p.sid]?.trim().toLowerCase()
        if (!wanted) {
          out.push(base) // la DSI a choisi de ne pas transférer ce profil
          continue
        }
        user = await ouihelpUserByUpn(token, wanted)
        source = 'manual'
        if (!user) throw new Error(`Compte Ouihelp ${wanted} introuvable`)
      } else if (p.upn) {
        const fromMig = await upnFromAccountMigrations(p.upn)
        if (fromMig) {
          user = await ouihelpUserByUpn(token, fromMig)
          source = 'migration'
        }
        if (!user) {
          user = await ouihelpUserByAddress(token, p.upn)
          source = 'mail'
        }
        if (!user) throw new Error('Aucun compte Ouihelp correspondant : saisir le compte')
      } else {
        throw new Error('UPN ONELA inconnu pour ce profil : saisir le compte Ouihelp')
      }
      if (!user.accountEnabled) throw new Error(`Compte Ouihelp ${user.userPrincipalName} désactivé`)
      if (!user.securityIdentifier?.startsWith('S-1-12-1-'))
        throw new Error(`SID du compte Ouihelp ${user.userPrincipalName} illisible`)
      out.push({
        ...base,
        newUpn: user.userPrincipalName.toLowerCase(),
        newSid: user.securityIdentifier,
        newSam: user.userPrincipalName.split('@')[0]!.slice(0, 20),
        source,
      })
    } catch (err) {
      out.push({ ...base, error: err instanceof Error ? err.message : String(err) })
    }
  }
  // Deux profils vers le même compte Ouihelp : ChangeOwner échouerait sur le second
  const seen = new Map<string, string>()
  for (const m of out) {
    if (!m.newSid) continue
    const prev = seen.get(m.newSid)
    if (prev) m.error = `Même compte Ouihelp que le profil ${prev} : n'en transférer qu'un`
    else seen.set(m.newSid, m.oldAccount ?? m.oldSid)
  }
  return out
}

export function parseProfileMap(raw: string | null): MigrationProfileMapping[] {
  if (!raw) return []
  try {
    return JSON.parse(raw) as MigrationProfileMapping[]
  } catch {
    return []
  }
}
