// Service annuaire ONELA : parsing CSV + push dans les contacts Google (People API)
import { getGoogleAccessTokenForUser } from '../migration/googleService'
import { fetchWithTimeout } from '../migration/httpClient'

const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts'
const ONELA_GROUP_NAME = 'ONELA'

export interface ParsedContact {
  givenName: string | null
  familyName: string | null
  organization: string | null
  title: string | null
  email: string
  phone: string | null
}

// ── Parsing CSV ───────────────────────────────────────────────────────────────

// Comptes purement techniques / de test à exclure de l'annuaire poussé aux users.
// (décision opérateur juin 2026 : on ne veut que de vrais contacts utiles)
const EXCLUDE_LOCALPARTS = new Set([
  'noreply', 'smtp-goanywhere', 'smtp-vm1', 'dwh_onela', 'automate_mft',
  'topdesk-noreply', 'site_onelacom', 'imprimante', 'otest', 'pmartin2',
  'jdupaquier',
])
const EXCLUDE_TITLE_PATTERNS = ['compte de test', 'compte de service']

function shouldExclude(localPart: string, title: string | null): boolean {
  if (EXCLUDE_LOCALPARTS.has(localPart.toLowerCase())) return true
  const t = (title ?? '').toLowerCase()
  return EXCLUDE_TITLE_PATTERNS.some((p) => t.includes(p))
}

// Normalise un téléphone FR ("01 41 53 09 29") → format international ("+33141530929").
function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^\d+]/g, '')
  if (!digits) return null
  if (digits.startsWith('+')) return digits
  // Numéro national à 10 chiffres commençant par 0 → +33 + reste
  if (/^0\d{9}$/.test(digits)) return `+33${digits.slice(1)}`
  return digits
}

/**
 * Parse le CSV ONELA (séparateur `;`). Colonnes attendues (par position) :
 * Given Name ; Family Name ; Organization Name ; Organization Title ; E-mail ; Phone
 * Tolère la coquille d'en-tête "Organization TitleTitle".
 * Exclut les comptes techniques et dédoublonne par email.
 */
export function parseOnelaCsv(csv: string): { contacts: ParsedContact[]; excluded: number; malformed: number } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { contacts: [], excluded: 0, malformed: 0 }

  // Détecter et sauter la ligne d'en-tête (contient "e-mail" ou "given name")
  const first = lines[0]!.toLowerCase()
  const startIdx = first.includes('e-mail') || first.includes('given name') ? 1 : 0

  const byEmail = new Map<string, ParsedContact>()
  let excluded = 0
  let malformed = 0

  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i]!.split(';')
    const email = (cols[4] ?? '').trim()
    if (!email.includes('@')) { malformed++; continue }

    const localPart = email.split('@')[0] ?? ''
    const title = (cols[3] ?? '').trim() || null

    if (shouldExclude(localPart, title)) { excluded++; continue }

    const contact: ParsedContact = {
      givenName: (cols[0] ?? '').trim() || null,
      familyName: (cols[1] ?? '').trim() || null,
      organization: (cols[2] ?? '').trim() || 'ONELA',
      title,
      email: email.toLowerCase(),
      phone: normalizePhone(cols[5]),
    }
    // Dédoublonnage par email (dernière occurrence gagne)
    byEmail.set(contact.email, contact)
  }

  return { contacts: [...byEmail.values()], excluded, malformed }
}

// ── Push People API ───────────────────────────────────────────────────────────

interface GooglePerson {
  resourceName?: string
  emailAddresses?: Array<{ value?: string }>
}

/** Récupère (ou crée) le groupe de contacts "ONELA" dans le compte du user. */
async function ensureOnelaGroup(userEmail: string, token: string): Promise<string> {
  // Lister les groupes existants
  const listRes = await fetchWithTimeout(
    'https://people.googleapis.com/v1/contactGroups?pageSize=200',
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (listRes.ok) {
    const data = (await listRes.json()) as { contactGroups?: Array<{ resourceName: string; name: string; formattedName?: string }> }
    const existing = data.contactGroups?.find(
      (g) => g.name === ONELA_GROUP_NAME || g.formattedName === ONELA_GROUP_NAME
    )
    if (existing) return existing.resourceName
  }

  // Créer le groupe
  const createRes = await fetchWithTimeout(
    'https://people.googleapis.com/v1/contactGroups',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactGroup: { name: ONELA_GROUP_NAME } }),
    }
  )
  if (!createRes.ok) {
    throw new Error(`Création groupe ONELA échouée (${createRes.status}): ${(await createRes.text()).slice(0, 300)}`)
  }
  const created = (await createRes.json()) as { resourceName: string }
  return created.resourceName
}

/** Liste tous les emails déjà présents dans les contacts du user (pour idempotence). */
async function listExistingEmails(userEmail: string, token: string): Promise<Set<string>> {
  const emails = new Set<string>()
  let pageToken: string | undefined
  do {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections')
    url.searchParams.set('personFields', 'emailAddresses')
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetchWithTimeout(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      // En cas d'échec de listing, on retourne ce qu'on a (le push créera peut-être des doublons,
      // mais mieux vaut ça que de tout bloquer). Log pour diagnostic.
      console.warn(`[onela-contacts] list connections ${res.status} pour ${userEmail}`)
      break
    }
    const data = (await res.json()) as { connections?: GooglePerson[]; nextPageToken?: string }
    for (const p of data.connections ?? []) {
      for (const e of p.emailAddresses ?? []) {
        if (e.value) emails.add(e.value.toLowerCase())
      }
    }
    pageToken = data.nextPageToken
  } while (pageToken)
  return emails
}

function buildPerson(c: ParsedContact, groupResourceName: string) {
  const person: Record<string, unknown> = {
    emailAddresses: [{ value: c.email }],
    memberships: [{ contactGroupMembership: { contactGroupResourceName: groupResourceName } }],
  }
  if (c.givenName || c.familyName) {
    person['names'] = [{ givenName: c.givenName ?? undefined, familyName: c.familyName ?? undefined }]
  }
  if (c.phone) person['phoneNumbers'] = [{ value: c.phone }]
  if (c.organization || c.title) {
    person['organizations'] = [{ name: c.organization ?? undefined, title: c.title ?? undefined }]
  }
  return person
}

/**
 * Pousse l'annuaire ONELA dans les contacts Google du user (impersonation).
 * - Crée/récupère le groupe "ONELA"
 * - Skippe les contacts dont l'email existe déjà chez le user (idempotent)
 * - Crée le reste par batch de 200 (people:batchCreateContacts)
 */
export async function pushContactsToUser(
  userEmail: string,
  contacts: ParsedContact[],
  onProgress?: (created: number, total: number) => Promise<void>
): Promise<{ created: number; skipped: number; total: number; errors: number }> {
  const token = await getGoogleAccessTokenForUser(userEmail, CONTACTS_SCOPE)
  const groupResourceName = await ensureOnelaGroup(userEmail, token)
  const existing = await listExistingEmails(userEmail, token)

  // Ne pas se pousser soi-même, et skipper ceux déjà présents
  const toCreate = contacts.filter((c) => c.email !== userEmail.toLowerCase() && !existing.has(c.email))
  const skipped = contacts.length - toCreate.length

  let created = 0
  let errors = 0
  const BATCH = 200

  for (let i = 0; i < toCreate.length; i += BATCH) {
    const slice = toCreate.slice(i, i + BATCH)
    // Token rafraîchi par chunk au cas où le push dure longtemps
    const chunkToken = await getGoogleAccessTokenForUser(userEmail, CONTACTS_SCOPE)
    const body = {
      contacts: slice.map((c) => ({ contactPerson: buildPerson(c, groupResourceName) })),
      readMask: 'names,emailAddresses',
    }
    const res = await fetchWithTimeout(
      'https://people.googleapis.com/v1/people:batchCreateContacts',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${chunkToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
    if (res.ok) {
      created += slice.length
    } else {
      errors += slice.length
      console.warn(`[onela-contacts] batchCreate ${res.status} pour ${userEmail}: ${(await res.text()).slice(0, 200)}`)
    }
    if (onProgress) await onProgress(created, toCreate.length)
    // Petite tempo pour ne pas saturer People API
    if (i + BATCH < toCreate.length) await new Promise((r) => setTimeout(r, 500))
  }

  return { created, skipped, total: contacts.length, errors }
}
