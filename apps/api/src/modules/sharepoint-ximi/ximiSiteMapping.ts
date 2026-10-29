// Correspondance EXPLICITE entre le code d'un site Ximi et la ou les agences
// ONELA qu'il dessert.
//
// SOURCES : classeur « Mappage Sites Ximi ONELA.xlsx » (DSI, 28/10/2026), puis
// l'export des droits « Permissionsgroupsandusers » (DSI, 29/10/2026) qui porte
// les groupes `SG-DYN-ONELA-AG-*` réellement positionnés site par site. Le
// second corrige le premier sur deux sites : `roue` dessert QUATRE agences
// (Dieppe, Elbeuf, Rouen, Yvetot) et non Rouen seule, et `nime` en dessert deux
// (Nîmes + Montpellier). Avec l'ancienne table, Dieppe, Elbeuf et Yvetot
// n'auraient eu accès à aucun site.
//
// POURQUOI UNE TABLE ET PAS UNE RÈGLE
//
// Les sites sont nommés `Ximi-<code>`, mais le code n'est dérivable ni du nom de
// l'agence ni de son trigramme : `crbv` = La Garenne-Colombes, `gyve` =
// Savigny-sur-Orge, `mais` = Saint-Maur-des-Fossés. Et le trigramme lui-même est
// irrégulier (Lyon → BRO, Melun → DAM, Savigny-sur-Orge → GIF).
//
// Le contre-exemple qui tranche le débat : `Ximi-monb` est **Montauban**, pas
// Montbrison. Toute heuristique de préfixe aurait donné le groupe de Montbrison
// à l'agence de Montauban. Comme ce groupe ouvre l'accès à des documents
// nominatifs (attestations de salaire), un faux positif de ce type est une fuite
// de données — d'où une table relue par un humain, auditable en revue de code.
//
// UN SITE PEUT DESSERVIR PLUSIEURS AGENCES
//
// Quatre sites sont mutualisés (`loir`, `pari`, `dlys`, `paca`). Ils reçoivent
// donc PLUSIEURS groupes dynamiques, d'où un tableau de trigrammes et non une
// valeur unique.

/**
 * Code de site Ximi (minuscules, sans le préfixe « ximi- ») → trigrammes des
 * agences desservies. Un seul élément dans le cas général.
 */
export const XIMI_CODE_TO_TRIGRAMMES: Record<string, string[]> = {
  // ── Mono-agence (55 sites, issus de la colonne « Agence » du classeur) ────
  aixp: ['AIX'], // Aix-en-Provence
  ande: ['AND'], // Andernos-les-Bains
  anto: ['ANT'], // Antony
  arge: ['ARG'], // Argenteuil
  arle: ['ARL'], // Arles
  arme: ['ARM'], // Armentières
  bagn: ['BSC'], // Bagnols-sur-Cèze
  bell: ['BEL'], // Belleville-en-Beaujolais
  biar: ['BIA'], // Biarritz
  brug: ['BRU'], // Bruges
  caen: ['CAE'], // Caen
  cann: ['CAN'], // Cannes
  chil: ['CHI'], // Chilly-Mazarin
  clch: ['CLI'], // Clichy-sous-Bois
  crbv: ['COU'], // La Garenne-Colombes
  croi: ['CRX'], // Croix
  dijo: ['DIJ'], // Dijon
  evre: ['EVR'], // Evreux
  font: ['FON'], // Fontainebleau
  gagn: ['GAG'], // Gagny
  gren: ['GRE'], // Grenoble
  gyve: ['GIF'], // Savigny-sur-Orge
  haze: ['HAZ'], // Hazebrouck
  joeu: ['JOE'], // Joeuf
  laro: ['LAR'], // La Rochelle
  libo: ['LIB'], // Libourne
  lile: ['LIL'], // Lille
  limo: ['LIM'], // Limoges
  lyon: ['BRO'], // Lyon
  mais: ['STM'], // Saint-Maur-des-Fossés
  mans: ['LEM'], // Le Mans
  mars: ['MAR'], // Marseille Prado
  metz: ['MET'], // Metz
  mtpl: ['MON'], // Montpellier
  nant: ['NAN'], // Nantes
  neui: ['NEU'], // Neuilly-sur-Seine
  nime: ['NIM', 'MON'], // Nîmes + Montpellier (cf. export des droits)
  nois: ['NOI'], // Noisy-le-Sec
  orle: ['ORL'], // Orléans
  pa16: ['PA16'], // Paris 16
  reim: ['REI'], // Reims
  renn: ['REN'], // Rennes
  // roue est multi-agences, cf. bloc ci-dessous
  sger: ['SAI'], // Saint-Germain-en-Laye
  stna: ['SAN'], // Saint-Nazaire
  stra: ['STR'], // Strasbourg
  thia: ['THI'], // Thiais
  tlse: ['TOU'], // Toulouse
  vale: ['VAL'], // Valenciennes
  vers: ['VER'], // Versailles
  vien: ['VIE'], // Vienne
  vill: ['VIB'], // Villeurbanne
  vinc: ['VIN'], // Vincennes
  vlfr: ['VIF'], // Villefranche-sur-Saône

  // ── Multi-agences : le site reçoit TOUS ces groupes ──────────────────────
  boul: ['BOU'], // Boulogne-Billancourt — trigramme confirmé par l'export des droits
  dlys: ['DAM', 'CSM'], // Seine-et-Marne : Melun + Champs-sur-Marne
  loir: ['MBR', 'STS', 'SCH'], // Loire : Montbrison + Saint-Etienne + Saint-Chamond
  paca: ['NIC', 'MENT'], // PACA : Nice + Menton
  pari: ['PAR', 'PA13'], // Paris : Paris 11 + Paris 13
  roue: ['DIE', 'ELB', 'ROU', 'YVE'], // Rouen : Dieppe + Elbeuf + Rouen + Yvetot
  mar2: ['MAR'], // ancien site Marseille — même agence que « mars »
}

/**
 * Codes qui ne désignent PAS une agence (applications métier, sièges, entités).
 * Les distinguer d'un code inconnu évite de faire chercher à l'opérateur une
 * agence qui n'existe pas — et évite surtout qu'on leur colle un groupe par
 * défaut « pour faire quelque chose ».
 */
export const XIMI_NON_AGENCY_CODES = new Map<string, string>([
  ['dfpr', 'Domifacile Pro'],
  ['hq-balm', 'Siège (entité BALM)'],
  ['hq-hori', 'Siège (entité Horizon)'],
  ['onse', 'ONELA Services'],
  ['sieg', 'Application Siège BALM'],
  ['sien', 'Application Support NHS'],
])

/**
 * Agences RÉELLES dont le site existe, mais qui sont absentes de
 * `ONELA_AGENCIES`. Elles n'ont donc pas de trigramme connu, et aucun groupe
 * dynamique ne peut en être déduit.
 *
 * L'export des droits du 29/10/2026 confirme qu'aucun groupe `AG-*` n'est
 * positionné sur leurs sites côté ONELA : ces agences n'ont pas (encore) de
 * groupe dynamique. Il n'y a donc rien à reproduire, et rien à deviner. Le site
 * est migrable, reçoit les droits transverses du plan (RH, Marketing, Finance…)
 * mais aucun groupe d'agence — ce qui est l'état de la source.
 *
 * Boulogne-Billancourt, elle, EST sortie de cette liste : l'export porte bien
 * `SG-DYN-ONELA-AG-BOU`. Son trigramme reste absent de `ONELA_AGENCIES` (données
 * de seed), sans conséquence : les groupes du site sont désormais dérivés du
 * plan, pas du référentiel.
 */
export const XIMI_AGENCY_OUTSIDE_REFERENTIAL = new Map<string, string>([
  ['anti', 'Antibes — aucun groupe d\'agence dans l\'export des droits'],
  ['monb', 'Montauban — aucun groupe d\'agence dans l\'export des droits'],
  ['stbr', 'Saint-Brieuc — aucun groupe d\'agence dans l\'export des droits'],
])

/**
 * Codes volontairement NON mappés, en attente d'une confirmation.
 *
 * `lill` : le classeur indique « Lille » en agence mais « je ne sais pas » en
 * commentaire, et un second site (`lile`) porte déjà Lille. L'export des droits
 * tranche dans le sens de la prudence : `lile` porte `SG-DYN-ONELA-AG-LIL`,
 * `lill` n'a aucun groupe d'agence. On reproduit la source — donner le groupe de
 * Lille aux deux sites exposerait les données d'une agence à une autre.
 *
 * `dem1`, `dem2`, `tour` : présents dans l'export, sans groupe d'agence non
 * plus ; vus de la DSI ce sont des sites de démonstration / une agence fermée.
 */
export const XIMI_PENDING_CONFIRMATION = new Map<string, string>([
  ['lill', 'Doublon de « lile » — aucun groupe d\'agence dans l\'export des droits'],
  ['dem1', 'Site de démonstration'],
  ['dem2', 'Site de démonstration'],
  ['tour', 'Tours — aucun groupe d\'agence dans l\'export des droits'],
])

/**
 * Extrait le code Ximi d'un nom de site ou d'un alias d'URL.
 * « Ximi-dijo » → « dijo ». Renvoie null si le nom ne suit pas la convention.
 */
export function ximiCodeOf(siteTitle: string | null, alias: string | null): string | null {
  for (const raw of [alias, siteTitle]) {
    if (!raw) continue
    const m = /^\s*ximi[-_ ]+(.+?)\s*$/i.exec(raw)
    if (m?.[1]) return m[1].toLowerCase()
  }
  return null
}

/** Trigrammes associés à un code Ximi (tableau vide si absent de la table). */
export function trigrammesForXimiCode(code: string | null): string[] {
  if (!code) return []
  return XIMI_CODE_TO_TRIGRAMMES[code] ?? []
}

/**
 * Raison pour laquelle un code n'a volontairement pas d'agence, ou null si le
 * code est simplement inconnu. Permet à l'interface de dire « siège, rien à
 * faire » plutôt que « à compléter ».
 */
export function nonAgencyReason(code: string | null): string | null {
  if (!code) return null
  return (
    XIMI_NON_AGENCY_CODES.get(code) ??
    XIMI_AGENCY_OUTSIDE_REFERENTIAL.get(code) ??
    XIMI_PENDING_CONFIRMATION.get(code) ??
    null
  )
}
