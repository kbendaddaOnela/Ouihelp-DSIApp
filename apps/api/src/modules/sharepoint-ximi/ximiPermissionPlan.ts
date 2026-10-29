// Plan d'attribution des droits des dossiers de la bibliothèque « Documents »
// d'un site Ximi, et traduction des principaux ONELA → Ouihelp.
//
// SOURCE : export « Permissionsgroupsandusers - Groupes Dynamique.csv » fourni
// par la DSI le 29/10/2026 — une ligne par (site, dossier), la liste des
// groupes de sécurité et des utilisateurs autorisés sur ce dossier.
//
// POURQUOI UN PLAN FIGÉ PLUTÔT QU'UNE LECTURE DU TENANT ONELA
//
// Relire les ACL sur ONELA ne dispenserait de rien : les groupes y portent des
// objectId propres au tenant ONELA, qui n'existent pas côté Ouihelp. Il faudrait
// de toute façon re-résoudre chaque principal PAR SON NOM sur Ouihelp. Le plan
// n'ajoute donc aucune imprécision ; il évite une permission Graph de lecture
// des ACL sur ONELA, et il a surtout l'avantage décisif d'être relu par un
// humain et auditable en revue de code — ce qu'une copie automatique d'ACL
// n'est pas. Un dossier « Clients » ouvert au mauvais groupe expose des données
// nominatives de bénéficiaires.
//
// DEUX COQUILLES DE L'EXPORT, CORRIGÉES ICI
//
// Sur 73 sites, 72 portent `SG-DYN-ONELA-RESEAU-QUALITE` et 72
// `SG-DYN-ONELA-RH-FORMATION`. Le site `lyon` porte `SG-DYN-ONELA-QUALITE` et le
// site `loir` `SG-DYN-ONELA-FORMATION` — et il leur manque respectivement le
// groupe complet. 72 + 1 = 73 des deux côtés : ce sont des fautes de frappe de
// l'export, pas deux groupes distincts. Elles sont corrigées par
// `SOURCE_GROUP_ALIASES`, de façon explicite et non silencieuse.

/** Dossiers de la bibliothèque « Documents » régis par le plan. */
export const XIMI_FOLDER_TYPES = ['clients', 'intervenants'] as const
export type XimiFolderType = (typeof XIMI_FOLDER_TYPES)[number]

/**
 * Noms acceptés pour retrouver le dossier sur le site, en forme normalisée
 * (minuscules, sans accents ni séparateurs).
 *
 * Le plan nomme les dossiers en minuscules, le site les nomme « Clients » et
 * « Intervenants ». On ne devine pas : le nom réel est lu sur le site source et
 * rapproché de cette liste.
 */
export const XIMI_FOLDER_ALIASES: Record<XimiFolderType, string[]> = {
  clients: ['clients', 'client', 'dossiersclients'],
  intervenants: ['intervenants', 'intervenant', 'dossiersintervenants', 'salaries'],
}

/** Coquilles de l'export CSV → nom réel du groupe (cf. en-tête). */
export const SOURCE_GROUP_ALIASES: Record<string, string> = {
  'SG-DYN-ONELA-QUALITE': 'SG-DYN-ONELA-RESEAU-QUALITE',
  'SG-DYN-ONELA-FORMATION': 'SG-DYN-ONELA-RH-FORMATION',
}

/**
 * Comptes ONELA → compte Ouihelp correspondant, quand la correspondance n'est
 * pas dérivable de l'adresse.
 *
 * `cmarmouze@onela.com` → `cathy.marmouze@mig.onela.com` : la source est en
 * `<initiale><nom>`, la cible en `<prénom>.<nom>`. On ne peut pas remonter le
 * prénom depuis l'initiale, d'où cette table. Les comptes absents d'ici sont
 * résolus à l'exécution par recherche sur le nom de famille, et seulement si la
 * correspondance est UNIQUE (cf. `resolveTargetUser`).
 */
export const ONELA_TO_OUIHELP_UPN: Record<string, string> = {
  'cmarmouze@onela.com': 'cathy.marmouze@mig.onela.com',
  'crenard@onela.com': 'catherine.renard@mig.onela.com',
}

/** Vrai si le principal est un utilisateur (et non un groupe de sécurité). */
export function isUserPrincipal(principal: string): boolean {
  return principal.includes('@')
}

/**
 * Nom du groupe équivalent sur le tenant Ouihelp.
 *
 * Les groupes ONELA ont été recréés côté Ouihelp en déplaçant « ONELA » du
 * milieu vers un préfixe : `SG-DYN-ONELA-AG-ARG` → `ONELA - SG-DYN-AG-ARG`.
 * C'est exactement la convention que suit déjà l'attribution au niveau du site
 * (`XIMI_DYNAMIC_GROUP_PATTERN`, défaut « ONELA - SG-DYN-AG-{TRI} »).
 *
 * Aucun repli approximatif : si le nom produit n'existe pas sur le tenant,
 * l'attribution est signalée en échec. Donner le groupe « presque bon » à un
 * dossier nominatif serait une fuite de données.
 */
export function targetGroupName(sourceGroupName: string): string {
  const name = SOURCE_GROUP_ALIASES[sourceGroupName] ?? sourceGroupName
  const prefix = process.env['XIMI_GROUP_TARGET_PREFIX'] ?? 'ONELA - '
  const m = /^SG-DYN-ONELA-(.+)$/i.exec(name)
  if (m?.[1]) return `${prefix}SG-DYN-${m[1]}`
  return name
}

/** Domaine des comptes migrés côté Ouihelp. */
export function targetUserDomain(): string {
  return process.env['XIMI_USER_TARGET_DOMAIN'] ?? 'mig.onela.com'
}

export interface FolderPlan {
  clients: string[]
  intervenants: string[]
}

/**
 * Code de site Ximi → principaux autorisés sur chacun des deux dossiers.
 *
 * Les noms sont ceux du tenant ONELA, tels qu'exportés ; la traduction vers
 * Ouihelp est faite par `targetGroupName` / `resolveTargetUser`.
 */
export const XIMI_FOLDER_PERMISSION_PLAN: Record<string, FolderPlan> = {
  aixp: {
    clients: ['SG-DYN-ONELA-AG-AIX', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-AIX', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  ande: {
    clients: ['SG-DYN-ONELA-AG-AND', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-AND', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  anti: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  anto: {
    clients: ['SG-DYN-ONELA-AG-ANT', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST'],
    intervenants: ['SG-DYN-ONELA-AG-ANT', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST'],
  },
  arge: {
    clients: ['SG-DYN-ONELA-AG-ARG', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST'],
    intervenants: ['SG-DYN-ONELA-AG-ARG', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST'],
  },
  arle: {
    clients: ['SG-DYN-ONELA-AG-ARL', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-ARL', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  arme: {
    clients: ['SG-DYN-ONELA-AG-ARM', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
    intervenants: ['SG-DYN-ONELA-AG-ARM', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
  },
  bagn: {
    clients: ['SG-DYN-ONELA-AG-BSC', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-BSC', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  bell: {
    clients: ['SG-DYN-ONELA-AG-BEL', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-BEL', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  biar: {
    clients: ['SG-DYN-ONELA-AG-BIA', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-BIA', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  boul: {
    clients: ['SG-DYN-ONELA-AG-BOU', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST'],
    intervenants: ['SG-DYN-ONELA-AG-BOU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST'],
  },
  brug: {
    clients: ['SG-DYN-ONELA-AG-BRU', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-BRU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  caen: {
    clients: ['SG-DYN-ONELA-AG-CAE', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
    intervenants: ['SG-DYN-ONELA-AG-CAE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
  },
  cann: {
    clients: ['SG-DYN-ONELA-AG-CAN', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-CAN', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  chil: {
    clients: ['SG-DYN-ONELA-AG-CHI', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-CHI', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  clch: {
    clients: ['SG-DYN-ONELA-AG-CLI', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-CLI', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  crbv: {
    clients: ['SG-DYN-ONELA-AG-COU', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST'],
    intervenants: ['SG-DYN-ONELA-AG-COU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST'],
  },
  croi: {
    clients: ['SG-DYN-ONELA-AG-CRX', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
    intervenants: ['SG-DYN-ONELA-AG-CRX', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
  },
  dem1: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  dem2: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  dfpr: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  dijo: {
    clients: ['SG-DYN-ONELA-AG-DIJ', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-DIJ', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  dlys: {
    clients: ['SG-DYN-ONELA-AG-CSM', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST', 'SG-DYN-ONELA-AG-DAM'],
    intervenants: ['SG-DYN-ONELA-AG-CSM', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST', 'SG-DYN-ONELA-AG-DAM'],
  },
  evre: {
    clients: ['SG-DYN-ONELA-AG-EVR', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
    intervenants: ['SG-DYN-ONELA-AG-EVR', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
  },
  font: {
    clients: ['SG-DYN-ONELA-AG-FON', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-FON', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  gagn: {
    clients: ['SG-DYN-ONELA-AG-GAG', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-GAG', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  gren: {
    clients: ['SG-DYN-ONELA-AG-GRE', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-GRE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  gyve: {
    clients: ['SG-DYN-ONELA-AG-GIF', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-GIF', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  haze: {
    clients: ['SG-DYN-ONELA-AG-HAZ', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
    intervenants: ['SG-DYN-ONELA-AG-HAZ', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
  },
  'hq-balm': {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  'hq-hori': {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  joeu: {
    clients: ['SG-DYN-ONELA-AG-JOE', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-JOE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  laro: {
    clients: ['SG-DYN-ONELA-AG-LAR', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-LAR', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  libo: {
    clients: ['SG-DYN-ONELA-AG-LIB', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-LIB', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  lile: {
    clients: ['SG-DYN-ONELA-AG-LIL', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
    intervenants: ['SG-DYN-ONELA-AG-LIL', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
  },
  lill: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  limo: {
    clients: ['SG-DYN-ONELA-AG-LIM', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-LIM', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  loir: {
    clients: ['SG-DYN-ONELA-AG-MBR', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST', 'SG-DYN-ONELA-AG-SCH', 'SG-DYN-ONELA-AG-STS'],
    intervenants: ['SG-DYN-ONELA-AG-MBR', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST', 'SG-DYN-ONELA-AG-SCH', 'SG-DYN-ONELA-AG-STS'],
  },
  lyon: {
    clients: ['SG-DYN-ONELA-AG-BRO', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-BRO', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  mais: {
    clients: ['SG-DYN-ONELA-AG-STM', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-STM', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  mans: {
    clients: ['SG-DYN-ONELA-AG-LEM', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-LEM', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  mar2: {
    clients: ['SG-DYN-ONELA-AG-MAR', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-MAR', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  mars: {
    clients: ['SG-DYN-ONELA-AG-MAR', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-MAR', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  metz: {
    clients: ['SG-DYN-ONELA-AG-MET', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-MET', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  monb: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  mtpl: {
    clients: ['SG-DYN-ONELA-AG-MON', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-MON', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  nant: {
    clients: ['SG-DYN-ONELA-AG-NAN', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-NAN', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  neui: {
    clients: ['SG-DYN-ONELA-AG-NEU', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST'],
    intervenants: ['SG-DYN-ONELA-AG-NEU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST'],
  },
  nime: {
    clients: ['SG-DYN-ONELA-AG-NIM', 'SG-DYN-ONELA-AG-MON', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-NIM', 'SG-DYN-ONELA-AG-MON', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  nois: {
    clients: ['SG-DYN-ONELA-AG-NOI', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-NOI', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  onse: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  orle: {
    clients: ['SG-DYN-ONELA-AG-ORL', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST'],
    intervenants: ['SG-DYN-ONELA-AG-ORL', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST'],
  },
  pa16: {
    clients: ['SG-DYN-ONELA-AG-PA16', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST'],
    intervenants: ['SG-DYN-ONELA-AG-PA16', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST'],
  },
  paca: {
    clients: ['SG-DYN-ONELA-AG-MENT', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST', 'SG-DYN-ONELA-AG-NIC'],
    intervenants: ['SG-DYN-ONELA-AG-MENT', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST', 'SG-DYN-ONELA-AG-NIC'],
  },
  pari: {
    clients: ['SG-DYN-ONELA-AG-PA13', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST', 'SG-DYN-ONELA-AG-PAR'],
    intervenants: ['SG-DYN-ONELA-AG-PA13', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST', 'SG-DYN-ONELA-AG-PAR'],
  },
  reim: {
    clients: ['SG-DYN-ONELA-AG-REI', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-REI', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  renn: {
    clients: ['SG-DYN-ONELA-AG-REN', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-REN', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  roue: {
    clients: ['SG-DYN-ONELA-AG-DIE', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST', 'SG-DYN-ONELA-AG-ELB', 'SG-DYN-ONELA-AG-ROU', 'SG-DYN-ONELA-AG-YVE'],
    intervenants: ['SG-DYN-ONELA-AG-DIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST', 'SG-DYN-ONELA-AG-ELB', 'SG-DYN-ONELA-AG-ROU', 'SG-DYN-ONELA-AG-YVE'],
  },
  sger: {
    clients: ['SG-DYN-ONELA-AG-SAI', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST'],
    intervenants: ['SG-DYN-ONELA-AG-SAI', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST'],
  },
  sieg: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  sien: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  stbr: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  stna: {
    clients: ['SG-DYN-ONELA-AG-SAN', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-SAN', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  stra: {
    clients: ['SG-DYN-ONELA-AG-STR', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-STR', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  thia: {
    clients: ['SG-DYN-ONELA-AG-THI', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-THI', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  tlse: {
    clients: ['SG-DYN-ONELA-AG-TOU', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
    intervenants: ['SG-DYN-ONELA-AG-TOU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-Ouest_Sud-Ouest'],
  },
  tour: {
    clients: ['SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com'],
    intervenants: ['SG-DYN-ONELA-RH-PAIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION'],
  },
  vale: {
    clients: ['SG-DYN-ONELA-AG-VAL', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
    intervenants: ['SG-DYN-ONELA-AG-VAL', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-NORD_NORMANDIE_EST'],
  },
  vers: {
    clients: ['SG-DYN-ONELA-AG-VER', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_OUEST'],
    intervenants: ['SG-DYN-ONELA-AG-VER', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_OUEST'],
  },
  vien: {
    clients: ['SG-DYN-ONELA-AG-VIE', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-VIE', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },
  vill: {
    clients: ['SG-DYN-ONELA-AG-VIB', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST', 'crenard@onela.com'],
    intervenants: ['SG-DYN-ONELA-AG-VIB', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST', 'crenard@onela.com'],
  },
  vinc: {
    clients: ['SG-DYN-ONELA-AG-VIN', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-IDF_EST'],
    intervenants: ['SG-DYN-ONELA-AG-VIN', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-IDF_EST'],
  },
  vlfr: {
    clients: ['SG-DYN-ONELA-AG-VIF', 'SG-DYN-ONELA-MARKETING', 'SG-DYN-ONELA-RESEAU-QUALITE', 'SG-DYN-ONELA-FINANCE-ADV', 'SG-DYN-ONELA-RESEAU', 'cmarmouze@onela.com', 'SG-DYN-ONELA-DR-SUD_EST'],
    intervenants: ['SG-DYN-ONELA-AG-VIF', 'cmarmouze@onela.com', 'SG-DYN-ONELA-RH-PAIE', 'SG-DYN-ONELA-RH-SRH', 'SG-DYN-ONELA-RH-FORMATION', 'SG-DYN-ONELA-DR-SUD_EST'],
  },}

/**
 * Groupes d'AGENCE du site, en noms source — l'union des deux dossiers.
 *
 * C'est la source de vérité pour les droits au niveau du SITE, en remplacement
 * du détour par le trigramme et `ONELA_AGENCIES` : l'export dit directement
 * quels groupes `AG-*` sont posés sur quel site. Ce détour coûtait deux sites —
 * `roue`, qui dessert quatre agences, n'en recevait qu'une, et `boul`, dont le
 * trigramme manque au référentiel de seed, aucune.
 */
export function siteAgencyGroupsFor(code: string | null): string[] {
  const plan = folderPlanFor(code)
  if (!plan) return []
  const out: string[] = []
  for (const p of [...plan.clients, ...plan.intervenants]) {
    const name = SOURCE_GROUP_ALIASES[p] ?? p
    if (/^SG-DYN-ONELA-AG-/i.test(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** Plan du site, ou null si le code est absent de l'export. */
export function folderPlanFor(code: string | null): FolderPlan | null {
  if (!code) return null
  return XIMI_FOLDER_PERMISSION_PLAN[code] ?? null
}
