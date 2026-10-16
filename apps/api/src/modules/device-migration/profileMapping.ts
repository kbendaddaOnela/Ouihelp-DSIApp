import { eq, or } from 'drizzle-orm'
import type { DeviceAgentProfile, MigrationProfileMapping } from '@dsi-app/shared'
import { db } from '../../db/index'
import { getMsToken, ouihelpCreds } from '../inventory/syncService'
import { migrations } from '../migration/schema'

/**
 * Bascule en place : quel profil Windows est conservé, et quel compte Ouihelp en hérite.
 *
 * Décision DSI (16/10/2026) : **un seul profil est transféré, celui du dernier utilisateur
 * connecté** ; tous les autres profils ONELA du poste sont supprimés par l'agent (clé
 * ProfileList et dossier de C:\Users). Un poste d'agence accumule des profils d'anciens
 * salariés et d'intervenants, dont les comptes ONELA disparaissent de toute façon le 31/12.
 *
 * Le transfert (Win32_UserProfile.ChangeOwner, côté agent) demande le SID du compte Ouihelp.
 * Pour un compte Entra, c'est l'attribut `securityIdentifier` (S-1-12-1-…), lisible par Graph
 * avec les droits applicatifs : contrairement au script d'origine, l'utilisateur n'a pas à se
 * connecter à Ouihelp pendant la bascule.
 *
 * Correspondance ONELA → Ouihelp du profil conservé, dans l'ordre :
 *  1. table `migrations` (création des comptes Ouihelp) : onela_upn / onela_email → goh_upn ;
 *  2. compte Ouihelp dont une adresse (mail ou proxyAddresses) est l'UPN ONELA ;
 *  3. saisie de la DSI à la programmation (prioritaire si fournie).
 */

const GRAPH = 'https://graph.microsoft.com/v1.0'
// Comptes techniques (support, admin, comptes de service) : ils se connectent pour dépanner ou
// faire tourner un outil, leur profil n'est pas celui d'un utilisateur du poste. Ils ne sont donc
// jamais retenus comme profil conservé — mais la DSI peut toujours en désigner un à la main.
const TECHNICAL_ACCOUNT = /^(admin|adm[._-]|administrat|support|svc[._-]?)/i

interface OuihelpUser {
  id: string
  userPrincipalName: string
  securityIdentifier: string | null
  accountEnabled: boolean
  userType: string | null
}

const SELECT = '$select=id,userPrincipalName,securityIdentifier,accountEnabled,userType'

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

/**
 * Profils ONELA du poste : comptes AD / Entra. Les profils de comptes LOCAUX (compte de secours,
 * administrateur local, comptes de service installés sur le poste) ne sont jamais touchés : ils
 * continuent de fonctionner après la bascule.
 */
export function onelaProfiles(profiles: DeviceAgentProfile[]): DeviceAgentProfile[] {
  return profiles.filter((p) => p.kind === 'ad' || p.kind === 'entra')
}

/** Profils qui peuvent être LE profil conservé : ceux d'un utilisateur, pas d'un compte technique. */
export function candidateProfiles(profiles: DeviceAgentProfile[]): DeviceAgentProfile[] {
  return onelaProfiles(profiles).filter((p) => {
    const account = p.upn ?? p.account ?? ''
    const local = account.split('\\').pop()!.split('@')[0]!
    return !!account && !TECHNICAL_ACCOUNT.test(local)
  })
}

function logonTime(p: DeviceAgentProfile): number {
  const at = p.lastLogonTime ?? p.lastUseTime
  const t = at ? new Date(at).getTime() : NaN
  return Number.isNaN(t) ? 0 : t
}

/**
 * Profil conservé : celui choisi par la DSI s'il est encore là, sinon le dernier connecté
 * (chargement du profil Windows, à défaut `LastUseTime`). Les comptes techniques (support,
 * admin) ne sont jamais retenus automatiquement : ils se connectent pour dépanner.
 */
export function pickMainProfile(
  profiles: DeviceAgentProfile[],
  wantedSid?: string | null
): DeviceAgentProfile | null {
  const candidates = candidateProfiles(profiles)
  if (wantedSid) {
    const wanted = onelaProfiles(profiles).find((p) => p.sid === wantedSid)
    if (wanted) return wanted
  }
  return [...candidates].sort((a, b) => logonTime(b) - logonTime(a))[0] ?? null
}

/**
 * Devenir de chaque profil ONELA du poste : un seul est conservé et transféré (le dernier
 * connecté, ou celui imposé par `mainSid`), les autres sont supprimés. `targets` (saisie DSI) :
 * SID → compte Ouihelp du profil conservé.
 */
export async function resolveProfileMap(
  profiles: DeviceAgentProfile[],
  targets: Record<string, string | null> = {},
  mainSid?: string | null
): Promise<MigrationProfileMapping[]> {
  const main = pickMainProfile(profiles, mainSid)
  const c = ouihelpCreds()
  const token = await getMsToken(c.tid, c.cid, c.sec)
  const out: MigrationProfileMapping[] = []
  for (const p of onelaProfiles(profiles)) {
    const base: MigrationProfileMapping = {
      oldSid: p.sid,
      oldAccount: p.account,
      oldUpn: p.upn ?? null,
      localDataMb: p.localDataMb,
      lastLogonAt: p.lastLogonTime ?? p.lastUseTime,
      action: p.sid === main?.sid ? 'migrate' : 'delete',
      newUpn: null,
      newSid: null,
      newSam: null,
      source: null,
      error: null,
    }
    // Profil supprimé : aucun compte Ouihelp à chercher
    if (base.action === 'delete') {
      out.push(base)
      continue
    }
    try {
      let user: OuihelpUser | null = null
      let source: MigrationProfileMapping['source'] = null
      const wantedTarget = targets[p.sid]
      if (wantedTarget) {
        const wanted = wantedTarget.trim().toLowerCase()
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
      // Un invité (#EXT#) porte souvent la même adresse que le compte ONELA : c'est l'ONELA
      // invité chez Ouihelp, pas le compte de la personne. Transférer le profil vers son SID
      // donnerait un profil que le compte Ouihelp réel n'ouvrirait jamais.
      if (user.userType === 'Guest' || /#EXT#/i.test(user.userPrincipalName))
        throw new Error(
          `${user.userPrincipalName} est un compte invité : saisir le compte Ouihelp de la personne`
        )
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
  // Le profil conservé en premier, les profils supprimés ensuite, du plus récent au plus ancien
  return out.sort(
    (a, b) =>
      (a.action === 'migrate' ? 0 : 1) - (b.action === 'migrate' ? 0 : 1) ||
      new Date(b.lastLogonAt ?? 0).getTime() - new Date(a.lastLogonAt ?? 0).getTime()
  )
}

export function parseProfileMap(raw: string | null): MigrationProfileMapping[] {
  if (!raw) return []
  try {
    return JSON.parse(raw) as MigrationProfileMapping[]
  } catch {
    return []
  }
}
