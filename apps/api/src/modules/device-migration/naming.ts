import type { DeviceMigrationRow } from './schema'

/**
 * Nom des postes après bascule chez Ouihelp (convention DSI, 16/10/2026) :
 *   ONL-<site>-<fin du n° de série>   ex. ONL-AIX-6HWLFH4, ONL-SIE-E9A7600
 * <site> = trigramme d'agence (table agencies) ou SIE pour le siège. 15 caractères maximum
 * (limite NetBIOS) : « ONL-XXX- » en prend 8, il reste 7 caractères de n° de série.
 * Appliqué par le poste APRÈS l'installation du PPKG : le nom saisi dans le PPKG est ignoré.
 */

export const SIEGE_CODE = 'SIE'
const SERIAL_CHARS = 7

export interface AgencyCodes {
  /** trigramme → agence */
  byTrigramme: Map<string, { name: string }>
  /** nom d'agence (minuscules) → trigramme */
  trigrammeByName: Map<string, string>
}

export function serialTail(serial: string): string {
  return serial
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(-SERIAL_CHARS)
}

/** Code site du poste : nom actuel d'abord (convention ONELA), sinon agence de l'utilisateur. */
export function siteCode(r: DeviceMigrationRow, codes: AgencyCodes): string | null {
  const name = (r.displayName ?? '').toUpperCase()
  // Déjà au nouveau format (ONL-AIX-…) : on garde le site
  const already = name.match(/^ONL-([A-Z]{3})-/)?.[1]
  if (already && (already === SIEGE_CODE || codes.byTrigramme.has(already))) return already
  const prefix = name.match(/^([A-Z]{2,5})-/)?.[1]
  if (prefix && codes.byTrigramme.has(prefix)) return prefix
  // Convention ONELA du siège : ONL-<n° de série>
  if (prefix === 'ONL') return SIEGE_CODE
  const office = r.onelaOfficeLocation?.trim().toLowerCase()
  if (office) {
    const tri = codes.trigrammeByName.get(office)
    if (tri) return tri
    if (/^si[eè]ge/.test(office)) return SIEGE_CODE
  }
  return null
}

export function autoTargetName(r: DeviceMigrationRow, codes: AgencyCodes): string | null {
  if (!r.serialNumber) return null
  const site = siteCode(r, codes)
  if (!site) return null
  return `ONL-${site}-${serialTail(r.serialNumber)}`
}

/** Règles Windows : 15 caractères, lettres / chiffres / tirets, pas uniquement des chiffres. */
export function invalidComputerName(name: string): string | null {
  if (name.length === 0 || name.length > 15) return '15 caractères maximum'
  if (!/^[A-Z0-9-]+$/.test(name)) return 'Lettres majuscules, chiffres et tirets uniquement'
  if (/^[0-9]+$/.test(name)) return 'Ne peut pas être uniquement numérique'
  if (name.startsWith('-') || name.endsWith('-'))
    return 'Ne peut pas commencer ni finir par un tiret'
  return null
}
