// Application du plan de droits aux dossiers « Clients » et « Intervenants » du
// site cible, et traduction des principaux ONELA vers leurs équivalents Ouihelp.
//
// Ce que ce fichier NE fait pas : lire les ACL du tenant ONELA. Les objectId des
// groupes y sont propres à ce tenant et n'existent pas côté Ouihelp ; une copie
// d'ACL devrait de toute façon re-résoudre chaque principal par son nom. Le plan
// relu par un humain (`ximiPermissionPlan.ts`) joue ce rôle, en plus auditable.

import {
  SOURCE,
  findGroupByExactName,
  findUserByUpn,
  findUsersBySurname,
  getRootItemId,
  getTargetItemServerRelativePath,
  listChildFolders,
  createTargetFolder,
} from './graphService'
import {
  applyFolderAcl,
  securityGroupLoginName,
  userLoginName,
  type FolderAclPrincipal,
} from './sharepointAdminService'
import {
  ONELA_TO_OUIHELP_UPN,
  XIMI_FOLDER_ALIASES,
  XIMI_FOLDER_TYPES,
  folderPlanFor,
  isUserPrincipal,
  targetGroupName,
  targetUserDomain,
  type XimiFolderType,
} from './ximiPermissionPlan'

export interface FolderPermissionReport {
  type: XimiFolderType
  /** Nom réel du dossier, tel qu'il existe sur le site. */
  folderName: string | null
  status: 'success' | 'error' | 'skipped'
  /** Principaux effectivement autorisés, en noms cibles. */
  applied: string[]
  /** Principaux non autorisés, avec la raison. */
  failures: string[]
}

export interface FolderPlanOutcome {
  reports: FolderPermissionReport[]
  status: 'success' | 'error' | 'skipped'
  error: string | null
}

/** Forme normalisée pour rapprocher un nom de dossier d'un type du plan. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Compte Ouihelp correspondant à un compte ONELA.
 *
 * Deux chemins, dans cet ordre :
 *  1. la table de correspondance explicite (`cmarmouze` → `cathy.marmouze`) ;
 *  2. une recherche par NOM DE FAMILLE sur le domaine cible, en ne retenant que
 *     les comptes dont le prénom commence par l'initiale de l'adresse source.
 *
 * Le second chemin n'accepte qu'une correspondance UNIQUE. Deux « C. Renard »
 * sur le tenant, et on échoue en demandant un arbitrage : autoriser le mauvais
 * compte sur un dossier « Intervenants » lui donnerait les attestations de
 * salaire de toute une agence.
 */
export async function resolveTargetUserUpn(onelaUpn: string): Promise<string> {
  const key = onelaUpn.trim().toLowerCase()
  const override = ONELA_TO_OUIHELP_UPN[key]
  if (override) {
    const found = await findUserByUpn(override)
    if (!found) {
      throw new Error(`compte « ${override} » (table de correspondance) absent du tenant Ouihelp`)
    }
    return found.userPrincipalName || override
  }

  const local = key.split('@')[0] ?? ''
  const initial = local.slice(0, 1)
  const surname = local.slice(1)
  if (!initial || surname.length < 2) {
    throw new Error(`adresse « ${onelaUpn} » non interprétable — à ajouter à ONELA_TO_OUIHELP_UPN`)
  }
  const domain = targetUserDomain()
  const candidates = await findUsersBySurname(surname, domain)
  const matching = candidates.filter((u) =>
    (u.givenName ?? '').toLowerCase().startsWith(initial),
  )
  if (matching.length === 1) return matching[0]!.userPrincipalName
  if (matching.length === 0) {
    throw new Error(
      `aucun compte « ${initial}* ${surname} » sur @${domain} — à ajouter à ONELA_TO_OUIHELP_UPN`,
    )
  }
  throw new Error(
    `${matching.length} comptes possibles (${matching.map((u) => u.userPrincipalName).join(', ')}) — ` +
      `à trancher dans ONELA_TO_OUIHELP_UPN`,
  )
}

/** Traduit un principal du plan en nom de connexion SharePoint côté Ouihelp. */
async function resolvePrincipal(sourcePrincipal: string): Promise<FolderAclPrincipal> {
  if (isUserPrincipal(sourcePrincipal)) {
    const upn = await resolveTargetUserUpn(sourcePrincipal)
    return { label: upn, loginName: userLoginName(upn) }
  }
  const name = targetGroupName(sourcePrincipal)
  const group = await findGroupByExactName(name)
  if (!group) {
    throw new Error(`groupe « ${name} » introuvable sur le tenant Ouihelp`)
  }
  return { label: name, loginName: securityGroupLoginName(group.id) }
}

/**
 * Applique le plan de droits aux dossiers du site cible.
 *
 * Les dossiers sont CRÉÉS s'ils n'existent pas encore, et l'appel se fait AVANT
 * le transfert : poser les droits après aurait laissé une fenêtre pendant
 * laquelle des documents nominatifs sont déposés dans un dossier encore ouvert
 * à l'ensemble des membres du site.
 *
 * Le nom des dossiers n'est pas deviné : il est lu sur le SITE SOURCE et
 * rapproché des types du plan (`Clients` → `clients`). Un site dont le dossier
 * s'appelle autrement est signalé plutôt que traité au hasard.
 */
export async function applyFolderPlan(params: {
  code: string | null
  sourceDriveId: string
  targetDriveId: string
  targetRootItemId: string
  targetSiteUrl: string
}): Promise<FolderPlanOutcome> {
  const plan = folderPlanFor(params.code)
  if (!plan) {
    return {
      reports: [],
      status: 'skipped',
      error: `aucun plan de droits pour le code « ${params.code ?? '?'} » (absent de l'export DSI)`,
    }
  }

  const sourceRoot = await getRootItemId(params.sourceDriveId, SOURCE)
  const sourceFolders = await listChildFolders(params.sourceDriveId, sourceRoot, SOURCE)

  const reports: FolderPermissionReport[] = []
  for (const type of XIMI_FOLDER_TYPES) {
    const aliases = XIMI_FOLDER_ALIASES[type]
    const match = sourceFolders.find((f) => aliases.includes(normalize(f.name)))
    if (!match) {
      reports.push({
        type,
        folderName: null,
        status: 'skipped',
        applied: [],
        failures: [
          `aucun dossier « ${type} » sur le site source (racine : ${
            sourceFolders.map((f) => f.name).join(', ') || 'vide'
          })`,
        ],
      })
      continue
    }

    try {
      // Idempotent : récupère le dossier déjà transféré, ou le crée pour que les
      // droits soient en place avant le premier dépôt de fichier.
      const targetFolderId = await createTargetFolder(
        params.targetDriveId,
        params.targetRootItemId,
        match.name,
        match.times,
      )
      const path = await getTargetItemServerRelativePath(params.targetDriveId, targetFolderId)

      const principals: FolderAclPrincipal[] = []
      const failures: string[] = []
      for (const sourcePrincipal of plan[type]) {
        try {
          principals.push(await resolvePrincipal(sourcePrincipal))
        } catch (err) {
          failures.push(`${sourcePrincipal} : ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const res = await applyFolderAcl({
        siteUrl: params.targetSiteUrl,
        folderServerRelativePath: path,
        principals,
      })
      reports.push({
        type,
        folderName: match.name,
        status: failures.length === 0 && res.failures.length === 0 ? 'success' : 'error',
        applied: res.applied,
        failures: [...failures, ...res.failures],
      })
    } catch (err) {
      reports.push({
        type,
        folderName: match.name,
        status: 'error',
        applied: [],
        failures: [err instanceof Error ? err.message : String(err)],
      })
    }
  }

  const failed = reports.filter((r) => r.status === 'error')
  const skipped = reports.filter((r) => r.status === 'skipped')
  return {
    reports,
    status: failed.length > 0 ? 'error' : skipped.length === reports.length ? 'skipped' : 'success',
    error:
      failed.length === 0 && skipped.length === 0
        ? null
        : reports
            .filter((r) => r.failures.length > 0)
            .map((r) => `${r.type} → ${r.failures.join(' ; ')}`)
            .join(' | ')
            .slice(0, 2000) || null,
  }
}
