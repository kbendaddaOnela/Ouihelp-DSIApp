// Correspondance EXPLICITE entre le code d'un site Ximi et la ou les agences
// ONELA qu'il dessert.
//
// SOURCE : classeur « Mappage Sites Ximi ONELA.xlsx » fourni par la DSI le
// 28/10/2026, recoupé avec le référentiel `ONELA_AGENCIES`.
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
  nime: ['NIM'], // Nîmes
  nois: ['NOI'], // Noisy-le-Sec
  orle: ['ORL'], // Orléans
  pa16: ['PA16'], // Paris 16
  reim: ['REI'], // Reims
  renn: ['REN'], // Rennes
  roue: ['ROU'], // Rouen
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
  dlys: ['DAM', 'CSM'], // Seine-et-Marne : Melun + Champs-sur-Marne
  loir: ['MBR', 'STS', 'SCH'], // Loire : Montbrison + Saint-Etienne + Saint-Chamond
  paca: ['NIC', 'MENT'], // PACA : Nice + Menton
  pari: ['PAR', 'PA13'], // Paris : Paris 11 + Paris 13
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
  ['mar2', 'Ancienne agence Marseille'],
  ['onse', 'ONELA Services'],
  ['sieg', 'Application Siège BALM'],
  ['sien', 'Application Support NHS'],
])

/**
 * Agences RÉELLES dont le site existe, mais qui sont absentes de
 * `ONELA_AGENCIES`. Elles n'ont donc pas de trigramme connu, et aucun groupe
 * dynamique ne peut en être déduit.
 *
 * Deux issues possibles, à trancher avec la DSI : les ajouter au référentiel
 * (il faut leur trigramme, qui conditionne le nom du groupe), ou saisir le
 * groupe à la main sur la carte. Tant que ce n'est pas tranché, le site est
 * migrable mais ne reçoit aucun droit — c'est le défaut sûr.
 */
export const XIMI_AGENCY_OUTSIDE_REFERENTIAL = new Map<string, string>([
  ['anti', 'Antibes'],
  ['boul', 'Boulogne-Billancourt'],
  ['monb', 'Montauban'],
  ['stbr', 'Saint-Brieuc'],
])

/**
 * Codes volontairement NON mappés, en attente d'une confirmation.
 *
 * `lill` : le classeur indique « Lille » en agence mais « je ne sais pas » en
 * commentaire, et un second site (`lile`) porte déjà Lille. Tant que la DSI n'a
 * pas dit lequel sert quoi, on n'accorde rien : donner le groupe de Lille au
 * mauvais site exposerait les données d'une agence à une autre.
 */
export const XIMI_PENDING_CONFIRMATION = new Map<string, string>([
  ['lill', 'Lille ? — doublon avec « lile », à confirmer (classeur : « je ne sais pas »)'],
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
