// Migration mail Exchange → Gmail :
// - Lecture via Microsoft Graph (App-only, Mail.ReadWrite)
// - Écriture via Gmail API (impersonation user, scope mail.google.com)

import { fetchWithTimeout } from './httpClient'
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
  /**
   * Alias du dossier système (inbox/sentitems/deleteditems/...) duquel ce dossier descend.
   * Permet au resolver d'appliquer le bon label système (TRASH pour les enfants de
   * Deleted Items, SENT pour ceux de Sent Items, etc.) en plus du label custom.
   */
  wellKnownAncestor?: string
  totalItemCount?: number
}

/**
 * Configuration par dossier système Exchange : comment traiter ses sous-dossiers.
 *
 * - `childPrefix` : préfixe à appliquer au path des sous-dossiers.
 *     `null` = sous-dossiers deviennent des labels racine (Inbox/Acer → "Acer").
 *     `"Corbeille"` = sous-dossiers préfixés (Deleted/Khadija → "Corbeille/Khadija").
 *
 * - `skipChildren` : `true` = on ne descend pas dans ce dossier système (Junk).
 *
 * - `systemLabelForDescendants` : label Gmail système à ajouter pour tout descendant.
 *     Ex: enfants de Deleted Items obtiennent `TRASH` en plus de leur label custom,
 *     donc apparaissent dans la Corbeille Gmail (purge auto à 30j conforme à
 *     l'intention "supprimé" de l'utilisateur).
 */
interface WellKnownChildConfig {
  childPrefix: string | null
  skipChildren: boolean
  systemLabelForDescendants: string | null
}

const WELL_KNOWN_CHILD_CONFIG: Record<string, WellKnownChildConfig> = {
  inbox:        { childPrefix: null,         skipChildren: false, systemLabelForDescendants: null },
  archive:      { childPrefix: null,         skipChildren: false, systemLabelForDescendants: null },
  sentitems:    { childPrefix: 'Envoyés',    skipChildren: false, systemLabelForDescendants: 'SENT' },
  drafts:       { childPrefix: 'Brouillons', skipChildren: false, systemLabelForDescendants: 'DRAFT' },
  junkemail:    { childPrefix: null,         skipChildren: true,  systemLabelForDescendants: null },
  // deleteditems retiré volontairement : on ne migre plus Éléments supprimés ni ses enfants.
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
const WELL_KNOWN_ALIASES = ['inbox', 'sentitems', 'drafts', 'junkemail', 'archive'] as const

// Dossiers système Exchange à ne PAS migrer (ni eux, ni leurs enfants).
// `deleteditems` (Éléments supprimés / Corbeille Outlook) en fait partie depuis juin 2026 :
// l'utilisateur ne veut pas que la Corbeille Outlook pollue Gmail.
const SKIP_WELL_KNOWN = new Set(['outbox', 'syncissues', 'rssfeed', 'conversationhistory', 'clutter', 'scheduled', 'recoverableitemsdeletions', 'deleteditems'])

// displayName français/anglais des dossiers système à ignorer (fallback quand wellKnownName absent)
const SKIP_DISPLAY_NAMES = new Set([
  // FR
  'boîte d\'envoi', 'problèmes de synchronisation', 'conflits',
  'défaillances du serveur', 'défaillances locales', 'flux rss',
  'historique des conversations', 'courrier indésirable',
  'éléments supprimés', 'corbeille',
  // EN
  'outbox', 'sync issues', 'conflicts', 'server failures',
  'local failures', 'rss feeds', 'conversation history', 'clutter',
  'deleted items', 'trash',
])

// Fallback : reconnaître un dossier well-known par son displayName si la résolution
// par alias a échoué (typiquement à cause d'un 429 throttling Graph). Sans ça, l'inbox
// devient un dossier "normal" et ses sous-dossiers héritent du préfixe "Boîte de réception/…".
const WELL_KNOWN_DISPLAY_NAMES: Record<string, string> = {
  // inbox
  'boîte de réception': 'inbox', 'inbox': 'inbox',
  // sentitems
  'éléments envoyés': 'sentitems', 'sent items': 'sentitems', 'sent': 'sentitems',
  // drafts
  'brouillons': 'drafts', 'drafts': 'drafts', 'draft': 'drafts',
  // junkemail
  'courrier indésirable': 'junkemail', 'spam': 'junkemail', 'junk email': 'junkemail', 'junk': 'junkemail',
  // archive
  'archive': 'archive', 'archives': 'archive',
  // deleteditems retiré : reconnaissable seulement comme SKIP via SKIP_DISPLAY_NAMES.
}

// Helper : fetch Graph avec retry sur 429/503/504 (throttling transitoire)
async function graphFolderFetchWithRetry(url: string, token: string, label: string): Promise<Response | null> {
  const RETRYABLE = new Set([429, 503, 504])
  const MAX_ATTEMPTS = 4
  let delay = 1500
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok || res.status === 404) return res
      if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) {
        console.warn(`[mail] ${label} non-retry ${res.status}`)
        return res
      }
      const retryAfter = res.headers.get('Retry-After')
      const waitMs = retryAfter ? Math.max(parseInt(retryAfter, 10) * 1000, 1000) : delay
      console.warn(`[mail] ${label} ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${waitMs}ms`)
      await new Promise((r) => setTimeout(r, waitMs))
      delay = Math.min(delay * 2, 12_000)
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        console.warn(`[mail] ${label} fetch error:`, err instanceof Error ? err.message : err)
        return null
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 12_000)
    }
  }
  return null
}

export async function listOnelaFolders(userId: string): Promise<GraphFolder[]> {
  const token = await onelaToken()
  const folderById = new Map<string, GraphFolder>()
  const wellKnownIds = new Set<string>()

  // IDs des dossiers à ignorer complètement (système Exchange)
  const skipIds = new Set<string>()

  // 1. Récupérer en parallèle les folders well-known + ceux à ignorer
  // Retry sur 429/503 : crucial quand plusieurs migrations tournent ; sans retry,
  // un throttle silencieux fait perdre l'identification "inbox" → tous les sous-dossiers
  // se retrouvent préfixés "Boîte de réception/…" en label Gmail.
  const wellKnownPromises = WELL_KNOWN_ALIASES.map(async (alias) => {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${alias}?$select=id,displayName,totalItemCount`
    const res = await graphFolderFetchWithRetry(url, token, `mailFolders/${alias}`)
    if (res?.ok) {
      const f = (await res.json()) as { id: string; displayName: string; totalItemCount?: number }
      return { type: 'keep' as const, alias, id: f.id, displayName: f.displayName, totalItemCount: f.totalItemCount }
    }
    return null
  })

  const skipPromises = [...SKIP_WELL_KNOWN].map(async (alias) => {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${alias}?$select=id`
    const res = await graphFolderFetchWithRetry(url, token, `mailFolders/${alias} (skip)`)
    if (res?.ok) {
      const f = (await res.json()) as { id: string }
      return { type: 'skip' as const, id: f.id }
    }
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
    const res: Response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Graph folders error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { value: Array<{ id: string; displayName: string; totalItemCount?: number }>; '@odata.nextLink'?: string }
    for (const f of data.value) {
      if (!folderById.has(f.id) && !skipIds.has(f.id)) {
        // Exclure aussi par displayName (fallback si l'alias well-known n'a pas été résolu)
        if (SKIP_DISPLAY_NAMES.has(f.displayName.toLowerCase())) {
          skipIds.add(f.id)
          continue
        }
        // FALLBACK well-known par displayName : si pass 1 a échoué (throttling Graph),
        // un dossier "Boîte de réception" arrive ici comme dossier normal. On lui colle
        // wellKnownName='inbox' pour que le crawl respecte childPrefix=null et que ses
        // enfants ne soient pas préfixés "Boîte de réception/…".
        const inferredWkn = WELL_KNOWN_DISPLAY_NAMES[f.displayName.toLowerCase()]
        if (inferredWkn) {
          if (!wellKnownIds.has(f.id)) {
            console.warn(`[mail] well-known "${inferredWkn}" résolu par displayName fallback (pass 1 a manqué) — folder "${f.displayName}"`)
            folderById.set(f.id, { id: f.id, displayName: f.displayName, path: f.displayName, wellKnownName: inferredWkn, totalItemCount: f.totalItemCount })
            wellKnownIds.add(f.id)
          }
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
  // `parentLabelPath = null` → l'enfant prend juste son displayName (label racine).
  // `wellKnownAncestor` = alias du dossier système (inbox/sentitems/...) duquel on
  // descend ; transmis récursivement pour que le resolver applique le bon label
  // système (TRASH pour les enfants de Deleted Items, SENT pour ceux de Sent…).
  async function crawlChildren(
    parentId: string,
    parentLabelPath: string | null,
    wellKnownAncestor: string | undefined
  ): Promise<void> {
    let childUrl: string | null =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/mailFolders/${parentId}/childFolders?$top=100&$select=id,displayName,totalItemCount`
    while (childUrl) {
      try {
        const res: Response = await fetchWithTimeout(childUrl, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) break
        const data = (await res.json()) as { value: Array<{ id: string; displayName: string; totalItemCount?: number }>; '@odata.nextLink'?: string }
        for (const f of data.value) {
          // Ignorer les sous-dossiers système (ex: enfants de "Problèmes de synchronisation")
          if (skipIds.has(f.id) || SKIP_DISPLAY_NAMES.has(f.displayName.toLowerCase())) {
            skipIds.add(f.id)
            continue
          }
          if (!folderById.has(f.id)) {
            // Trim les espaces des noms de dossiers Exchange (certains ont des espaces en fin)
            const cleanName = f.displayName.trim()
            const childPath = parentLabelPath ? `${parentLabelPath}/${cleanName}` : cleanName
            folderById.set(f.id, {
              id: f.id,
              displayName: f.displayName,
              path: childPath,
              totalItemCount: f.totalItemCount,
              wellKnownAncestor,
            })
            await crawlChildren(f.id, childPath, wellKnownAncestor)
          }
        }
        childUrl = data['@odata.nextLink'] ?? null
      } catch { break }
    }
  }

  // Crawl depuis tous les top-level folders (y compris well-known comme inbox).
  // Comportement par dossier système :
  //   - inbox / archive  → enfants en labels racine, pas de label système hérité
  //   - sentitems        → enfants préfixés "Envoyés/", + label SENT
  //   - drafts           → enfants préfixés "Brouillons/", + label DRAFT
  //   - deleteditems     → enfants préfixés "Corbeille/", + label TRASH (auto-purge 30j)
  //   - junkemail        → enfants ignorés (spam ne mérite pas d'organisation)
  //   - custom           → enfants avec préfixe hiérarchique de leur parent
  for (const folder of [...folderById.values()]) {
    if (skipIds.has(folder.id)) continue
    const wkn = folder.wellKnownName?.toLowerCase()
    const config = wkn ? WELL_KNOWN_CHILD_CONFIG[wkn] : null

    if (config?.skipChildren) {
      continue
    }

    const childPrefix = config ? config.childPrefix : folder.path
    await crawlChildren(folder.id, childPrefix, wkn)
  }

  return [...folderById.values()]
}

// Construit un fragment de filter OData combinant `since` (lower bound exclusif)
// et `until` (upper bound inclusif) sur receivedDateTime.
function buildReceivedDateFilter(since?: Date | null, until?: Date | null): string {
  const parts: string[] = []
  if (since) parts.push(`receivedDateTime gt ${since.toISOString()}`)
  if (until) parts.push(`receivedDateTime le ${until.toISOString()}`)
  return parts.length > 0 ? `&$filter=${encodeURIComponent(parts.join(' and '))}` : ''
}

// Compte le nombre de messages avant l'itération pour afficher le total dès le début
// Si `folders` est fourni, on somme les totalItemCount des dossiers visibles (exclut
// Recoverable Items + Notes/Tasks/Calendar). Sinon, fallback sur /messages global.
// `until` plafonne le compte aux mails reçus AVANT le démarrage du run, pour ne pas
// inclure les mails déposés par le dual-delivery pendant que le worker tourne.
export async function countOnelaMessages(
  userId: string,
  since?: Date | null,
  folders?: GraphFolder[],
  until?: Date | null
): Promise<number> {
  // Compteur précis basé sur les dossiers visibles (mode par défaut depuis la refonte)
  // Note : en mode delta (since != null), totalItemCount n'est pas filtré par date —
  // on retombe alors sur le compteur global Graph
  if (folders && !since) {
    return folders.reduce((sum, f) => sum + (f.totalItemCount ?? 0), 0)
  }

  const token = await onelaToken()
  const filter = buildReceivedDateFilter(since, until)
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/messages?$count=true&$top=1${filter}`
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
  })
  if (!res.ok) throw new Error(`Graph count error (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { '@odata.count'?: number }
  return data['@odata.count'] ?? 0
}

// `until` (optionnel) plafonne l'itération à receivedDateTime <= until — empêche
// le worker d'attraper les mails arrivés via dual-delivery PENDANT que le run tourne
// (ces mails sont déjà dans Gmail, les retraiter ne sert qu'à faire enfler le compteur).
export async function* iterateOnelaMessages(
  userId: string,
  since?: Date | null,
  until?: Date | null
): AsyncGenerator<GraphMessageMeta> {
  // $orderby=receivedDateTime desc : migrer du PLUS RÉCENT au plus ancien.
  // CRITIQUE : sans cet orderby explicite, dès qu'un $filter sur receivedDateTime est
  // présent (ce qui est TOUJOURS le cas depuis le plafond `until`), Graph bascule son
  // tri par défaut en ASCENDANT → les mails partaient du plus ancien, ce qui casse la
  // stratégie « pause à 10k récents ». Filtre + tri sur la même propriété = supporté.
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/messages?$top=100&$select=id,internetMessageId,parentFolderId,isRead,isDraft,categories,subject,receivedDateTime&$orderby=${encodeURIComponent('receivedDateTime desc')}`
  const filter = buildReceivedDateFilter(since, until)
  let url: string | null = base + filter
  while (url) {
    const token = await onelaToken()
    const res: Response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } })
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
    const res = await fetchWithTimeout(
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
  const res = await fetchWithTimeout(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/labels`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`Gmail labels error (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { labels: GmailLabel[] }
  return data.labels
}

export async function createGmailLabel(userEmail: string, name: string): Promise<GmailLabel> {
  const token = await getGoogleAccessTokenForUser(userEmail, GMAIL_SCOPE)
  const res = await fetchWithTimeout(
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

    // Pour les descendants d'un dossier système (sent/drafts/deleteditems),
    // on ajoute le label système hérité en plus du label custom.
    // Ex : un mail dans "Deleted Items/Khadija" obtient `["Corbeille/Khadija", "TRASH"]`
    // → visible dans le label custom ET dans la Corbeille Gmail (purge auto à 30j).
    const ancestorConfig = f.wellKnownAncestor ? WELL_KNOWN_CHILD_CONFIG[f.wellKnownAncestor] : null
    const systemLabel = ancestorConfig?.systemLabelForDescendants
    const finalLabels = systemLabel ? [labelId, systemLabel] : [labelId]
    folderToLabelIds.set(f.id, finalLabels)
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

/**
 * Cherche dans Gmail un message existant avec le même Message-ID RFC822.
 * Permet d'éviter les doublons quand on relance une migration après un reset.
 * Retourne l'ID Gmail du message existant, ou `null` s'il n'existe pas.
 */
export async function gmailFindByMessageId(
  userEmail: string,
  internetMessageId: string
): Promise<string | null> {
  if (!internetMessageId) return null

  const token = await getGoogleAccessTokenForUser(userEmail, GMAIL_SCOPE)
  // Le Message-ID est souvent entre `<>` dans le header brut, Gmail accepte les deux formats
  const cleaned = internetMessageId.replace(/^<|>$/g, '')
  const q = `rfc822msgid:${cleaned}`
  const url = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/messages?q=${encodeURIComponent(q)}&maxResults=1`

  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    // 404 / 429 / 5xx → on retourne null pour ne pas bloquer la migration
    return null
  }
  const data = (await res.json()) as { messages?: Array<{ id: string }> }
  return data.messages?.[0]?.id ?? null
}

/**
 * Scanne toute la mailbox Gmail, groupe les messages par Message-ID RFC822 et
 * supprime les doublons (garde le plus ancien). Utile après une mauvaise réinit
 * qui aurait re-uploadé des messages déjà migrés.
 *
 * NB : la suppression Gmail = déplacement vers la Corbeille (purge auto 30j).
 * On ne fait pas batchDelete pour rester compatible avec le scope `gmail.modify`.
 */
export async function gmailDedupeMailbox(
  userEmail: string,
  onProgress?: (scanned: number, duplicatesRemoved: number) => void
): Promise<{ scanned: number; duplicatesRemoved: number; errors: number }> {
  const token = await getGoogleAccessTokenForUser(userEmail, GMAIL_SCOPE)

  // Map: Message-ID → liste de { gmailId, internalDate } pour grouper les doublons
  const byMsgId = new Map<string, Array<{ gmailId: string; internalDate: number }>>()
  let scanned = 0

  // 1. Lister tous les message IDs de la mailbox (paginé, 500 par page)
  const allIds: string[] = []
  let pageToken: string | undefined
  do {
    const listUrl = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/messages`
    )
    listUrl.searchParams.set('maxResults', '500')
    // Inclure aussi la Corbeille et le Spam (les doublons peuvent y être)
    listUrl.searchParams.set('includeSpamTrash', 'true')
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken)

    const res = await fetchWithTimeout(listUrl.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Gmail list error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { messages?: Array<{ id: string }>; nextPageToken?: string }
    if (data.messages) allIds.push(...data.messages.map((m) => m.id))
    pageToken = data.nextPageToken
  } while (pageToken)

  console.log(`[dedupe] ${userEmail}: ${allIds.length} messages à analyser`)

  // 2. Pour chaque ID, récupérer le header Message-ID (en parallèle par batch de 20)
  const BATCH = 20
  for (let i = 0; i < allIds.length; i += BATCH) {
    const slice = allIds.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      slice.map(async (gmailId) => {
        const detailRes = await fetchWithTimeout(
          `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/messages/${gmailId}?format=metadata&metadataHeaders=Message-ID`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (!detailRes.ok) return null
        const detail = (await detailRes.json()) as {
          id: string
          internalDate: string
          payload?: { headers?: Array<{ name: string; value: string }> }
        }
        const header = detail.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')
        if (!header) return null
        return { gmailId, internalDate: parseInt(detail.internalDate, 10), msgId: header.value }
      })
    )

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const { gmailId, internalDate, msgId } = r.value
        const arr = byMsgId.get(msgId) ?? []
        arr.push({ gmailId, internalDate })
        byMsgId.set(msgId, arr)
      }
      scanned++
    }
    if (onProgress && scanned % 500 < BATCH) onProgress(scanned, 0)
  }

  console.log(`[dedupe] ${userEmail}: ${byMsgId.size} Message-ID uniques sur ${scanned} messages scannés`)

  // 3. Supprimer les doublons (garder le plus ancien par groupe)
  let duplicatesRemoved = 0
  let errors = 0
  for (const [, entries] of byMsgId) {
    if (entries.length <= 1) continue
    entries.sort((a, b) => a.internalDate - b.internalDate)
    const toDelete = entries.slice(1) // tout sauf le plus ancien

    for (const dup of toDelete) {
      // On utilise `trash` plutôt que `delete` : compatible avec le scope gmail.modify
      // et réversible (l'user peut récupérer 30j si on s'est trompé)
      const trashRes = await fetchWithTimeout(
        `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userEmail)}/messages/${dup.gmailId}/trash`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
      )
      if (trashRes.ok) {
        duplicatesRemoved++
        if (duplicatesRemoved % 100 === 0) {
          console.log(`[dedupe] ${userEmail}: ${duplicatesRemoved} doublons supprimés…`)
          onProgress?.(scanned, duplicatesRemoved)
        }
      } else {
        errors++
      }
    }
  }

  console.log(`[dedupe] ${userEmail}: terminé — ${duplicatesRemoved} doublons supprimés, ${errors} erreurs`)
  return { scanned, duplicatesRemoved, errors }
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

// Extrait l'ID de label invalide d'un message d'erreur Gmail ("Invalid label: Label_96").
// Renvoie null si pas un cas d'invalid label.
function extractInvalidLabelId(errText: string): string | null {
  const m = errText.match(/Invalid label:\s*([A-Za-z0-9_\-]+)/)
  return m ? (m[1] ?? null) : null
}

// Retire un labelId de la liste mutable. Si elle devient vide → ['INBOX'] fallback.
// Renvoie true si quelque chose a été retiré (donc retry pertinent).
function stripLabelInPlace(labelIds: string[], badId: string): boolean {
  const idx = labelIds.indexOf(badId)
  if (idx < 0) return false
  labelIds.splice(idx, 1)
  if (labelIds.length === 0) labelIds.push('INBOX')
  return true
}

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
  // Compteur séparé pour les retries "label invalide" : on retire le label
  // fautif et on relance, sans dépenser nos attempts pour les erreurs transitoires.
  // Plafonné pour éviter une boucle infinie si Gmail rejette tous les labels.
  const MAX_LABEL_STRIPS = 10
  let labelStrips = 0
  let lastError = ''

  // Helper local : tente d'extraire un label invalide et de le retirer.
  // Retourne true si on doit relancer la boucle (label retiré).
  const handleInvalidLabel = (errText: string, source: 'insert' | 'import' | 'resumable'): boolean => {
    if (labelStrips >= MAX_LABEL_STRIPS) return false
    const badId = extractInvalidLabelId(errText)
    if (!badId) return false
    if (!stripLabelInPlace(labelIds, badId)) {
      // Le label n'était pas dans notre liste — pas la peine de boucler.
      return false
    }
    labelStrips++
    console.warn(`[mail] ${source} a rejeté le label "${badId}", retiré → retry avec ${labelIds.length} labels`)
    return true
  }

  for (let attempt = 1; attempt <= MAX_GMAIL_ATTEMPTS; attempt++) {
    const token = await getGoogleAccessTokenForUser(params.userEmail, GMAIL_SCOPE)

    // ── Gros mail : resumable upload (multipart) ──────────────────────────
    if (useResumable) {
      try {
        const result = await gmailResumableInsert(token, params.userEmail, sanitizedMime, labelIds)
        return result
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        // Label invalide → strip + retry sans dépenser d'attempt
        if (handleInvalidLabel(errMsg, 'resumable')) {
          attempt--
          continue
        }
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

    const insertRes = await fetchWithTimeout(insertUrl.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, labelIds }),
    })

    if (insertRes.ok) return (await insertRes.json()) as { id: string }

    const insertErr = await insertRes.text()

    // Label invalide (400 avec "Invalid label: Label_XX") → strip + retry
    // C'est le cas le plus fréquent des erreurs 252 vues sur Emilia : un label custom
    // existait au début du run mais a été modifié/supprimé entre temps. On enlève
    // ce label et on relance l'import — au pire le message arrive avec INBOX seul.
    if (insertRes.status === 400 && handleInvalidLabel(insertErr, 'insert')) {
      attempt--
      continue
    }

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

      const importRes = await fetchWithTimeout(importUrl.toString(), {
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
            await fetchWithTimeout(
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
      // Label invalide aussi sur import ? Strip + retry tout depuis le début
      if (importRes.status === 400 && handleInvalidLabel(importErr, 'import')) {
        attempt--
        continue
      }
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

  const res = await fetchWithTimeout(url.toString(), {
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
  const res = await fetchWithTimeout(
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
