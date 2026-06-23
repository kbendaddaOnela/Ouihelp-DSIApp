// Migration calendrier Exchange → Google Calendar
// Lecture Graph (Calendars.Read App) → Écriture Calendar API (impersonation user)

import { fetchWithTimeout } from './httpClient'
import { getGoogleAccessTokenForUser } from './googleService'
import { getOnelaToken } from './service'

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'

// Tous les utilisateurs ONELA sont en Europe/Paris (confirmé juin 2026).
// On demande à Graph de renvoyer les datetime dans CETTE timezone via le header
// `Prefer: outlook.timezone`, sinon il sert tout en UTC et un événement récurrent
// "tous les jeudis 11h Paris" devient "11h UTC" → décalage 1h selon DST.
const TARGET_TIMEZONE = 'Europe/Paris'
const GRAPH_TIMEZONE_PREFER = `outlook.timezone="${TARGET_TIMEZONE}"`

// ── Types Graph ──────────────────────────────────────────────────────────────

interface GraphDateTime {
  dateTime: string
  timeZone: string
}

interface GraphRecurrencePattern {
  type: 'daily' | 'weekly' | 'absoluteMonthly' | 'relativeMonthly' | 'absoluteYearly' | 'relativeYearly'
  interval: number
  daysOfWeek?: string[]
  dayOfMonth?: number
  month?: number
  index?: 'first' | 'second' | 'third' | 'fourth' | 'last'
  firstDayOfWeek?: string
}

interface GraphRecurrenceRange {
  type: 'noEnd' | 'endDate' | 'numbered'
  startDate: string
  endDate?: string
  numberOfOccurrences?: number
  recurrenceTimeZone?: string
}

interface GraphRecurrence {
  pattern: GraphRecurrencePattern
  range: GraphRecurrenceRange
}

interface GraphEvent {
  id: string
  iCalUId?: string
  subject?: string
  bodyPreview?: string
  body?: { contentType: 'html' | 'text'; content: string }
  start?: GraphDateTime
  end?: GraphDateTime
  isAllDay?: boolean
  isCancelled?: boolean
  location?: { displayName?: string }
  attendees?: Array<{
    emailAddress: { address: string; name?: string }
    type?: 'required' | 'optional' | 'resource'
    status?: { response?: string }
  }>
  organizer?: { emailAddress: { address: string; name?: string } }
  recurrence?: GraphRecurrence | null
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster'
  // Sensibilité Outlook : 'normal' | 'personal' | 'private' | 'confidential'
  sensitivity?: string
}

export async function countOnelaEvents(userId: string, since?: Date | null): Promise<number> {
  const token = await getOnelaToken()
  let filter = `(type eq 'singleInstance' or type eq 'seriesMaster')`
  if (since) filter += ` and lastModifiedDateTime gt ${since.toISOString()}`
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/events?$count=true&$top=1&$filter=${encodeURIComponent(filter)}`
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
  })
  if (!res.ok) throw new Error(`Graph events count error (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { '@odata.count'?: number }
  return data['@odata.count'] ?? 0
}

export async function* iterateOnelaEvents(
  userId: string,
  since?: Date | null
): AsyncGenerator<GraphEvent> {
  let filter = `(type eq 'singleInstance' or type eq 'seriesMaster')`
  if (since) filter += ` and lastModifiedDateTime gt ${since.toISOString()}`
  // $orderby est obligatoire pour une pagination stable avec $filter
  // (sinon Graph peut couper la pagination prématurément et yield seulement une partie des events)
  let url: string | null =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/events?$top=100&$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent('lastModifiedDateTime')}`
  while (url) {
    const token = await getOnelaToken()
    const res: Response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Force Graph à renvoyer les datetime en Europe/Paris (au lieu d'UTC par défaut).
        // Critique pour les seriesMaster récurrents : sans ça, "tous les jeudis 11h"
        // est stocké en UTC fixe et le DST fait dériver d'1h les occurrences d'hiver.
        Prefer: GRAPH_TIMEZONE_PREFER,
      },
    })
    if (!res.ok) throw new Error(`Graph events error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { value: GraphEvent[]; '@odata.nextLink'?: string }
    for (const ev of data.value) yield ev
    url = data['@odata.nextLink'] ?? null
  }
}

// ── Conversion Graph → Google Calendar ───────────────────────────────────────

const DAY_MAP: Record<string, string> = {
  monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH',
  friday: 'FR', saturday: 'SA', sunday: 'SU',
}

const POSITION_MAP: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, last: -1,
}

function formatRRuleDate(iso: string): string {
  // YYYY-MM-DD → YYYYMMDD ; YYYY-MM-DDTHH:MM:SSZ → YYYYMMDDTHHMMSSZ
  return iso.replace(/[-:]/g, '').split('.')[0] ?? ''
}

function graphRecurrenceToRRule(rec: GraphRecurrence): string | null {
  const p = rec.pattern
  const r = rec.range
  const parts: string[] = []

  switch (p.type) {
    case 'daily':
      parts.push('FREQ=DAILY')
      break
    case 'weekly':
      parts.push('FREQ=WEEKLY')
      if (p.daysOfWeek?.length) {
        parts.push(`BYDAY=${p.daysOfWeek.map((d) => DAY_MAP[d.toLowerCase()] ?? '').filter(Boolean).join(',')}`)
      }
      break
    case 'absoluteMonthly':
      parts.push('FREQ=MONTHLY')
      if (p.dayOfMonth) parts.push(`BYMONTHDAY=${p.dayOfMonth}`)
      break
    case 'relativeMonthly':
      parts.push('FREQ=MONTHLY')
      if (p.daysOfWeek?.length && p.index) {
        const pos = POSITION_MAP[p.index]
        const day = DAY_MAP[p.daysOfWeek[0]?.toLowerCase() ?? ''] ?? ''
        if (pos && day) parts.push(`BYDAY=${pos}${day}`)
      }
      break
    case 'absoluteYearly':
      parts.push('FREQ=YEARLY')
      if (p.month) parts.push(`BYMONTH=${p.month}`)
      if (p.dayOfMonth) parts.push(`BYMONTHDAY=${p.dayOfMonth}`)
      break
    case 'relativeYearly':
      parts.push('FREQ=YEARLY')
      if (p.month) parts.push(`BYMONTH=${p.month}`)
      if (p.daysOfWeek?.length && p.index) {
        const pos = POSITION_MAP[p.index]
        const day = DAY_MAP[p.daysOfWeek[0]?.toLowerCase() ?? ''] ?? ''
        if (pos && day) parts.push(`BYDAY=${pos}${day}`)
      }
      break
    default:
      return null
  }

  if (p.interval && p.interval > 1) parts.push(`INTERVAL=${p.interval}`)

  if (r.type === 'numbered' && r.numberOfOccurrences) {
    parts.push(`COUNT=${r.numberOfOccurrences}`)
  } else if (r.type === 'endDate' && r.endDate) {
    parts.push(`UNTIL=${formatRRuleDate(r.endDate)}T235959Z`)
  }

  return `RRULE:${parts.join(';')}`
}

interface GoogleCalendarEvent {
  summary?: string
  description?: string
  location?: string
  start: { dateTime?: string; date?: string; timeZone?: string }
  end: { dateTime?: string; date?: string; timeZone?: string }
  recurrence?: string[]
  attendees?: Array<{ email: string; displayName?: string; optional?: boolean; responseStatus?: string }>
  organizer?: { email: string; displayName?: string }
  iCalUID?: string
  status?: 'confirmed' | 'tentative' | 'cancelled'
  reminders?: { useDefault: boolean }
  visibility?: 'default' | 'public' | 'private' | 'confidential'
  colorId?: string
}

// Couleur Google Calendar pour les rdv privés (incl. rdv passés forcés en privé).
// '2' = Sauge / vert #33B679 (choix DSI, juin 2026).
const PRIVATE_EVENT_COLOR_ID = '2'

// Fin d'événement (timed ou all-day) en ms epoch, ou null si indéterminable.
function eventEndMs(g: GraphEvent): number | null {
  if (!g.end?.dateTime) return null
  // datetime en heure locale Paris sans suffixe Z ; pour un simple test "passé ?"
  // l'écart de fuseau (1-2h) est négligeable vs des events vieux de jours/années.
  const ms = new Date(g.end.dateTime.replace(/Z$/, '')).getTime()
  return Number.isNaN(ms) ? null : ms
}

function emailEq(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
}

function buildGoogleEvent(
  g: GraphEvent,
  targetUserEmail: string,
  sourceUserEmail?: string | null
): GoogleCalendarEvent | null {
  if (!g.start || !g.end) return null

  // Avec le header Prefer côté Graph, les datetime arrivent en Europe/Paris
  // (format "YYYY-MM-DDTHH:mm:ss.sssssss" sans suffixe Z). On passe la chaîne telle
  // quelle à Google + le champ timeZone — Google gère ensuite le DST par occurrence
  // pour les seriesMaster récurrents. On nettoie quand même tout suffixe Z pour
  // robustesse au cas où Graph en mettrait un sur certains events.

  const ev: GoogleCalendarEvent = {
    summary: g.subject ?? '(sans titre)',
    description: g.body?.content ?? g.bodyPreview ?? undefined,
    location: g.location?.displayName ?? undefined,
    start: g.isAllDay
      ? { date: g.start.dateTime.slice(0, 10) }
      : { dateTime: g.start.dateTime.replace(/Z$/, ''), timeZone: TARGET_TIMEZONE },
    end: g.isAllDay
      ? { date: g.end.dateTime.slice(0, 10) }
      : { dateTime: g.end.dateTime.replace(/Z$/, ''), timeZone: TARGET_TIMEZONE },
    iCalUID: g.iCalUId,
    status: g.isCancelled ? 'cancelled' : 'confirmed',
    reminders: { useDefault: true },
  }

  if (g.recurrence) {
    const rrule = graphRecurrenceToRRule(g.recurrence)
    if (rrule) ev.recurrence = [rrule]
  }

  if (g.attendees?.length) {
    ev.attendees = g.attendees
      .filter((a) => !!a.emailAddress?.address)
      .map((a) => ({
        // Mapping identité source → cible : la ligne de participation de l'utilisateur
        // migré porte son adresse @onela.com d'origine ; on la remappe vers son compte
        // Google sinon Google ne le reconnaît pas comme propriétaire du calendrier.
        email: emailEq(a.emailAddress.address, sourceUserEmail) ? targetUserEmail : a.emailAddress.address,
        // Pas de displayName : on laisse Google Calendar résoudre le nom depuis son annuaire
        // pour éviter les noms fantômes d'Exchange (contacts personnels de l'organisateur)
        optional: a.type === 'optional',
        responseStatus:
          a.status?.response === 'accepted' ? 'accepted'
          : a.status?.response === 'declined' ? 'declined'
          : a.status?.response === 'tentativelyAccepted' ? 'tentative'
          : 'needsAction',
      }))
  }

  // CRITIQUE : poser explicitement l'organisateur d'origine. Sinon Google met le
  // mailbox impersoné comme organizer par défaut → l'utilisateur croit être
  // l'organisateur de réunions auxquelles il était juste invité, et ses
  // modifs/suppressions se propagent à tous les participants.
  // MAIS si l'organisateur d'origine EST l'utilisateur migré (adresse @onela.com),
  // on remappe vers son compte Google : sinon Google rejette l'import avec
  // « participantIsNeitherOrganizerNorAttendee » (le propriétaire du calendrier doit
  // être organisateur OU participant).
  if (g.organizer?.emailAddress?.address) {
    const orgAddr = g.organizer.emailAddress.address
    ev.organizer = emailEq(orgAddr, sourceUserEmail)
      ? { email: targetUserEmail }
      : {
          email: orgAddr,
          ...(g.organizer.emailAddress.name ? { displayName: g.organizer.emailAddress.name } : {}),
        }
  } else {
    // Pas d'organizer Graph → fallback sur le user lui-même (cas rare, calendar perso)
    ev.organizer = { email: targetUserEmail }
  }

  // Filet de sécurité universel : Google exige que le propriétaire du calendrier soit
  // organisateur OU participant. Si après remapping il n'est toujours ni l'un ni l'autre
  // (ex. réunion ajoutée par un délégué, ou alias source non reconnu), on l'ajoute comme
  // participant accepté. sendUpdates=none → aucune invitation envoyée.
  const ownerIsOrganizer = emailEq(ev.organizer?.email, targetUserEmail)
  const ownerIsAttendee = ev.attendees?.some((a) => emailEq(a.email, targetUserEmail)) ?? false
  if (!ownerIsOrganizer && !ownerIsAttendee) {
    ev.attendees = [...(ev.attendees ?? []), { email: targetUserEmail, responseStatus: 'accepted' }]
  }

  // Visibilité + couleur (demande compta, juin 2026) :
  // - les rdv déjà privés dans Outlook (sensitivity private/confidential) restent privés
  // - les rdv PASSÉS non récurrents sont forcés en privé à la migration
  //   (on laisse les séries récurrentes telles quelles : une série en cours n'est pas "passée")
  // - tout rdv privé reçoit la couleur Banane pour ressortir visuellement.
  // Politique Groupe = visibilité publique par défaut → on ne touche QUE les privés/passés.
  const originallyPrivate = g.sensitivity === 'private' || g.sensitivity === 'confidential'
  const endMs = eventEndMs(g)
  const isPast = !ev.recurrence && endMs !== null && endMs < Date.now()
  if (originallyPrivate || isPast) {
    ev.visibility = 'private'
    ev.colorId = PRIVATE_EVENT_COLOR_ID
  }

  return ev
}

const CAL_MAX_RETRIES = 4

export async function googleCalendarImportEvent(
  userEmail: string,
  graphEvent: GraphEvent,
  sourceUserEmail?: string | null
): Promise<{ id: string } | null> {
  const evt = buildGoogleEvent(graphEvent, userEmail, sourceUserEmail)
  if (!evt) return null

  // import = on dépose l'événement sans envoyer d'invitations
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(userEmail)}/events/import`
  )
  url.searchParams.set('sendUpdates', 'none')

  for (let attempt = 0; attempt < CAL_MAX_RETRIES; attempt++) {
    const token = await getGoogleAccessTokenForUser(userEmail, CALENDAR_SCOPE)

    const res = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(evt),
    })

    if (res.ok) {
      return (await res.json()) as { id: string }
    }

    // 409 Conflict = event déjà importé (même iCalUID) → skip silencieux
    if (res.status === 409) {
      return { id: `duplicate-${graphEvent.id}` }
    }

    // Retry sur rate limit (403 usageLimits / 429) et erreurs transitoires (502/503)
    if ((res.status === 403 || res.status === 429 || res.status === 502 || res.status === 503) && attempt < CAL_MAX_RETRIES - 1) {
      const backoff = Math.min(1000 * Math.pow(2, attempt + 1), 16000) // 2s, 4s, 8s, 16s
      console.warn(`[calendar] ${res.status} on import (attempt ${attempt + 1}/${CAL_MAX_RETRIES}), retry in ${backoff}ms`)
      await new Promise((r) => setTimeout(r, backoff))
      continue
    }

    const err = await res.text()
    throw new Error(`Google Calendar import error (${res.status}): ${err}`)
  }

  throw new Error('Google Calendar import: max retries exceeded')
}
