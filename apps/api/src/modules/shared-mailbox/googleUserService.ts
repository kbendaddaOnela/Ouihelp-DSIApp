// Compte Google « boîte partagée » : création via Admin SDK Directory,
// et délégation Gmail via l'API Gmail (settings/delegates).
//
// Pourquoi une création DIRECTE dans Google (et pas via Entra GOH + SCIM comme
// le module accounts) : une BAL partagée n'a pas d'identité RH côté Entra, et
// l'attente de la synchro SCIM (5–40 min) n'apporte rien ici. Le compte est
// piloté uniquement par délégation, personne ne s'y connecte.
//
// Scopes DwD requis (Google Admin Console → Domain-wide delegation) :
//   - https://www.googleapis.com/auth/admin.directory.user      (créer/lire les users, alias)
//   - https://www.googleapis.com/auth/gmail.settings.sharing    (délégations + send-as)
//
// LICENCE : volontairement HORS de cette application. La licence Business Plus
// est attribuée par l'OU ou manuellement en console admin ; l'app se contente
// d'acquitter l'étape (cf. step_license). Tant qu'elle n'est pas posée, Gmail
// n'existe pas sur le compte et l'import mail échouerait.

import { randomBytes } from 'crypto'
import { fetchWithTimeout } from '../migration/httpClient'
import { getGoogleAccessTokenForUser } from '../migration/googleService'

const SCOPE_DIRECTORY_USER = 'https://www.googleapis.com/auth/admin.directory.user'
const SCOPE_GMAIL_SETTINGS_SHARING = 'https://www.googleapis.com/auth/gmail.settings.sharing'
/** Accès complet à la boîte — déjà autorisé en DwD pour l'import mail. */
const SCOPE_GMAIL_FULL = 'https://mail.google.com/'

function adminEmail(): string {
  const e = process.env['GOOGLE_ADMIN_EMAIL']
  if (!e) throw new Error('GOOGLE_ADMIN_EMAIL manquant')
  return e
}

async function directoryToken(): Promise<string> {
  return getGoogleAccessTokenForUser(adminEmail(), SCOPE_DIRECTORY_USER)
}

/** OU d'accueil des comptes « boîte partagée ». Par défaut la même que les users ONELA. */
export function sharedMailboxOuPath(): string {
  return (
    process.env['GOOGLE_SHARED_MAILBOX_OU_PATH'] ??
    process.env['GOOGLE_ONELA_OU_PATH'] ??
    '/onela.com'
  )
}

/** Mot de passe fort aléatoire : le compte n'est jamais utilisé en connexion directe. */
export function strongRandomPassword(): string {
  const raw = randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '')
  return `Sh${raw.slice(0, 20)}#Ml7`
}

export interface GoogleUser {
  id: string
  primaryEmail: string
  displayName: string
  suspended: boolean
  orgUnitPath: string
  /** false tant que la boîte Gmail n'est pas provisionnée (licence absente / création récente) */
  isMailboxSetup: boolean
  aliases: string[]
}

interface DirectoryUserPayload {
  id: string
  primaryEmail: string
  name?: { fullName?: string; givenName?: string; familyName?: string }
  suspended?: boolean
  orgUnitPath?: string
  isMailboxSetup?: boolean
  aliases?: string[]
}

function toGoogleUser(u: DirectoryUserPayload): GoogleUser {
  return {
    id: u.id,
    primaryEmail: u.primaryEmail,
    displayName: u.name?.fullName ?? u.primaryEmail,
    suspended: u.suspended ?? false,
    orgUnitPath: u.orgUnitPath ?? '/',
    isMailboxSetup: u.isMailboxSetup ?? false,
    aliases: u.aliases ?? [],
  }
}

/** Récupère un compte Google par adresse (primaire OU alias). null si absent. */
export async function getGoogleUser(email: string): Promise<GoogleUser | null> {
  const token = await directoryToken()
  const res = await fetchWithTimeout(
    `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}?projection=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Google get user error (${res.status}) sur ${email}: ${(await res.text()).slice(0, 300)}`)
  }
  return toGoogleUser((await res.json()) as DirectoryUserPayload)
}

export interface CreateSharedAccountParams {
  primaryEmail: string
  displayName: string
  password: string
  orgUnitPath?: string
}

/**
 * Crée le compte Google de la boîte partagée (idempotent : si l'adresse existe
 * déjà, on renvoie le compte existant sans le modifier).
 *
 * Le nom est éclaté en givenName/familyName car l'Admin SDK les exige tous les
 * deux ; pour une BAL le « prénom » est le nom du service et le « nom » un
 * marqueur explicite (« Boîte partagée ») qui rend l'objet identifiable dans
 * l'annuaire Google.
 */
export async function ensureSharedGoogleAccount(
  p: CreateSharedAccountParams,
): Promise<{ user: GoogleUser; created: boolean }> {
  const existing = await getGoogleUser(p.primaryEmail)
  if (existing) return { user: existing, created: false }

  const token = await directoryToken()
  const res = await fetchWithTimeout('https://admin.googleapis.com/admin/directory/v1/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      primaryEmail: p.primaryEmail,
      name: { givenName: p.displayName, familyName: 'Boîte partagée' },
      password: p.password,
      changePasswordAtNextLogin: false,
      orgUnitPath: p.orgUnitPath ?? sharedMailboxOuPath(),
      includeInGlobalAddressList: true,
    }),
  })
  if (!res.ok) {
    const err = (await res.text()).slice(0, 400)
    if (res.status === 409) {
      // Course : créé entre le get et le post
      const again = await getGoogleUser(p.primaryEmail)
      if (again) return { user: again, created: false }
    }
    throw new Error(`Google create user error (${res.status}) sur ${p.primaryEmail}: ${err}`)
  }
  return { user: toGoogleUser((await res.json()) as DirectoryUserPayload), created: true }
}

/**
 * Attend que la boîte Gmail du compte soit provisionnée.
 * Sans licence Gmail (ou juste après la création), `isMailboxSetup` reste false
 * et l'import/la délégation échouent avec des erreurs peu lisibles.
 */
export async function waitForMailboxSetup(
  email: string,
  attempts = 10,
  delayMs = 6000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const u = await getGoogleUser(email)
    if (u?.isMailboxSetup) return true
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs))
  }
  return false
}

/** Recherche dans l'annuaire Google (pour choisir un délégué à la main). */
export async function searchGoogleUsers(query: string, maxResults = 20): Promise<GoogleUser[]> {
  const token = await directoryToken()
  const url = new URL('https://admin.googleapis.com/admin/directory/v1/users')
  url.searchParams.set('customer', 'my_customer')
  url.searchParams.set('maxResults', String(maxResults))
  url.searchParams.set('projection', 'basic')
  url.searchParams.set('orderBy', 'email')
  // L'Admin SDK ne fait pas de « contains » : `email:x*` / `name:x*` sont des
  // préfixes. On interroge les deux et on fusionne pour couvrir « dupont » comme
  // « nathalie ».
  const queries = [`email:${query}*`, `name:${query}*`]
  const byId = new Map<string, GoogleUser>()
  for (const q of queries) {
    url.searchParams.set('query', q)
    const res = await fetchWithTimeout(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      // Une des deux requêtes peut échouer (syntaxe refusée) — on ne bloque pas l'autre
      console.warn(`[shared-account] searchGoogleUsers "${q}" → ${res.status}`)
      continue
    }
    const data = (await res.json()) as { users?: DirectoryUserPayload[] }
    for (const u of data.users ?? []) byId.set(u.id, toGoogleUser(u))
  }
  return [...byId.values()].slice(0, maxResults)
}

// ── Délégation Gmail ─────────────────────────────────────────────────────────

interface GmailDelegate {
  delegateEmail: string
  verificationStatus?: 'accepted' | 'pending' | 'rejected' | 'expired'
}

/**
 * Scopes acceptables pour `settings/delegates`, dans l'ordre d'essai.
 *
 * Google documente `gmail.settings.sharing` pour ces endpoints, mais renvoie
 * selon les tenants un 403 « insufficient authentication scopes » avec ce
 * scope seul — constaté en prod le 02/09/2026 sur dsi@mig.onela.com, alors que
 * le même scope fonctionnait pour `settings/sendAs` sur la MÊME boîte.
 * `https://mail.google.com/` (accès complet, déjà autorisé pour l'import mail)
 * couvre les paramètres, donc on l'essaie en repli plutôt que de bloquer.
 *
 * Le scope qui passe est mémorisé pour ne pas repayer un aller-retour raté à
 * chaque délégué.
 */
const DELEGATE_SCOPES = [SCOPE_GMAIL_SETTINGS_SHARING, SCOPE_GMAIL_FULL] as const
let workingDelegateScope: string | null = null

/** Vrai si la réponse est un refus de scope (et non un vrai refus de droit). */
function isScopeRejection(status: number, body: string): boolean {
  if (status !== 403 && status !== 401) return false
  return /insufficient (authentication scopes|permission)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body)
}

interface DelegateResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * Appelle `settings/delegates` en impersonnant la BOÎTE cible (la délégation se
 * pose depuis le compte délégant), en essayant les scopes jusqu'à ce que l'un
 * soit accepté.
 */
async function gmailDelegateFetch(
  mailboxEmail: string,
  path: string,
  init?: Parameters<typeof fetchWithTimeout>[1],
): Promise<DelegateResponse> {
  const ordered = workingDelegateScope
    ? [workingDelegateScope, ...DELEGATE_SCOPES.filter((s) => s !== workingDelegateScope)]
    : [...DELEGATE_SCOPES]

  const rejections: string[] = []
  for (const scope of ordered) {
    let token: string
    try {
      token = await getGoogleAccessTokenForUser(mailboxEmail, scope)
    } catch (err) {
      // unauthorized_client = scope absent de la delegation domain-wide
      rejections.push(`${scope} → ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const res = await fetchWithTimeout(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(mailboxEmail)}/settings/delegates${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(init?.headers ?? {}),
        },
      },
    )
    const body = await res.text()
    if (isScopeRejection(res.status, body)) {
      rejections.push(`${scope} → ${res.status} ${body.slice(0, 200)}`)
      continue
    }
    if (workingDelegateScope !== scope) {
      workingDelegateScope = scope
      console.log(`[shared-account] délégations Gmail : scope retenu = ${scope}`)
    }
    return { status: res.status, ok: res.ok, body }
  }

  throw new Error(
    `Aucun scope accepté pour les délégations Gmail sur ${mailboxEmail}. ` +
      `Autorise l'un de ces scopes pour le service account dans Google Admin Console → ` +
      `Sécurité → Contrôles des API → Délégation à l'échelle du domaine : ` +
      `${DELEGATE_SCOPES.join(' ou ')}. Détail des refus : ${rejections.join(' | ')}`,
  )
}

export async function listGmailDelegates(mailboxEmail: string): Promise<GmailDelegate[]> {
  const res = await gmailDelegateFetch(mailboxEmail, '')
  if (!res.ok) {
    throw new Error(`List delegates error (${res.status}) sur ${mailboxEmail}: ${res.body.slice(0, 300)}`)
  }
  if (!res.body.trim()) return []
  const data = JSON.parse(res.body) as { delegates?: GmailDelegate[] }
  return data.delegates ?? []
}

/**
 * Ajoute une délégation Gmail (idempotent).
 *
 * `delegateEmail` DOIT être l'adresse PRIMAIRE du compte Google du délégué
 * (prenom.nom@mig.onela.com), pas son adresse Exchange (pnom@onela.com) ni son
 * alias : Google résout la délégation sur le compte primaire et rejette les
 * adresses inconnues avec un 400 peu explicite.
 */
export async function ensureGmailDelegate(
  mailboxEmail: string,
  delegateEmail: string,
): Promise<{ created: boolean; verificationStatus?: string }> {
  const existing = await listGmailDelegates(mailboxEmail)
  const found = existing.find((d) => d.delegateEmail.toLowerCase() === delegateEmail.toLowerCase())
  if (found) return { created: false, verificationStatus: found.verificationStatus }

  const res = await gmailDelegateFetch(mailboxEmail, '', {
    method: 'POST',
    body: JSON.stringify({ delegateEmail }),
  })
  if (!res.ok) {
    const mailboxDomain = mailboxEmail.split('@')[1] ?? ''
    const delegateDomain = delegateEmail.split('@')[1] ?? ''
    const crossDomainHint =
      mailboxDomain !== delegateDomain
        ? ` — le délégué est sur un autre domaine (${delegateDomain}) que la boîte (${mailboxDomain}) :` +
          ` la délégation inter-domaines doit être autorisée dans la console Google.`
        : ''
    throw new Error(
      `Ajout délégation ${delegateEmail} sur ${mailboxEmail} : ${res.status} ${res.body.slice(0, 400)}${crossDomainHint}`,
    )
  }
  const data = JSON.parse(res.body) as GmailDelegate
  return { created: true, verificationStatus: data.verificationStatus }
}

export async function removeGmailDelegate(mailboxEmail: string, delegateEmail: string): Promise<void> {
  const res = await gmailDelegateFetch(mailboxEmail, `/${encodeURIComponent(delegateEmail)}`, {
    method: 'DELETE',
  })
  // 404 = déjà absent → idempotent
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Suppression délégation ${delegateEmail} sur ${mailboxEmail} : ${res.status} ${res.body.slice(0, 300)}`,
    )
  }
}
