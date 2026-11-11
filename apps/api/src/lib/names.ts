// Normalisation prénom / nom → partie locale d'une adresse (a-z + tiret, sans
// accents). Partagée par la migration des comptes et la création de comptes :
// les deux doivent produire EXACTEMENT la même adresse `prenom.nom@…`.

/**
 * Le tiret des prénoms/noms composés est CONSERVÉ pour que l'adresse GOH
 * (prenom.nom@mig.onela.com) et l'alias @onela.com soient identiques
 * (« Jean-Pierre » → « jean-pierre », pas « jeanpierre »). Les espaces et « _ »
 * deviennent des tirets, on ne garde que lettres et tiret, tirets multiples
 * réduits à un seul, pas de tiret en début/fin.
 */
export function normalizeNamePart(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // diacritiques
    .replace(/[\s_]+/g, '-') // espaces → tiret (composés)
    .replace(/[^a-z-]/g, '') // ne garde que lettres et tiret
    .replace(/-+/g, '-') // tirets multiples → un seul
    .replace(/^-|-$/g, '') // pas de tiret en début/fin
}
