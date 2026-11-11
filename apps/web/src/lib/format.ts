// Formatage d'affichage partagé (fr-FR). Ces fonctions étaient recopiées à
// l'identique dans plusieurs pages.

/** Taille lisible en octets : « 0 o », « 12,3 Mo »… (base 1024, une décimale au-delà de l'octet). */
export function fmtBytes(n: number): string {
  if (!n) return '0 o'
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** Date courte JJ/MM/AA, « — » si absente. */
export function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  })
}

/** Date et heure courtes, « — » si absentes. */
export function fmtDateTime(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}
