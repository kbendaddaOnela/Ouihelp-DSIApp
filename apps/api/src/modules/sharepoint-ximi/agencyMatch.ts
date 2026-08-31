// Rapproche un site SharePoint d'agence du référentiel d'agences ONELA, pour en
// déduire le groupe dynamique à autoriser sur le site cible.
//
// Chaque agence a son propre site ; la règle métier est « le site de l'agence
// d'Argenteuil doit être accessible au groupe ONELA - SG-DYN-AG-ARG ». Le nom du
// site ne contient pas le trigramme : on le retrouve par correspondance de nom.
// Un rapprochement manqué n'est pas grave (l'opérateur saisit le groupe à la
// main) ; un FAUX rapprochement le serait beaucoup plus — il donnerait accès aux
// données d'une agence aux salariés d'une autre. D'où une correspondance stricte
// (égalité sur une forme normalisée), jamais approximative.

import { ONELA_AGENCIES } from '@dsi-app/shared'

export interface AgencyMatch {
  name: string
  trigramme: string
  region: string
}

/** Forme normalisée : minuscules, sans accents, sans séparateurs. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** Index nom normalisé → agence, construit une seule fois. */
const BY_NORMALIZED_NAME = new Map<string, AgencyMatch>()
/** Index trigramme normalisé → agence. */
const BY_TRIGRAMME = new Map<string, AgencyMatch>()

for (const [name, info] of Object.entries(ONELA_AGENCIES)) {
  const match: AgencyMatch = { name, trigramme: info.service, region: info.region }
  BY_NORMALIZED_NAME.set(normalize(name), match)
  BY_TRIGRAMME.set(normalize(info.service), match)
}

/**
 * Retrouve l'agence d'un site depuis son titre et/ou son alias d'URL.
 *
 * Ordre d'essai : titre exact, alias exact, puis titre/alias débarrassés d'un
 * préfixe usuel (« ONELA », « AG », « Agence »). On s'arrête là : tenter une
 * correspondance partielle ferait matcher « Paris 15 » sur « Paris », donc un
 * groupe dynamique erroné.
 */
export function agencyOf(siteTitle: string | null, alias: string | null): AgencyMatch | null {
  const candidates: string[] = []
  for (const raw of [siteTitle, alias]) {
    if (!raw) continue
    candidates.push(raw)
    // « ONELA - Argenteuil », « AG-ARG », « Agence Argenteuil »…
    const stripped = raw.replace(/^\s*(onela|agence|ag)\s*[-_ ]+/i, '')
    if (stripped !== raw) candidates.push(stripped)
  }
  for (const cand of candidates) {
    const norm = normalize(cand)
    if (!norm) continue
    const byName = BY_NORMALIZED_NAME.get(norm)
    if (byName) return byName
    // Un alias court est très probablement le trigramme (ex. /sites/ARG).
    if (norm.length <= 4) {
      const byTri = BY_TRIGRAMME.get(norm)
      if (byTri) return byTri
    }
  }
  return null
}

/**
 * Nom du groupe dynamique d'une agence sur le tenant Ouihelp.
 * Format imposé côté annuaire : « ONELA - SG-DYN-AG-<TRIGRAMME> ».
 * Surchargeable par env si la convention de nommage évolue.
 */
export function dynamicGroupNameFor(trigramme: string): string {
  const pattern = process.env['XIMI_DYNAMIC_GROUP_PATTERN'] ?? 'ONELA - SG-DYN-AG-{TRI}'
  return pattern.replace('{TRI}', trigramme.toUpperCase())
}
