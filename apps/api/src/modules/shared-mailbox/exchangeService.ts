// Recherche de boîtes aux lettres PARTAGÉES Exchange (RecipientTypeDetails = SharedMailbox).
// Les boîtes partagées n'ont ni licence ni mot de passe ; on les détecte via l'API
// Exchange Admin (la même que celle utilisée pour ForwardingSmtpAddress).
//
// Pour lire le contenu (messages, dossiers), on réutilise les helpers Graph App-only
// du module migration (iterateOnelaMessages, fetchOnelaMessageMime, listOnelaFolders).
// L'app a déjà la permission Mail.ReadWrite tenant-wide → marche sur les BAL partagées.

import { fetchWithTimeout } from '../migration/httpClient'
import { getAccessToken } from '../migration/service'

interface ExchangeMailbox {
  Identity: string
  PrimarySmtpAddress: string
  DisplayName: string
  RecipientTypeDetails: string
  ExternalDirectoryObjectId: string | null
}

async function exchangeAdminToken(): Promise<string> {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('ONELA credentials manquantes')
  return getAccessToken(tid, cid, sec, 'https://outlook.office365.com/.default')
}

/** Liste les boîtes partagées, filtrées optionnellement par sous-chaîne (nom ou email). */
export async function listSharedMailboxes(query?: string): Promise<
  Array<{ id: string; upn: string; email: string; displayName: string }>
> {
  const token = await exchangeAdminToken()
  const tid = process.env['ONELA_TENANT_ID']
  const params = new URLSearchParams({
    $filter: "RecipientTypeDetails eq 'SharedMailbox'",
    $select: 'Identity,PrimarySmtpAddress,DisplayName,RecipientTypeDetails,ExternalDirectoryObjectId',
    $top: '200',
  })
  const url = `https://outlook.office365.com/adminapi/beta/${tid}/Mailbox?${params.toString()}`
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Exchange Admin ${res.status} on list shared mailboxes: ${err}`)
  }
  const data = (await res.json()) as { value: ExchangeMailbox[] }
  let mailboxes = data.value.map((m) => ({
    id: m.ExternalDirectoryObjectId ?? m.Identity,
    upn: m.PrimarySmtpAddress,
    email: m.PrimarySmtpAddress,
    displayName: m.DisplayName,
  }))

  if (query && query.trim().length > 0) {
    const q = query.trim().toLowerCase()
    mailboxes = mailboxes.filter(
      (m) => m.email.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
    )
  }
  return mailboxes
}

// ── Permissions FullAccess sur une BAL partagée ──────────────────────────────
// Sert à pré-remplir la liste des délégués Gmail : les personnes qui ouvraient
// déjà la BAL dans Outlook sont celles qui doivent la retrouver dans Gmail.
//
// Get-MailboxPermission n'existe pas sur l'endpoint OData /Mailbox ; on passe par
// InvokeCommand (même mécanisme que transportRuleService).

interface MailboxPermissionEntry {
  Identity?: string
  User?: string
  AccessRights?: string[] | string
  IsInherited?: boolean
  Deny?: boolean
}

/** Comptes système à ignorer dans les permissions Exchange. */
function isSystemPrincipal(user: string): boolean {
  const u = user.toLowerCase()
  return (
    u.includes('nt authority\\self') ||
    u.includes('s-1-5-21') || // SID orphelin (compte supprimé)
    u.includes('domain admins') ||
    u.includes('enterprise admins') ||
    u.includes('organization management') ||
    u.includes('exchange servers') ||
    u.includes('administrator') ||
    !u.includes('@') // on ne garde que les principaux résolus en UPN
  )
}

/**
 * Liste les UPN Exchange ayant FullAccess sur la boîte partagée.
 * Les permissions héritées et les refus (Deny) sont exclus.
 */
export async function listMailboxFullAccessUsers(mailboxIdentity: string): Promise<string[]> {
  const token = await exchangeAdminToken()
  const tid = process.env['ONELA_TENANT_ID']
  const res = await fetchWithTimeout(`https://outlook.office365.com/adminapi/beta/${tid}/InvokeCommand`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      CmdletInput: { CmdletName: 'Get-MailboxPermission', Parameters: { Identity: mailboxIdentity } },
    }),
    timeoutMs: 45_000,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Exchange Get-MailboxPermission ${res.status} sur ${mailboxIdentity}: ${text.slice(0, 400)}`)
  }
  const parsed = JSON.parse(text) as { value?: MailboxPermissionEntry[] }
  const seen = new Set<string>()
  for (const e of parsed.value ?? []) {
    if (!e.User || e.Deny || e.IsInherited) continue
    const rights = Array.isArray(e.AccessRights) ? e.AccessRights : e.AccessRights ? [e.AccessRights] : []
    if (!rights.some((r) => String(r).toLowerCase().includes('fullaccess'))) continue
    if (isSystemPrincipal(e.User)) continue
    seen.add(e.User.toLowerCase())
  }
  return [...seen]
}
