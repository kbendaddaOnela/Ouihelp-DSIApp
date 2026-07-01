// Routage Exchange ONELA pour un nouvel arrivant.
//
// Contexte : pendant la migration, `onela.com` est un domaine AUTORITATIF sur
// Exchange Online (tenant ONELA). Tout mail entrant vers `prenom.nom@onela.com`
// frappe Exchange en premier ; sans objet destinataire, il BOUNCE (Exchange ne
// relaie pas vers Google tout seul).
//
// Pour un nouvel arrivant qui est Google-native dès J1, on ne veut PAS de mailbox
// Exchange (ni licence M365, ni décommissionnement futur). On crée donc un objet
// de ROUTAGE léger :
//
//   → un **MailContact** dont :
//       - ExternalEmailAddress (targetAddress) = prenom.nom@mig.onela.com  (route vers Google)
//       - EmailAddresses (primaire) = SMTP:prenom.nom@onela.com            (accepté par Exchange)
//
//   Résultat : mail vers prenom.nom@onela.com → résolu sur le contact → redirigé
//   vers prenom.nom@mig.onela.com → Google. Zéro licence, zéro mailbox, zéro
//   compte AAD, rien à migrer/décommissionner ensuite.
//
// Alternative (non retenue) : un **MailUser**. En Exchange Online, New-MailUser
// impose -MicrosoftOnlineServicesID + -Password → crée un compte AAD login-capable
// dans le tenant ONELA. Plus lourd que le besoin (routage pur). Si les conventions
// du tenant l'exigent, remplacer New-MailContact/Set-MailContact ci-dessous par
// New-MailUser/Set-MailUser.
//
// Permission requise sur l'app reg ONELA (déjà en place, cf. Khalid) :
//   Office 365 Exchange Online → Exchange.ManageAsApp + rôle "Recipient Management"
//   (ou "Exchange Administrator") sur le SPN.

import { fetchWithTimeout } from '../migration/httpClient'
import { getAccessToken } from '../migration/service'

async function exchangeAdminToken(): Promise<string> {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('ONELA credentials manquantes')
  return getAccessToken(tid, cid, sec, 'https://outlook.office365.com/.default')
}

function invokeCommandUrl(): string {
  const tid = process.env['ONELA_TENANT_ID']
  return `https://outlook.office365.com/adminapi/beta/${tid}/InvokeCommand`
}

interface InvokeCommandResponse<T> {
  '@odata.context'?: string
  value?: T[]
}

async function invokeCommand<T = unknown>(cmdletName: string, parameters: Record<string, unknown>): Promise<T[]> {
  const token = await exchangeAdminToken()
  const res = await fetchWithTimeout(invokeCommandUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      CmdletInput: { CmdletName: cmdletName, Parameters: parameters },
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Exchange InvokeCommand ${res.status} on ${cmdletName}: ${text.slice(0, 600)}`)
  }
  const parsed = JSON.parse(text) as InvokeCommandResponse<T>
  return parsed.value ?? []
}

/**
 * Construit l'adresse de routage de transition (vers Google).
 * `prenom.nom@onela.com` → `prenom.nom@mig.onela.com`.
 * Override du préfixe via env `TRANSITION_DOMAIN_PREFIX` (défaut "mig") — aligné
 * avec le reste de l'app.
 */
export function buildRoutingAddress(onelaAddress: string): string {
  const parts = onelaAddress.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Adresse ONELA invalide pour le routage : ${onelaAddress}`)
  }
  const [local, domain] = parts
  const prefix = process.env['TRANSITION_DOMAIN_PREFIX'] ?? 'mig'
  return `${local}@${prefix}.${domain}`
}

interface RecipientLite {
  Name?: string
  Alias?: string
  ExternalEmailAddress?: string
  RecipientType?: string
}

/** Renvoie l'objet de routage s'il existe déjà (idempotence), sinon null. */
export async function getOnelaRouting(onelaAddress: string): Promise<RecipientLite | null> {
  try {
    const rows = await invokeCommand<RecipientLite>('Get-MailContact', { Identity: onelaAddress })
    return rows[0] ?? null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("couldn't be found") || msg.includes('ObjectNotFoundException') || msg.includes('ManagementObjectNotFound')) {
      return null
    }
    throw err
  }
}

/**
 * Crée (idempotent) l'objet de routage Exchange ONELA pour un nouvel arrivant.
 * Retourne l'adresse de routage utilisée (mig.onela.com).
 */
export async function ensureOnelaRouting(params: {
  displayName: string
  firstName: string
  lastName: string
  /** Adresse cible interne, ex. prenom.nom@onela.com */
  onelaAddress: string
}): Promise<{ routingAddress: string; created: boolean }> {
  const routingAddress = buildRoutingAddress(params.onelaAddress)
  const alias = params.onelaAddress.split('@')[0] ?? params.onelaAddress

  const existing = await getOnelaRouting(params.onelaAddress)
  if (existing) {
    // Déjà présent → on s'assure juste que la cible externe est la bonne.
    await invokeCommand('Set-MailContact', {
      Identity: params.onelaAddress,
      ExternalEmailAddress: routingAddress,
      EmailAddressPolicyEnabled: false,
    })
    return { routingAddress, created: false }
  }

  // Création : la cible (targetAddress) est mig.onela.com → Google.
  await invokeCommand('New-MailContact', {
    Name: params.displayName,
    DisplayName: params.displayName,
    FirstName: params.firstName,
    LastName: params.lastName,
    Alias: alias,
    ExternalEmailAddress: routingAddress,
  })

  // On stampe l'adresse onela.com comme adresse primaire connue de l'org (SMTP:
  // majuscule = primaire ; smtp: minuscule = proxy secondaire). Politique d'adresses
  // désactivée pour que ces valeurs ne soient pas écrasées.
  await invokeCommand('Set-MailContact', {
    Identity: params.onelaAddress,
    EmailAddressPolicyEnabled: false,
    EmailAddresses: [`SMTP:${params.onelaAddress}`, `smtp:${routingAddress}`],
    ExternalEmailAddress: routingAddress,
    HiddenFromAddressListsEnabled: false,
  })

  return { routingAddress, created: true }
}

/** Supprime l'objet de routage (rollback / suppression du suivi). Idempotent. */
export async function removeOnelaRouting(onelaAddress: string): Promise<boolean> {
  const existing = await getOnelaRouting(onelaAddress)
  if (!existing) return false
  await invokeCommand('Remove-MailContact', { Identity: onelaAddress, Confirm: false })
  return true
}
