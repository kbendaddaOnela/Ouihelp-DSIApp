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
