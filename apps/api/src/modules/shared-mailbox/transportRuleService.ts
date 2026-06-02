// Transport Rules (Mail Flow Rules) côté Exchange Online — alternative au
// ForwardingSmtpAddress pour le dual delivery.
//
// Pourquoi : ForwardingSmtpAddress est bloqué par défaut par la politique
// anti-spam outbound de M365 (anti-phishing). Une transport rule "BlindCopyTo"
// est une règle admin, pas un forward user-level → non concernée par ce blocage.
//
// API utilisée : Exchange Online Admin REST (/adminapi/beta/{tid}/TransportRule),
// le même endpoint que celui déjà utilisé pour /Mailbox.

import { fetchWithTimeout } from '../migration/httpClient'
import { getAccessToken } from '../migration/service'

async function exchangeAdminToken(): Promise<string> {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('ONELA credentials manquantes')
  return getAccessToken(tid, cid, sec, 'https://outlook.office365.com/.default')
}

function adminBase(): string {
  const tid = process.env['ONELA_TENANT_ID']
  return `https://outlook.office365.com/adminapi/beta/${tid}`
}

/** Nom déterministe d'une règle pour une BAL donnée (idempotence). */
export function ruleNameFor(mailboxEmail: string): string {
  const safe = mailboxEmail.toLowerCase().replace(/[^a-z0-9]/g, '-')
  return `DSI-Shared-BCC-${safe}`
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

async function adminFetch(path: string, init?: Parameters<typeof fetchWithTimeout>[1]): Promise<Response> {
  const token = await exchangeAdminToken()
  return fetchWithTimeout(`${adminBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

/** Récupère une règle par nom. Renvoie null si absente. */
export async function getTransportRule(name: string): Promise<TransportRule | null> {
  const filter = encodeURIComponent(`Name eq '${name}'`)
  const res = await adminFetch(`/TransportRule?$filter=${filter}`)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Exchange Admin ${res.status} on list TransportRule: ${err}`)
  }
  const data = (await res.json()) as { value: TransportRule[] }
  return data.value[0] ?? null
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

  const body = {
    Name: name,
    Mode: 'Enforce' as const,
    State: 'Enabled' as const,
    SentTo: [params.targetMailbox],
    BlindCopyTo: [params.bccAddress],
    Description:
      params.description ??
      `Dual delivery DSI App : BCC ${params.bccAddress} pour la BAL partagée ${params.targetMailbox}`,
  }

  if (existing) {
    // Update via PATCH sur l'Identity
    const identity = encodeURIComponent(existing.Identity ?? name)
    const res = await adminFetch(`/TransportRule('${identity}')`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Exchange Admin ${res.status} on update TransportRule: ${err}`)
    }
    return { ...existing, ...body }
  }

  const res = await adminFetch('/TransportRule', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Exchange Admin ${res.status} on create TransportRule: ${err}`)
  }
  return res.json() as Promise<TransportRule>
}

/** Supprime la règle si elle existe. Idempotent. */
export async function deleteTransportRuleIfExists(targetMailbox: string): Promise<boolean> {
  const name = ruleNameFor(targetMailbox)
  const existing = await getTransportRule(name)
  if (!existing) return false
  const identity = encodeURIComponent(existing.Identity ?? name)
  const res = await adminFetch(`/TransportRule('${identity}')`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    const err = await res.text()
    throw new Error(`Exchange Admin ${res.status} on delete TransportRule: ${err}`)
  }
  return true
}
