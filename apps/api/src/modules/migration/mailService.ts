// Migration mail Exchange → Gmail :
// - Lecture via Microsoft Graph (App-only, Mail.ReadWrite)
// - Écriture via Gmail API (impersonation user, scope mail.google.com)

import { getGoogleAccessTokenForUser } from './googleService'
import { getAccessToken } from './service'

const GMAIL_SCOPE = 'https://mail.google.com/'

// ── Microsoft Graph (lecture mail ONELA) ──────────────────────────────────────

async function onelaToken(): Promise<string> {
  const tid = process.env['ONELA_TENANT_ID']
  const cid = process.env['ONELA_CLIENT_ID']
  const sec = process.env['ONELA_CLIENT_SECRET']
  if (!tid || !cid || !sec) throw new Error('ONELA Graph credentials manquantes')
  return getAccessToken(tid, cid, sec)
}

interface GraphFolder {
  id: string
  displayName: string
  path: string
  wellKnownName?: string
  totalItemCount?: number
}

// Catégories Outlook par défaut (couleurs natives) — on ne les convertit pas en label Gmail
// pour éviter de polluer la liste des labels avec des noms génériques
const DEFAULT_OUTLOOK_CATEGORIES = new Set([
  // EN
  'orange category', 'red category', 'yellow category', 'blue category',
  'green category', 'purple category', 'black category', 'gray category',
  'grey category', 'pink category', 'olive category', 'teal category',
  'steel category', 'dark blue category', 'dark green category', 'dark red category',
  'dark yellow category', 'dark orange category', 'dark purple category',
  // FR
  'catégorie orange', 'catégorie rouge', 'catégorie jaune', 'catégorie bleu',
  'catégorie verte', 'catégorie violette', 'catégorie noire', 'catégorie grise',
  'catégorie rose', 'catégorie olive', 'catégorie sarcelle',
])

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
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${alias}?$select=id,displayName,totalItemCount`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (res.ok) {
        const f = (await res.json()) as { id: string; displayName: string; totalItemCount?: number }
        return { type: 'keep' as const, alias, id: f.id, displayName: f.displayName, totalItemCount: f.totalItemCount }
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
      folderById.set(r.id, { id: r.id, displayName: r.displayName, path: r.displayName, wellKnownName: r.alias, totalItemCount: r.totalItemCount })
      wellKnownIds.add(r.id)
    } else {
      skipIds.add(r.id)
    }
  }

  // 2. Lister les folders top-level du user
  let url: string | null =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders?$top=100&$select=id,displayName,totalItemCount`
  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Graph folders error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { value: Array<{ id: string; displayName: string; totalItemCount?: number }>; '@odata.nextLink'?: string }
    for (const f of data.value) {
      if (!folderById.has(f.id) && !skipIds.has(f.id)) {
        // Exclure aussi par displayName (fallback si l'alias well-known n'a pas été résolu)
        if (SKIP_DISPLAY_NAMES.has(f.displayName.toLowerCase())) {
          skipIds.add(f.id)
          continue
        }
        folderById.set(f.id, { id: f.id, displayName: f.displayName, path: f.displayName, totalItemCount: f.totalItemCount })
      } else if (folderById.has(f.id) && f.totalItemCount !== undefined) {
        // Compléter le totalItemCount d'un well-known déjà inséré sans count
        const existing = folderById.get(f.id)!
        existing.totalItemCount = f.totalItemCount
      }
    }
    url = data['@odata.nextLink'] ?? null
  }

  // 3. Récursion complète sur les sous-dossiers (chemin hiérarchique parent/child/...)
  // parentLabelPath = null signifie que les enfants directs utilisent juste leur displayName
  // (c'est le cas pour les dossiers well-known comme inbox, sent, etc.)
  async function crawlChildren(parentId: string, parentLabelPath: string | null): Promise<void> {
    let childUrl: string | null =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${parentId}/childFolders?$top=100&$select=id,displayName,totalItemCount`
    while (childUrl) {
      try {
        const res: Response = await fetch(childUrl, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) break
        const data = (await res.json()) as { value: Array<{ id: string; displayName: string; totalItemCount?: number }>; '@odata.nextLink'?: string }
        for (const f of data.value) {
          // Ignorer les sous-dossiers système (ex: enfants de "Problèmes de synchronisation")
          if (skipIds.has(f.id) || SKIP_DISPLAY_NAMES.has(f.displayName.toLowerCase())) {
            skipIds.add(f.id)
            continue
          }
          if (!folderById.has(f.id)) {
            // Si parentLabelPath est null, le sous-dossier devient un label racine (ex: inbox/Acer → "Acer")
            // Trim les espaces des noms de dossiers Exchange (certains ont des espaces en fin)
            const cleanName = f.displayName.trim()
            const childPath = parentLabelPath ? `${parentLabelPath}/${cleanName}` : cleanName
            folderById.set(f.id, { id: f.id, displayName: f.displayName, path: childPath, totalItemCount: f.totalItemCount })
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
// Si `folders` est fourni, on somme les totalItemCount des dossiers visibles (exclut
// Recoverable Items + Notes/Tasks/Calendar). Sinon, fallback sur /messages global.
export async function countOnelaMessages(
  userId: string,
  since?: Date | null,
  folders?: GraphFolder[]
): Promise<number> {
  // Compteur précis basé sur les dossiers visibles (mode par défaut depuis la refonte)
  // Note : en mode delta (since != null), totalItemCount n'est pas filtré par date —
  // on retombe alors sur le compteur global Graph
  if (folders && !since) {
    return folders.reduce((sum, f) => sum + (f.totalItemCount ?? 0), 0)
  }

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

// Récupère le MIME brut RFC 822 d'un message sous forme de Buffer binaire
// IMPORTANT : on utilise arrayBuffer() au lieu de text() pour préserver l'intégrité
// des pièces jointes (images, PDF, etc.) qui peuvent contenir des octets non-UTF-8
// Retry sur 429/503/504 (transitoires côté Graph) avec backoff exponentiel
export async function fetchOnelaMessageMime(userId: string, messageId: string): Promise<Buffer> {
  const RETRYABLE = new Set([429, 503, 504])
  const MAX_ATTEMPTS = 5
  let delay = 2000

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await onelaToken()
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/$value`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (res.ok) return Buffer.from(await res.arrayBuffer())

    const body = await res.text()
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(`Graph $value error (${res.status}): ${body}`)
    }
    // Respecter le header Retry-After de Graph (en secondes)
    const retryAfter = res.headers.get('Retry-After')
    const waitMs = retryAfter ? Math.max(parseInt(retryAfter, 10) * 1000, 1000) : delay
    if (attempt === 1) {
      console.warn(`[mail] $value ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${waitMs / 1000}s`)
    }
    await new Promise((r) => setTimeout(r, waitMs))
    delay = Math.min(delay * 2, 16000)
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

// Noms de labels réservés par Gmail (en toutes langues) — on ne peut pas les créer comme label custom
// On mappe vers le label système correspondant
const GMAIL_RESERVED_NAMES: Record<string, string> = {
  // FR
  'boîte de réception': 'INBOX', 'éléments envoyés': 'SENT', 'brouillons': 'DRAFT',
  'corbeille': 'TRASH', 'spam': 'SPAM', 'courrier indésirable': 'SPAM',
  'éléments supprimés': 'TRASH', 'important': 'IMPORTANT', 'favoris': 'STARRED',
  // EN
  'inbox': 'INBOX', 'sent': 'SENT', 'sent mail': 'SENT', 'drafts': 'DRAFT',
  'draft': 'DRAFT', 'trash': 'TRASH', 'junk': 'SPAM', 'starred': 'STARRED',
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

    // Nettoyer le nom du label : trim espaces, supprimer les "/" en fin
    const labelName = f.path.replace(/\s+\//g, '/').replace(/\/\s+/g, '/').replace(/\s+$/gm, '').trim()
    if (!labelName) {
      folderToLabelIds.set(f.id, ['INBOX'])
      continue
    }

    // Vérifier si c'est un nom réservé par Gmail (ex: "Brouillons", "Éléments supprimés")
    const reservedLabel = GMAIL_RESERVED_NAMES[labelName.toLowerCase()]
    if (reservedLabel) {
      folderToLabelIds.set(f.id, [reservedLabel])
      continue
    }

    // Chercher un label existant (par nom exact ou trimé)
    let labelId = byName.get(labelName.toLowerCase())
    if (!labelId) {
      try {
        const created = await createGmailLabel(userEmail, labelName)
        labelId = created.id
        byName.set(labelName.toLowerCase(), labelId)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        // 409 = label existe déjà → rafraîchir la liste et chercher par nom
        if (errMsg.includes('409')) {
          try {
            const freshLabels = await listGmailLabels(userEmail)
            for (const l of freshLabels) byName.set(l.name.toLowerCase(), l.id)
            labelId = byName.get(labelName.toLowerCase())
          } catch { /* ignore refresh failure */ }
        }
        if (!labelId) {
          console.error(`[mail] create label "${labelName}" échoué:`, errMsg.slice(0, 200))
          labelId = 'INBOX' // fallback ultime
        }
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

        // Skip les catégories par défaut Outlook (couleurs natives) — sinon on pollue
        // Gmail avec "Orange category", "Red category", etc. (noms génériques sans valeur)
        if (DEFAULT_OUTLOOK_CATEGORIES.has(catName.toLowerCase())) continue

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

// Import d'un message dans Gmail à partir du MIME brut (Buffer binaire)
// Corrige les MIME malformés qui ont des headers dupliqués (From, Date, Subject…)
// Gmail refuse les mails avec plusieurs headers From → on ne garde que le premier
// IMPORTANT : on travaille sur Buffer pour préserver l'intégrité binaire des pièces jointes
function fixDuplicateHeaders(mime: Buffer): Buffer {
  // Les headers MIME sont toujours en 7-bit ASCII, seul le body peut contenir du binaire
  // On cherche la séparation headers/body (double CRLF ou double LF)
  const crlfCrlf = Buffer.from('\r\n\r\n')
  const lfLf = Buffer.from('\n\n')
  let headerEndIdx = mime.indexOf(crlfCrlf)
  let eol = '\r\n'
  if (headerEndIdx === -1) {
    headerEndIdx = mime.indexOf(lfLf)
    eol = '\n'
  }
  if (headerEndIdx === -1) return mime // pas de séparation headers/body trouvée

  // Extraire seulement la partie headers en string ASCII (safe)
  const headerPart = mime.subarray(0, headerEndIdx).toString('ascii')
  const bodyPart = mime.subarray(headerEndIdx) // garde le body en binaire intact

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

  const fixedHeaders = Buffer.from(fixed.join(eol), 'ascii')
  return Buffer.concat([fixedHeaders, bodyPart])
}

function bufferToBase64Url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Seuil au-delà duquel on utilise le resumable upload Gmail (en bytes)
// Gmail limite le JSON body à ~5 Mo ; le base64 gonfle de ~33% → seuil à 3.5 Mo bruts
const RESUMABLE_THRESHOLD = 3.5 * 1024 * 1024

export async function gmailImportMime(params: {
  userEmail: string
  rawMime: Buffer
  labelIds: string[]
  isDraft?: boolean
  isRead?: boolean
}): Promise<{ id: string }> {
  const sanitizedMime = fixDuplicateHeaders(params.rawMime)
  const raw = bufferToBase64Url(sanitizedMime)

  const labelIds = [...params.labelIds]
  if (!params.isRead && !labelIds.includes('UNREAD')) labelIds.push('UNREAD')

  // Pour les gros mails, utiliser le resumable upload au lieu du JSON body
  const useResumable = sanitizedMime.length > RESUMABLE_THRESHOLD

  // Retry sur 502/503/429 Gmail (erreurs transitoires)
  const GMAIL_RETRYABLE = new Set([429, 502, 503])
  const MAX_GMAIL_ATTEMPTS = 3
  let lastError = ''

  for (let attempt = 1; attempt <= MAX_GMAIL_ATTEMPTS; attempt++) {
    const token = await getGoogleAccessTokenForUser(params.userEmail, GMAIL_SCOPE)

    // ── Gros mail : resumable upload (multipart) ──────────────────────────
    if (useResumable) {
      try {
        const result = await gmailResumableInsert(token, params.userEmail, sanitizedMime, labelIds)
        return result
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        // Retry on transient errors
        if (attempt < MAX_GMAIL_ATTEMPTS && /\b(429|502|503)\b/.test(errMsg)) {
          const waitMs = 2000 * attempt
          console.warn(`[mail] Gmail resumable ${errMsg.slice(0, 80)} — retry ${attempt}/${MAX_GMAIL_ATTEMPTS} dans ${waitMs / 1000}s`)
          await new Promise((r) => setTimeout(r, waitMs))
          continue
        }
        throw err
      }
    }

    // ── Mail normal : JSON body avec raw base64 ──────────────────────────
    // 1) Essai avec messages.insert (bypass la classification Gmail → respecte les labels exactement)
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

    // Retry sur erreurs transitoires Gmail (502, 503, 429)
    if (GMAIL_RETRYABLE.has(insertRes.status) && attempt < MAX_GMAIL_ATTEMPTS) {
      const waitMs = insertRes.status === 429 ? 5000 : 2000 * attempt
      console.warn(`[mail] Gmail insert ${insertRes.status} — retry ${attempt}/${MAX_GMAIL_ATTEMPTS} dans ${waitMs / 1000}s`)
      await new Promise((r) => setTimeout(r, waitMs))
      continue
    }

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
        // Note : Gmail INTERDIT d'ajouter SENT/DRAFT via messages.modify
        // (ces labels système ne peuvent être appliqués qu'à la création)
        const result = (await importRes.json()) as { id: string; labelIds?: string[] }
        const appliedLabels = new Set(result.labelIds ?? [])
        const missingLabels = labelIds
          .filter((l) => !appliedLabels.has(l))
          .filter((l) => l !== 'SENT' && l !== 'DRAFT')
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

    // 413 = trop gros pour le JSON body → forcer le resumable upload
    if (insertRes.status === 413) {
      console.warn(`[mail] insert 413 (taille: ${(sanitizedMime.length / 1024 / 1024).toFixed(1)} Mo), tentative resumable upload`)
      try {
        return await gmailResumableInsert(token, params.userEmail, sanitizedMime, labelIds)
      } catch (err) {
        throw new Error(`Gmail resumable upload failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    lastError = `Gmail insert error (${insertRes.status}): ${insertErr}`
    break // Non-retryable error, exit loop
  }

  throw new Error(lastError || 'Gmail import: all attempts failed')
}

// Upload d'un gros mail via le multipart upload Gmail (>3.5 Mo)
// Utilise le endpoint /upload/gmail/v1/users/.../messages avec uploadType=multipart
async function gmailResumableInsert(
  token: string,
  userEmail: string,
  mimeBuffer: Buffer,
  labelIds: string[]
): Promise<{ id: string }> {
  const boundary = `----MigrationBoundary${Date.now()}`
  const metadata = JSON.stringify({ labelIds })

  // Construire le body multipart manuellement
  const parts = [
    `--${boundary}\r\n`,
    `Content-Type: application/json; charset=UTF-8\r\n\r\n`,
    metadata,
    `\r\n--${boundary}\r\n`,
    `Content-Type: message/rfc822\r\n\r\n`,
  ]
  const preamble = Buffer.from(parts.join(''), 'utf-8')
  const epilogue = Buffer.from(`\r\n--${boundary}--`, 'utf-8')
  const body = Buffer.concat([preamble, mimeBuffer, epilogue])

  const url = new URL(
    `https://gmail.googleapis.com/upload/gmail/v1/users/${encodeURIComponent(userEmail)}/messages`
  )
  url.searchParams.set('uploadType', 'multipart')
  url.searchParams.set('internalDateSource', 'dateHeader')

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary="${boundary}"`,
      'Content-Length': String(body.length),
    },
    body,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail multipart upload error (${res.status}): ${err}`)
  }
  return (await res.json()) as { id: string }
}

// Modifier les labels d'un message Gmail existant (ajouter + retirer)
// Gmail INTERDIT d'ajouter ou retirer SENT/DRAFT via messages.modify (labels système
// uniquement appliqués à la création). On les filtre silencieusement.
const NON_MODIFIABLE_LABELS = new Set(['SENT', 'DRAFT'])

export async function gmailModifyLabels(params: {
  userEmail: string
  messageId: string
  addLabelIds: string[]
  removeLabelIds: string[]
}): Promise<void> {
  const addLabelIds = params.addLabelIds.filter((l) => !NON_MODIFIABLE_LABELS.has(l))
  const removeLabelIds = params.removeLabelIds.filter((l) => !NON_MODIFIABLE_LABELS.has(l))

  // Rien à modifier après filtrage → skip silencieux
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) return

  const token = await getGoogleAccessTokenForUser(params.userEmail, GMAIL_SCOPE)
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(params.userEmail)}/messages/${params.messageId}/modify`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    }
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail modify error (${res.status}): ${err}`)
  }
}

export type { GraphFolder, GraphMessageMeta }
