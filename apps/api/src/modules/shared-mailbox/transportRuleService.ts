// Transport Rules (Mail Flow Rules) via Exchange Online REST — endpoint moderne
// `InvokeCommand` qui exécute des cmdlets PowerShell via API REST.
//
// Pourquoi pas /adminapi/beta/.../TransportRule ? Cet ancien endpoint OData n'expose
// qu'un sous-ensemble de cmdlets (Mailbox, Recipient...). TransportRule n'y est pas.
// InvokeCommand permet d'appeler N'IMPORTE QUEL cmdlet Exchange (New-TransportRule,
// Get-TransportRule, Set-TransportRule, Remove-TransportRule) en mode App-only.
//
// Permission requise sur l'app reg ONELA (à vérifier si on récupère du 403) :
// - Office 365 Exchange Online → Exchange.ManageAsApp (Application)
// - + un rôle Entra ID sur le SPN : "Exchange Administrator" (ou "Compliance Administrator"
//   selon le scope cmdlet utilisé).

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

/** Nom déterministe d'une règle pour une BAL donnée (idempotence). */
export function ruleNameFor(mailboxEmail: string): string {
  const safe = mailboxEmail.toLowerCase().replace(/[^a-z0-9]/g, '-')
  return `DSI-Shared-BCC-${safe}`
}

/**
 * Construit l'adresse de routage Google Workspace pour le dual delivery
 * vers un groupe ayant la MÊME adresse que la BAL Exchange (ex : `dsi@onela.com`
 * sur Exchange ET sur Google Workspace).
 *
 * Pattern documenté par Google : `<localpart>@<domain>.test-google-a.com`
 * → Google route automatiquement vers le compte/groupe ayant l'adresse
 *   `<localpart>@<domain>` dans le tenant.
 *
 * Avantages :
 *  - Pas de boucle (l'adresse de routage est différente de la cible)
 *  - Pas de connecteur Exchange à créer (DNS public route vers Google)
 *  - Marche dès qu'on a vérifié le domaine côté Google Workspace
 */
export function buildGoogleRoutingAddress(targetEmail: string): string {
  const parts = targetEmail.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Adresse cible invalide pour le routage Google : ${targetEmail}`)
  }
  const [local, domain] = parts
  return `${local}@${domain}.test-google-a.com`
}

export interface TransportRule {
  Name: string
  Identity?: string
  State?: 'Enabled' | 'Disabled'
  Mode?: 'Audit' | 'AuditAndNotify' | 'Enforce'
  SentTo?: string[]
  BlindCopyTo?: string[]
  Description?: string
}

interface InvokeCommandResponse<T> {
  '@odata.context'?: string
  value: T[]
}

/**
 * Exécute un cmdlet Exchange via REST. Lève une erreur si le cmdlet renvoie
 * un message d'erreur dans la réponse.
 */
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
  const parsed = JSON.parse(text) as InvokeCommandResponse<T> & { value?: T[] }
  return parsed.value ?? []
}

/** Récupère une règle par nom. Renvoie null si absente. */
export async function getTransportRule(name: string): Promise<TransportRule | null> {
  try {
    const rows = await invokeCommand<TransportRule>('Get-TransportRule', { Identity: name })
    return rows[0] ?? null
  } catch (err) {
    // Get-TransportRule renvoie "The operation couldn't be performed because object ... couldn't be found"
    // quand la règle n'existe pas → on traite comme absent (null).
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("couldn't be found") || msg.includes('ObjectNotFoundException')) return null
    throw err
  }
}

/**
 * Crée (ou met à jour si déjà existante) une règle qui met en BCC
 * `bccAddress` chaque message reçu par `targetMailbox`.
 */
export async function ensureBccTransportRule(params: {
  targetMailbox: string
  bccAddress: string
  description?: string
}): Promise<TransportRule> {
  const name = ruleNameFor(params.targetMailbox)
  const existing = await getTransportRule(name)

  const commonParams: { SentTo: string[]; BlindCopyTo: string[]; Mode: 'Enforce' } = {
    SentTo: [params.targetMailbox],
    BlindCopyTo: [params.bccAddress],
    Mode: 'Enforce',
  }

  if (existing) {
    await invokeCommand('Set-TransportRule', {
      Identity: existing.Identity ?? name,
      ...commonParams,
    })
    // Re-fetch pour avoir l'état à jour
    const fresh = await getTransportRule(name)
    return fresh ?? { Name: name, ...commonParams, State: 'Enabled' }
  }

  await invokeCommand('New-TransportRule', {
    Name: name,
    ...commonParams,
    Comments:
      params.description ??
      `Dual delivery DSI App : BCC ${params.bccAddress} pour la BAL partagée ${params.targetMailbox}`,
  })
  const fresh = await getTransportRule(name)
  return fresh ?? { Name: name, ...commonParams, State: 'Enabled' }
}

/** Supprime la règle si elle existe. Idempotent. */
export async function deleteTransportRuleIfExists(targetMailbox: string): Promise<boolean> {
  const name = ruleNameFor(targetMailbox)
  const existing = await getTransportRule(name)
  if (!existing) return false
  await invokeCommand('Remove-TransportRule', {
    Identity: existing.Identity ?? name,
    Confirm: false,
  })
  return true
}
