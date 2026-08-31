// Résolution « personne du service » → compte Google délégable.
//
// PIÈGE CENTRAL : côté Exchange une personne est `pnom@onela.com`, côté Google
// c'est `prenom.nom@mig.onela.com` (adresse primaire) avec l'alias définitif
// `prenom.nom@onela.com`. Les deux adresses n'ont donc RIEN en commun, et
// l'API de délégation Gmail exige l'adresse PRIMAIRE Google.
//
// Ordre de résolution :
//   1. table `migrations`        → mapping onelaUpn → gohUpn établi à la migration
//   2. table `account_creations` → idem pour les arrivées post-migration
//   3. annuaire Google           → si l'adresse ONELA existe comme alias du compte
// Sinon on rend le candidat non résolu : l'UI demande de le choisir à la main.

import { inArray, or, sql } from 'drizzle-orm'
import { db } from '../../db/index'
import { migrations } from '../migration/schema'
import { accountCreations } from '../accounts/schema'
import { getGoogleUser } from './googleUserService'

export interface ResolvedDelegate {
  sourceUpn: string
  googleEmail: string | null
  displayName: string | null
  resolvedVia: 'migration' | 'directory' | null
}

/** Résout en lot des UPN ONELA vers leurs comptes Google primaires. */
export async function resolveOnelaUpnsToGoogle(upns: string[]): Promise<ResolvedDelegate[]> {
  if (upns.length === 0) return []
  const wanted = upns.map((u) => u.toLowerCase())

  // 1+2. Mapping déjà connu en base (migrations utilisateurs / onboardings)
  const byUpn = new Map<string, { googleEmail: string; displayName: string | null }>()

  const migRows = await db
    .select({
      onelaUpn: migrations.onelaUpn,
      onelaEmail: migrations.onelaEmail,
      gohUpn: migrations.gohUpn,
      displayName: migrations.onelaDisplayName,
    })
    .from(migrations)
    .where(
      or(
        inArray(sql`LOWER(${migrations.onelaUpn})`, wanted),
        inArray(sql`LOWER(${migrations.onelaEmail})`, wanted),
      ),
    )
  for (const r of migRows) {
    if (!r.gohUpn) continue
    for (const key of [r.onelaUpn, r.onelaEmail]) {
      if (key && wanted.includes(key.toLowerCase())) {
        byUpn.set(key.toLowerCase(), { googleEmail: r.gohUpn, displayName: r.displayName })
      }
    }
  }

  const acctRows = await db
    .select({
      onelaUpn: accountCreations.onelaUpn,
      gohUpn: accountCreations.gohUpn,
      displayName: accountCreations.displayName,
    })
    .from(accountCreations)
    .where(inArray(sql`LOWER(${accountCreations.onelaUpn})`, wanted))
  for (const r of acctRows) {
    const key = r.onelaUpn.toLowerCase()
    if (!byUpn.has(key)) byUpn.set(key, { googleEmail: r.gohUpn, displayName: r.displayName })
  }

  // 3. Repli annuaire Google : l'adresse ONELA peut exister comme alias
  const out: ResolvedDelegate[] = []
  for (const upn of upns) {
    const hit = byUpn.get(upn.toLowerCase())
    if (hit) {
      out.push({
        sourceUpn: upn,
        googleEmail: hit.googleEmail,
        displayName: hit.displayName,
        resolvedVia: 'migration',
      })
      continue
    }
    try {
      const user = await getGoogleUser(upn)
      out.push({
        sourceUpn: upn,
        googleEmail: user?.primaryEmail ?? null,
        displayName: user?.displayName ?? null,
        resolvedVia: user ? 'directory' : null,
      })
    } catch (err) {
      console.warn(
        `[shared-delegates] résolution annuaire échouée pour ${upn}:`,
        err instanceof Error ? err.message : err,
      )
      out.push({ sourceUpn: upn, googleEmail: null, displayName: null, resolvedVia: null })
    }
  }
  return out
}

/** Vérifie qu'une adresse est bien un compte Google et renvoie son adresse primaire. */
export async function normalizeDelegateEmail(
  email: string,
): Promise<{ primaryEmail: string; displayName: string }> {
  const user = await getGoogleUser(email)
  if (!user) throw new Error(`Aucun compte Google trouvé pour ${email}`)
  if (user.suspended) throw new Error(`Le compte ${user.primaryEmail} est suspendu`)
  return { primaryEmail: user.primaryEmail, displayName: user.displayName }
}
