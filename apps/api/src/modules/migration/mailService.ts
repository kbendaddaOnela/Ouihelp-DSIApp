// Migration mail Exchange → Gmail :
// - Lecture via Microsoft Graph (App-only, Mail.ReadWrite)
// - Écriture via Gmail API (impersonation user, scope mail.google.com)

import { getGoogleAccessTokenForUser } from './googleService'

const GMAIL_SCOPE = 'https://mail.google.com/'

// ── Microsoft Graph (lecture mail ONELA) ──────────────────────────────────────

async function onelaToken(): Promise<string> {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('ONELA Graph credentials manquantes')

  const res = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cid,
      client_secret: sec,
      scope: 'https://graph.microsoft.com/.default',
    }),
  })
  if (!res.ok) throw new Error(`ONELA token error (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

interface GraphFolder {
  id: string
  displayName: string
  wellKnownName?: string
}

interface GraphMessageMeta {
  id: string
  internetMessageId?: string
  parentFolderId?: string
  isRead?: boolean
  isDraft?: boolean
  categories?: string[]
  subject?: string
  receivedDateTime?: string
}

// Liste les folders en utilisant les alias well-known (pour identifier inbox/sent/...) +
// l'API /v1.0 standard pour les folders custom. wellKnownName n'est pas exposé sur /v1.0.
const WELL_KNOWN_ALIASES = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'archive'] as const

export async function listOnelaFolders(userId: string): Promise<GraphFolder[]> {
  const token = await onelaToken()
  const folderById = new Map<string, GraphFolder>()

  // 1. Récupérer les folders well-known via leur alias pour récupérer leur ID réel
  for (const alias of WELL_KNOWN_ALIASES) {
    try {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${alias}?$select=id,displayName`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (res.ok) {
        const f = (await res.json()) as { id: string; displayName: string }
        folderById.set(f.id, { id: f.id, displayName: f.displayName, wellKnownName: alias })
      }
    } catch { /* alias absent (ex: Archive non créée) — on ignore */ }
  }

  // 2. Lister tous les folders du user (sans wellKnownName)
  let url: string | null =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders?$top=100&$select=id,displayName`
  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Graph folders error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { value: GraphFolder[]; '@odata.nextLink'?: string }
    for (const f of data.value) {
      if (!folderById.has(f.id)) folderById.set(f.id, { id: f.id, displayName: f.displayName })
    }
    url = data['@odata.nextLink'] ?? null
  }

  // 3. Lister récursivement les sous-folders (1 niveau de profondeur suffit pour la v1)
  const topFolders = [...folderById.values()]
  for (const parent of topFolders) {
    let childUrl: string | null =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${parent.id}/childFolders?$top=100&$select=id,displayName`
    while (childUrl) {
      try {
        const res: Response = await fetch(childUrl, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) break
        const data = (await res.json()) as { value: GraphFolder[]; '@odata.nextLink'?: string }
        for (const f of data.value) {
          if (!folderById.has(f.id)) folderById.set(f.id, { id: f.id, displayName: f.displayName })
        }
        childUrl = data['@odata.nextLink'] ?? null
      } catch { break }
    }
  }

  return [...folderById.values()]
}

// Compte le nombre de messages avant l'itération pour afficher le total dès le début
export async function countOnelaMessages(userId: string, since?: Date | null): Promise<number> {
  const token = await onelaToken()
  const filter = since ? `&$filter=receivedDateTime gt ${since.toISOString()}` : ''
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/messages?$count=true&$top=1${filter}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
  })
  if (!res.ok) throw new Error(`Graph count error (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { '@odata.count'?: number }
  return data['@odata.count'] ?? 0
}

export async function* iterateOnelaMessages(
  userId: string,
  since?: Date | null
): AsyncGenerator<GraphMessageMeta> {
  const token = await onelaToken()
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/messages?$top=100&$select=id,internetMessageId,parentFolderId,isRead,isDraft,categories,subject,receivedDateTime`
  // Delta sync : on filtre sur receivedDateTime > since (les mails ne changent pas après réception)
  const filter = since ? `&$filter=receivedDateTime gt ${since.toISOString()}` : ''
  let url: string | null = base + filter
  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Graph messages error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { value: GraphMessageMeta[]; '@odata.nextLink'?: string }
    for (const msg of data.value) yield msg
    url = data['@odata.nextLink'] ?? null
  }
}

// Récupère le MIME brut RFC 822 d'un message — beaucoup plus simple que reconstruire depuis le JSON
// Retry sur 429/503/504 (transitoires côté Graph) avec backoff exponentiel
export async function fetchOnelaMessageMime(userId: string, messageId: string): Promise<string> {
  const RETRYABLE = new Set([429, 503, 504])
  const MAX_ATTEMPTS = 4
  let delay = 2000

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await onelaToken()
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/$value`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (res.ok) return await res.text()

    const body = await res.text()
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(`Graph $value error (${res.status}): ${body}`)
    }
    console.warn(`[mail] $value ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${delay / 1000}s`)
    await new Promise((r) => setTimeout(r, delay))
    delay *= 2
  }
  throw new Error('fetchOnelaMessageMime: unreachable')
}

// ── Gmail (écriture côté GOH) ─────────────────────────────────────────────────

interface GmailLabel {
  id: string
  name: string
  type?: string
}

export async function listGmailLabels(userEmail: string): Promise<GmailLabel[]> {
  const token = await getGoogleAccessTokenForUser(userEmail, GMAIL_SCOPE)
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/labels`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`Gmail labels error (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { labels: GmailLabel[] }
  return data.labels
}

export async function createGmailLabel(userEmail: string, name: string): Promise<GmailLabel> {
  const token = await getGoogleAccessTokenForUser(userEmail, GMAIL_SCOPE)
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/labels`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    }
  )
  if (!res.ok) throw new Error(`Gmail create label error (${res.status}): ${await res.text()}`)
  return (await res.json()) as GmailLabel
}

// Map nom de dossier Outlook (wellKnownName) → label système Gmail
const SYSTEM_LABEL_MAP: Record<string, string> = {
  inbox: 'INBOX',
  sentitems: 'SENT',
  drafts: 'DRAFT',
  deleteditems: 'TRASH',
  junkemail: 'SPAM',
  archive: 'INBOX', // Pas d'équivalent Archive Gmail, on garde dans INBOX (Gmail "All Mail" est implicite)
}

export interface LabelResolver {
  resolve(folder: GraphFolder): Promise<string[]>
  /** Résout les catégories Outlook en IDs de labels Gmail (crée les labels à la volée si besoin) */
  resolveCategories(categories: string[]): Promise<string[]>
}

export async function buildLabelResolver(
  userEmail: string,
  folders: GraphFolder[]
): Promise<LabelResolver> {
  const existingLabels = await listGmailLabels(userEmail)
  const byName = new Map(existingLabels.map((l) => [l.name.toLowerCase(), l.id]))

  // Pour chaque folder custom, on s'assure qu'un label Gmail existe
  const folderToLabelIds = new Map<string, string[]>()
  for (const f of folders) {
    const wkn = f.wellKnownName?.toLowerCase()
    if (wkn && SYSTEM_LABEL_MAP[wkn]) {
      folderToLabelIds.set(f.id, [SYSTEM_LABEL_MAP[wkn]])
      continue
    }
    // Folder custom → label Gmail au même nom
    const labelName = f.displayName
    let labelId = byName.get(labelName.toLowerCase())
    if (!labelId) {
      try {
        const created = await createGmailLabel(userEmail, labelName)
        labelId = created.id
        byName.set(labelName.toLowerCase(), labelId)
      } catch (err) {
        console.error(`[mail] create label "${labelName}" échoué:`, err instanceof Error ? err.message : err)
        labelId = 'INBOX' // fallback
      }
    }
    folderToLabelIds.set(f.id, [labelId])
  }

  // Cache catégorie Outlook → label Gmail (créé à la volée)
  const categoryCache = new Map<string, string>()

  return {
    async resolve(folder: GraphFolder) {
      return folderToLabelIds.get(folder.id) ?? ['INBOX']
    },

    async resolveCategories(categories: string[]): Promise<string[]> {
      if (!categories.length) return []
      const labelIds: string[] = []
      for (const cat of categories) {
        const catName = cat.trim()
        if (!catName) continue

        // Déjà résolu ?
        let labelId = categoryCache.get(catName.toLowerCase())
        if (labelId) { labelIds.push(labelId); continue }

        // Label existant avec le même nom ?
        labelId = byName.get(catName.toLowerCase())
        if (labelId) {
          categoryCache.set(catName.toLowerCase(), labelId)
          labelIds.push(labelId)
          continue
        }

        // Créer le label Gmail
        try {
          const created = await createGmailLabel(userEmail, catName)
          labelId = created.id
          byName.set(catName.toLowerCase(), labelId)
          categoryCache.set(catName.toLowerCase(), labelId)
          labelIds.push(labelId)
          console.log(`[mail] catégorie Outlook "${catName}" → label Gmail créé`)
        } catch (err) {
          console.error(`[mail] create category label "${catName}" échoué:`, err instanceof Error ? err.message : err)
          // On ne fait pas de fallback pour les catégories — on skip simplement
        }
      }
      return labelIds
    },
  }
}

// Import d'un message dans Gmail à partir du MIME brut
// Corrige les MIME malformés qui ont des headers dupliqués (From, Date, Subject…)
// Gmail refuse les mails avec plusieurs headers From → on ne garde que le premier
function fixDuplicateHeaders(mime: string): string {
  const headerEnd = mime.indexOf('\r\n\r\n')
  if (headerEnd === -1) return mime
  const headerPart = mime.slice(0, headerEnd)
  const body = mime.slice(headerEnd)

  const seen = new Set<string>()
  const lines = headerPart.split('\r\n')
  const fixed: string[] = []
  let skipContinuation = false

  for (const line of lines) {
    // Continuation line (starts with space/tab) → belongs to previous header
    if (/^[ \t]/.test(line)) {
      if (!skipContinuation) fixed.push(line)
      continue
    }
    const match = line.match(/^(From|Date|Subject|Message-ID|MIME-Version):/i)
    if (match) {
      const key = match[1]!.toLowerCase()
      if (seen.has(key)) {
        skipContinuation = true
        continue
      }
      seen.add(key)
    }
    skipContinuation = false
    fixed.push(line)
  }

  return fixed.join('\r\n') + body
}

export async function gmailImportMime(params: {
  userEmail: string
  rawMime: string
  labelIds: string[]
  isDraft?: boolean
  isRead?: boolean
}): Promise<{ id: string }> {
  const token = await getGoogleAccessTokenForUser(params.userEmail, GMAIL_SCOPE)

  const sanitizedMime = fixDuplicateHeaders(params.rawMime)

  // Encoding base64url pour Gmail API
  const raw = Buffer.from(sanitizedMime, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  // Si non lu, on n'inclut pas le label UNREAD car il y est par défaut.
  // Si lu, il faut RETIRER UNREAD via labelIds (en n'ajoutant pas) — Gmail ajoute UNREAD par défaut sur import.
  // Solution : on liste explicitement nos labels + on omet UNREAD si isRead, sinon on ajoute UNREAD.
  const labelIds = [...params.labelIds]
  if (!params.isRead && !labelIds.includes('UNREAD')) labelIds.push('UNREAD')

  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(params.userEmail)}/messages/import`
  )
  url.searchParams.set('internalDateSource', 'dateHeader')
  url.searchParams.set('neverMarkSpam', 'true')
  url.searchParams.set('processForCalendar', 'false')
  url.searchParams.set('deleted', 'false')

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, labelIds }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail import error (${res.status}): ${err}`)
  }
  return (await res.json()) as { id: string }
}

export type { GraphFolder, GraphMessageMeta }
