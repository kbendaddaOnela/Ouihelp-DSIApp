import type { migrations } from './schema'
import { agencyContactByCode, getAgencyContacts } from './onelaAgencyContacts'
import { getAgencyMembership } from './agencyMembership'
import { buildSignatureHtml, newFormatEmail, SIG_HQ } from './emailTemplates'

// ── Application de la signature Gmail ─────────────────────────────────────────
// Construit la signature (nom/poste/email via Graph + adresse/tél de l'agence via
// le CSV, siège = Montrouge sans tél), la pose sur le send-as prenom.nom@onela.com
// et en fait l'adresse par défaut. Trace signatureAppliedAt.
export async function agencyCodeByUpnMap(): Promise<Map<string, string>> {
  const { agencies } = await getAgencyMembership()
  const map = new Map<string, string>()
  for (const a of agencies) {
    for (const upn of a.upns) map.set(upn, a.code)
    for (const mail of a.mails) if (mail) map.set(mail.toLowerCase(), a.code)
  }
  return map
}

// Repli : déduire le code agence de l'attribut `department` (code « NOI » ou nom
// « Noisy-le-sec »), quand l'appartenance au groupe de sécurité ne l'a pas donné.
function normKey(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
}
function codeFromDepartment(dept: string | null | undefined): string | undefined {
  if (!dept) return undefined
  const key = normKey(dept)
  if (!key) return undefined
  for (const c of getAgencyContacts()) {
    if (normKey(c.code) === key || normKey(c.site) === key) return c.code
  }
  return undefined
}

export function signatureForUser(row: typeof migrations.$inferSelect, codeMap: Map<string, string>, base: string): { sendAs: string; html: string } {
  const agencyCode = codeMap.get(row.onelaUpn.toLowerCase())
    ?? codeMap.get(row.onelaEmail.toLowerCase())
    ?? codeFromDepartment(row.onelaDepartment)
  const contact = agencyCode ? agencyContactByCode().get(agencyCode.toUpperCase()) : undefined
  const loc = contact ?? SIG_HQ
  const sendAs = newFormatEmail(row.gohUpn!, row.onelaUpn)
  const html = buildSignatureHtml({
    name: row.onelaDisplayName,
    poste: row.onelaJobTitle ?? '',
    tel: loc.tel ?? '',
    adresse: 'adresse' in loc ? loc.adresse : '',
    cpVille: 'cpVille' in loc ? loc.cpVille : '',
    email: sendAs,
    base,
  })
  return { sendAs, html }
}
