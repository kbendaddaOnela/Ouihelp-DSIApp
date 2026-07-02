// Routage Exchange ONELA pour un nouvel arrivant.
//
// Contexte : pendant la migration, `onela.com` est un domaine AUTORITATIF sur
// Exchange Online (tenant ONELA). Tout mail entrant vers `prenom.nom@onela.com`
// frappe Exchange en premier ; sans objet destinataire, il BOUNCE (Exchange ne
// relaie pas vers Google tout seul).
//
// On crée donc un **MailUser (MEU)** :
//   - PrimarySmtpAddress / UPN = prenom.nom@onela.com   (accepté par l'org — l'entrant résout)
//   - ExternalEmailAddress (targetAddress) = prenom.nom@mig.onela.com  (redirige vers Google)
//
//   Résultat : mail vers prenom.nom@onela.com → résolu sur le MailUser → redirigé
//   vers mig.onela.com → Google. **Sans licence M365, sans mailbox.**
//
// Pourquoi PAS un MailContact : Exchange REFUSE d'attribuer une adresse d'un domaine
// AUTORITATIF (onela.com) à un MailContact — `Set-MailContact -PrimarySmtpAddress`
// se bloque et ne rend jamais la main (constaté en prod le 02/07/2026). Seul un objet
// interne mail-enabled (MailUser, mailbox, groupe) peut porter une adresse autoritative.
//
// Le MailUser crée une identité dans l'AAD ONELA. On lui pose un mot de passe
// aléatoire jamais communiqué (connexion de fait impossible). Il ne consomme PAS de
// licence et n'a PAS de mailbox.
//
// Permission requise sur l'app reg ONELA (déjà en place, cf. Khalid) :
//   Office 365 Exchange Online → Exchange.ManageAsApp + rôle "Recipient Management"
//   (ou "Exchange Administrator") sur le SPN.

import { randomBytes } from 'crypto'
import { fetchWithTimeout } from '../migration/httpClient'
import { getAccessToken } from '../migration/service'

/** Mot de passe fort et aléatoire pour le MailUser (jamais communiqué). */
function strongRandomPassword(): string {
  const raw = randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '')
  return `Rt${raw.slice(0, 20)}#Az9`
}

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
  const t0 = Date.now()
  console.log(`[routing] InvokeCommand ${cmdletName} → start`)
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
    timeoutMs: 45_000,
  })
  const text = await res.text()
  console.log(`[routing] InvokeCommand ${cmdletName} → ${res.status} en ${Date.now() - t0}ms`)
  if (!res.ok) {
    console.error(`[routing] ${cmdletName} corps erreur: ${text.slice(0, 800)}`)
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

/** Renvoie le MailUser (par UPN/adresse onela.com) s'il existe, sinon null. */
export async function getOnelaRouting(onelaAddress: string): Promise<RecipientLite | null> {
  try {
    const rows = await invokeCommand<RecipientLite>('Get-MailUser', { Identity: onelaAddress })
    return rows[0] ?? null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("couldn't be found") || msg.includes('ObjectNotFound') || msg.includes('ManagementObjectNotFound') || msg.includes('NotFound')) {
      return null
    }
    throw err
  }
}

/**
 * Crée (idempotent + auto-réparant) le MailUser de routage Exchange ONELA.
 *
 * MailUser (MEU) : UPN/primaire = onela.com (accepte l'entrant), ExternalEmailAddress
 * = mig.onela.com (redirige vers Google). Pas de licence, pas de mailbox. Mot de passe
 * aléatoire jamais communiqué.
 *
 * Rejouable sans risque : si un run précédent a été interrompu après `New-MailUser`,
 * ce passage retrouve le MailUser et ré-impose la cible externe (Set-MailUser).
 */
export async function ensureOnelaRouting(params: {
  displayName: string
  firstName: string
  lastName: string
  /** Adresse cible interne, ex. prenom.nom@onela.com (= UPN du MailUser) */
  onelaAddress: string
}): Promise<{ routingAddress: string; created: boolean }> {
  const routingAddress = buildRoutingAddress(params.onelaAddress)
  const alias = params.onelaAddress.split('@')[0] ?? params.onelaAddress

  const existing = await getOnelaRouting(params.onelaAddress)
  let created = false
  if (!existing) {
    try {
      await invokeCommand('New-MailUser', {
        Name: params.displayName,
        DisplayName: params.displayName,
        FirstName: params.firstName,
        LastName: params.lastName,
        Alias: alias,
        MicrosoftOnlineServicesID: params.onelaAddress, // UPN + primaire = onela.com
        Password: strongRandomPassword(),
        ExternalEmailAddress: routingAddress, // targetAddress → Google
      })
      created = true
    } catch (err) {
      // Création partielle antérieure (le MailUser existe déjà) → on continue vers Set.
      const msg = err instanceof Error ? err.message : String(err)
      if (!/already exists|is already in use|ADObjectAlreadyExists|already a recipient/i.test(msg)) throw err
    }
  }

  // Ré-impose la cible externe (idempotent, répare une création partielle).
  await invokeCommand('Set-MailUser', {
    Identity: params.onelaAddress,
    ExternalEmailAddress: routingAddress,
  })

  // Vérification : on relit le MailUser et on confirme que l'adresse onela.com est
  // bien portée par l'objet (elle l'est par construction via MicrosoftOnlineServicesID).
  const check = (await getOnelaRouting(params.onelaAddress)) as RecipientLite | null
  const addresses = Array.isArray(check?.EmailAddresses)
    ? check?.EmailAddresses
    : check?.EmailAddresses
      ? [check.EmailAddresses]
      : []
  const hasOnela =
    (check?.PrimarySmtpAddress ?? '').toLowerCase() === params.onelaAddress.toLowerCase() ||
    addresses.some((a) => a.toLowerCase().includes(params.onelaAddress.toLowerCase()))
  console.log(
    `[accounts] routing ${params.onelaAddress}: primary=${check?.PrimarySmtpAddress ?? '?'} external=${check?.ExternalEmailAddress ?? '?'} onelaStamped=${hasOnela} addresses=${JSON.stringify(addresses)}`,
  )
  if (!hasOnela) {
    throw new Error(
      `Le MailUser ${params.onelaAddress} n'a pas l'adresse onela.com attendue (primaire : ${check?.PrimarySmtpAddress ?? '?'}).`,
    )
  }

  return { routingAddress, created }
}

/** Supprime le MailUser de routage (rollback / suppression du suivi). Idempotent. */
export async function removeOnelaRouting(onelaAddress: string): Promise<boolean> {
  const existing = await getOnelaRouting(onelaAddress)
  if (!existing) return false
  await invokeCommand('Remove-MailUser', { Identity: onelaAddress, Confirm: false })
  return true
}
