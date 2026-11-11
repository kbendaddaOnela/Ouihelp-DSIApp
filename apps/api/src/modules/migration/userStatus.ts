import type { getDb } from '../../db/index'
import { migrations } from './schema'

// ── Statut de migration par utilisateur (source autoritaire : table `migrations`) ─
// Dérivé des mêmes champs que les cartes, pour que compteurs (arbre agences,
// effectifs services) et sélecteur de membres soient toujours cohérents entre eux.
// Indexé en CASSE INSENSIBLE par UPN ET e-mail (les UPN/mails ONELA ont parfois des
// majuscules, ex. EALMEIDADESOUSA@onela.com) + par identifiant Graph (le plus fiable).
//  • 'done'        = migration archivée OU les 3 phases data réussies.
//  • 'in_progress' = migration lancée mais pas encore terminée (compte provisionné,
//                    mail en cours / en pause, etc.).
export type UserMigStatus = 'done' | 'in_progress'
function deriveMigStatus(r: { archived: number; mail: string; cal: string; con: string }): UserMigStatus {
  const dataDone = r.mail === 'success' && r.cal === 'success' && r.con === 'success'
  return r.archived === 1 || dataDone ? 'done' : 'in_progress'
}
export async function loadUserStatus(db: ReturnType<typeof getDb>): Promise<{
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
