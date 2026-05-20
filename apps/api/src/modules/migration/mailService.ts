// Migration mail Exchange → Gmail :
// - Lecture via Microsoft Graph (App-only, Mail.ReadWrite)
// - Écriture via Gmail API (impersonation user, scope mail.google.com)

import { getGoogleAccessTokenForUser } from './googleService'

const GMAIL_SCOPE = 'https://mail.google.com/'

// ── Microsoft Graph (lecture mail ONELA) ──────────────────────────────────────

let _cachedToken: { token: string; expiresAt: number } | null = null
const TOKEN_MARGIN_MS = 5 * 60 * 1000 // renouveler 5min avant expiration

async function onelaToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt) return _cachedToken.token

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
  const data = (await res.json()) as { access_token: string; expires_in?: number }
  const expiresIn = (data.expires_in ?? 3600) * 1000
  _cachedToken = { token: data.access_token, expiresAt: Date.now() + expiresIn - TOKEN_MARGIN_MS }
  return data.access_token
}

interface GraphFolder {
  id: string
  displayName: string
  path: string
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

// Dossiers système Exchange à ne PAS migrer (ni eux, ni leurs enfants)
const SKIP_WELL_KNOWN = new Set(['outbox', 'syncissues', 'rssfeed', 'conversationhistory', 'clutter', 'scheduled', 'recoverableitemsdeletions'])

// displayName français/anglais des dossiers système à ignorer (fallback quand wellKnownName absent)
const SKIP_DISPLAY_NAMES = new Set([
  // FR
  'boîte d\'envoi', 'problèmes de synchronisation', 'conflits',
  'défaillances du serveur', 'défaillances locales', 'flux rss',
  'historique des conversations', 'courrier indésirable',
  // EN
  'outbox', 'sync issues', 'conflicts', 'server failures',
  'local failures', 'rss feeds', 'conversation history', 'clutter',
])

export async function listOnelaFolders(userId: string): Promise<GraphFolder[]> {
  const token = await onelaToken()
  const folderById = new Map<string, GraphFolder>()
  const wellKnownIds = new Set<string>()

  // IDs des dossiers à ignorer complètement (système Exchange)
  const skipIds = new Set<string>()

  // 1. Récupérer en parallèle les folders well-known + ceux à ignorer
  const wellKnownPromises = WELL_KNOWN_ALIASES.map(async (alias) => {
    try {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${alias}?$select=id,displayName`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (res.ok) {
        const f = (await res.json()) as { id: string; displayName: string }
        return { type: 'keep' as const, alias, id: f.id, displayName: f.displayName }
      }
    } catch { /* alias absent */ }
    return null
  })

  const skipPromises = [...SKIP_WELL_KNOWN].map(async (alias) => {
    try {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${alias}?$select=id`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (res.ok) {
        const f = (await res.json()) as { id: string }
        return { type: 'skip' as const, id: f.id }
      }
    } catch { /* absent */ }
    return null
  })

  const allResults = await Promise.all([...wellKnownPromises, ...skipPromises])
  for (const r of allResults) {
    if (!r) continue
    if (r.type === 'keep') {
      folderById.set(r.id, { id: r.id, displayName: r.displayName, path: r.displayName, wellKnownName: r.alias })
      wellKnownIds.add(r.id)
    } else {
      skipIds.add(r.id)
    }
  }

  // 2. Lister les folders top-level du user
  let url: string | null =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders?$top=100&$select=id,displayName`
  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Graph folders error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { value: Array<{ id: string; displayName: string }>; '@odata.nextLink'?: string }
    for (const f of data.value) {
      if (!folderById.has(f.id) && !skipIds.has(f.id)) {
        // Exclure aussi par displayName (fallback si l'alias well-known n'a pas été résolu)
        if (SKIP_DISPLAY_NAMES.has(f.displayName.toLowerCase())) {
          skipIds.add(f.id)
          continue
        }
        folderById.set(f.id, { id: f.id, displayName: f.displayName, path: f.displayName })
      }
    }
    url = data['@odata.nextLink'] ?? null
  }

  // 3. Récursion complète sur les sous-dossiers (chemin hiérarchique parent/child/...)
  // parentLabelPath = null signifie que les enfants directs utilisent juste leur displayName
  // (c'est le cas pour les dossiers well-known comme inbox, sent, etc.)
  async function crawlChildren(parentId: string, parentLabelPath: string | null): Promise<void> {
    let childUrl: string | null =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${parentId}/childFolders?$top=100&$select=id,displayName`
    while (childUrl) {
      try {
        const res: Response = await fetch(childUrl, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) break
        const data = (await res.json()) as { value: Array<{ id: string; displayName: string }>; '@odata.nextLink'?: string }
        for (const f of data.value) {
          // Ignorer les sous-dossiers système (ex: enfants de "Problèmes de synchronisation")
          if (skipIds.has(f.id) || SKIP_DISPLAY_NAMES.has(f.displayName.toLowerCase())) {
            skipIds.add(f.id)
            continue
          }
          if (!folderById.has(f.id)) {
            // Si parentLabelPath est null, le sous-dossier devient un label racine (ex: inbox/Acer → "Acer")
            const childPath = parentLabelPath ? `${parentLabelPath}/${f.displayName}` : f.displayName
            folderById.set(f.id, { id: f.id, displayName: f.displayName, path: childPath })
            await crawlChildren(f.id, childPath)
          }
        }
        childUrl = data['@odata.nextLink'] ?? null
      } catch { break }
    }
  }

  // Crawl depuis tous les top-level folders (y compris well-known comme inbox)
  // Pour les dossiers well-known mappés vers un label système (inbox→INBOX, sent→SENT...),
  // les sous-dossiers deviennent des labels racine (sans préfixe "Boîte de réception/")
  for (const folder of [...folderById.values()]) {
    if (skipIds.has(folder.id)) continue
    const isWellKnown = folder.wellKnownName && SYSTEM_LABEL_MAP[folder.wellKnownName]
    // well-known → enfants sans préfixe ; custom → enfants avec préfixe hiérarchique
    await crawlChildren(folder.id, isWellKnown ? null : folder.path)
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
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/messages?$top=100&$select=id,internetMessageId,parentFolderId,isRead,isDraft,categories,subject,receivedDateTime`
  const filter = since ? `&$filter=receivedDateTime gt ${since.toISOString()}` : ''
  let url: string | null = base + filter
  while (url) {
    const token = await onelaToken()
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
  const MAX_ATTEMPTS = 5
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
    // Respecter le header Retry-After de Graph (en secondes)
    const retryAfter = res.headers.get('Retry-After')
    const waitMs = retryAfter ? Math.max(parseInt(retryAfter, 10) * 1000, 1000) : delay
    if (attempt <= 2) {
      // Log seulement les premiers retries pour éviter le spam
      console.warn(`[mail] $value ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${waitMs / 1000}s`)
    }
    await new Promise((r) => setTimeout(r, waitMs))
    delay = Math.min(delay * 2, 16000) // cap à 16s
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
    // Folder custom → label Gmail avec le chemin hiérarchique (parent/child → "parent/child" dans Gmail)
    const labelName = f.path
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
  // Détecte le séparateur de ligne (\r\n ou \n)
  const eol = mime.includes('\r\n') ? '\r\n' : '\n'
  const headerEnd = mime.indexOf(eol + eol)
  if (headerEnd === -1) return mime
  const headerPart = mime.slice(0, headerEnd)
  const body = mime.slice(headerEnd)

  const seen = new Set<string>()
  const lines = headerPart.split(eol)
  const fixed: string[] = []
  let skipContinuation = false

  for (const line of lines) {
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

  return fixed.join(eol) + body
}

function mimeToBase64Url(mime: string): string {
  return Buffer.from(mime, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
  const raw = mimeToBase64Url(sanitizedMime)

  const labelIds = [...params.labelIds]
  if (!params.isRead && !labelIds.includes('UNREAD')) labelIds.push('UNREAD')

  // 1) Essai avec messages.insert (bypass la classification Gmail → respecte les labels exactement)
  //    messages.import applique la classification standard de Gmail et peut ignorer les labels custom
  const insertUrl = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(params.userEmail)}/messages`
  )
  insertUrl.searchParams.set('internalDateSource', 'dateHeader')
  insertUrl.searchParams.set('deleted', 'false')

  const insertRes = await fetch(insertUrl.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, labelIds }),
  })

  if (insertRes.ok) return (await insertRes.json()) as { id: string }

  const insertErr = await insertRes.text()

  // 2) Si erreur 400 (headers malformés), fallback sur messages.import (plus tolérant sur le MIME)
  if (insertRes.status === 400) {
    console.warn(`[mail] insert 400, fallback import: ${insertErr.slice(0, 120)}`)
    const importUrl = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(params.userEmail)}/messages/import`
    )
    importUrl.searchParams.set('internalDateSource', 'dateHeader')
    importUrl.searchParams.set('neverMarkSpam', 'true')
    importUrl.searchParams.set('processForCalendar', 'false')
    importUrl.searchParams.set('deleted', 'false')

    const importRes = await fetch(importUrl.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, labelIds }),
    })

    if (importRes.ok) {
      // messages.import peut ignorer les labels custom → on les force avec messages.modify
      const result = (await importRes.json()) as { id: string; labelIds?: string[] }
      const appliedLabels = new Set(result.labelIds ?? [])
      const missingLabels = labelIds.filter((l) => !appliedLabels.has(l))
      if (missingLabels.length > 0) {
        try {
          await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(params.userEmail)}/messages/${result.id}/modify`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ addLabelIds: missingLabels }),
            }
          )
        } catch { /* best effort */ }
      }
      return result
    }
    const importErr = await importRes.text()
    throw new Error(`Gmail import error (${importRes.status}): ${importErr}`)
  }

  throw new Error(`Gmail insert error (${insertRes.status}): ${insertErr}`)
}

export type { GraphFolder, GraphMessageMeta }
