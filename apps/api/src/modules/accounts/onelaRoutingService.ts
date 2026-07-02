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
  PrimarySmtpAddress?: string
  EmailAddresses?: string[] | string
  RecipientType?: string
}

// Identité stable du contact = son **alias** (`prenom.nom`). On NE l'identifie PAS
// par l'adresse onela.com : celle-ci peut ne pas encore être stampée (si une création
// partielle a été interrompue), et Get/Set-MailContact échouerait alors.
function contactAlias(onelaAddress: string): string {
  return onelaAddress.split('@')[0] ?? onelaAddress
}

/** Renvoie le MailContact par son alias s'il existe (idempotence), sinon null. */
export async function getOnelaRouting(onelaAddress: string): Promise<RecipientLite | null> {
  try {
    const rows = await invokeCommand<RecipientLite>('Get-MailContact', { Identity: contactAlias(onelaAddress) })
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
 * Crée (idempotent + auto-réparant) l'objet de routage Exchange ONELA.
 *
 * Peut être rejouée sans risque : si un run précédent a été interrompu (recyclage
 * du conteneur Azure) après `New-MailContact` mais avant le stamping des adresses,
 * ce second passage retrouve le contact par son alias et **impose l'état cible
 * final** (adresse primaire = onela.com, cible externe = mig.onela.com).
 *
 * On utilise `-PrimarySmtpAddress` (chaîne unique) plutôt que `-EmailAddresses`
 * (tableau) : plus fiable à passer via le pont JSON `InvokeCommand`.
 */
export async function ensureOnelaRouting(params: {
  displayName: string
  firstName: string
  lastName: string
  /** Adresse cible interne, ex. prenom.nom@onela.com */
  onelaAddress: string
}): Promise<{ routingAddress: string; created: boolean }> {
  const routingAddress = buildRoutingAddress(params.onelaAddress)
  const alias = contactAlias(params.onelaAddress)

  const existing = await getOnelaRouting(params.onelaAddress)
  let created = false
  if (!existing) {
    try {
      await invokeCommand('New-MailContact', {
        Name: params.displayName,
        DisplayName: params.displayName,
        FirstName: params.firstName,
        LastName: params.lastName,
        Alias: alias,
        ExternalEmailAddress: routingAddress,
      })
      created = true
    } catch (err) {
      // Création partielle antérieure (le contact existe déjà) → on continue vers Set.
      const msg = err instanceof Error ? err.message : String(err)
      if (!/already exists|is already in use|proxy address|ADObjectAlreadyExists/i.test(msg)) throw err
    }
  }

  // État cible final, imposé à chaque passage (idempotent, répare une création partielle) :
  //  - onela.com  = adresse primaire connue de l'org (accepte l'entrant)
  //  - mig.onela.com = ExternalEmailAddress (redirige vers Google)
  await invokeCommand('Set-MailContact', {
    Identity: alias,
    EmailAddressPolicyEnabled: false,
    ExternalEmailAddress: routingAddress,
    PrimarySmtpAddress: params.onelaAddress,
    HiddenFromAddressListsEnabled: false,
  })

  // Vérification : on relit le contact pour confirmer que l'adresse onela.com a bien
  // été acceptée comme primaire (Exchange peut refuser une adresse de domaine
  // autoritatif sur un MailContact → dans ce cas le routage entrant ne marchera pas).
  const check = (await getOnelaRouting(params.onelaAddress)) as RecipientLite | null
  const addresses = Array.isArray(check?.EmailAddresses)
    ? check?.EmailAddresses
    : check?.EmailAddresses
      ? [check.EmailAddresses]
      : []
  const hasOnela = addresses.some((a) => a.toLowerCase().includes(params.onelaAddress.toLowerCase()))
  console.log(
    `[accounts] routing ${params.onelaAddress}: primary=${check?.PrimarySmtpAddress ?? '?'} external=${check?.ExternalEmailAddress ?? '?'} onelaStamped=${hasOnela} addresses=${JSON.stringify(addresses)}`,
  )
  if (!hasOnela) {
    throw new Error(
      `L'adresse ${params.onelaAddress} n'a PAS été acceptée sur le MailContact (primaire actuel : ${check?.PrimarySmtpAddress ?? '?'}). ` +
        `Exchange refuse probablement une adresse du domaine autoritatif onela.com sur un contact → le routage entrant ne fonctionnera pas. ` +
        `Bascule nécessaire vers un MailUser (MEU).`,
    )
  }

  return { routingAddress, created }
}

/** Supprime l'objet de routage (rollback / suppression du suivi). Idempotent. */
export async function removeOnelaRouting(onelaAddress: string): Promise<boolean> {
  const alias = contactAlias(onelaAddress)
  const existing = await getOnelaRouting(onelaAddress)
  if (!existing) return false
  await invokeCommand('Remove-MailContact', { Identity: alias, Confirm: false })
  return true
}
