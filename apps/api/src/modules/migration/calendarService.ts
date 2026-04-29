// Migration calendrier Exchange → Google Calendar
// Lecture Graph (Calendars.Read App) → Écriture Calendar API (impersonation user)

import { getGoogleAccessTokenForUser } from './googleService'

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'

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
}

export async function* iterateOnelaEvents(
  userId: string,
  since?: Date | null
): AsyncGenerator<GraphEvent> {
  const token = await onelaToken()
  // On lit la série maîtresse + les single instances. Pas les occurrences (déjà couvertes par la série maîtresse).
  let filter = `(type eq 'singleInstance' or type eq 'seriesMaster')`
  if (since) filter += ` and lastModifiedDateTime gt ${since.toISOString()}`
  let url: string | null =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/events?$top=100&$filter=${encodeURIComponent(filter)}`
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
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
  iCalUID?: string
  status?: 'confirmed' | 'tentative' | 'cancelled'
  reminders?: { useDefault: boolean }
}

function buildGoogleEvent(g: GraphEvent): GoogleCalendarEvent | null {
  if (!g.start || !g.end) return null

  const ev: GoogleCalendarEvent = {
    summary: g.subject ?? '(sans titre)',
    description: g.body?.content ?? g.bodyPreview ?? undefined,
    location: g.location?.displayName ?? undefined,
    start: g.isAllDay
      ? { date: g.start.dateTime.slice(0, 10) }
      : { dateTime: g.start.dateTime.endsWith('Z') || g.start.dateTime.includes('+') ? g.start.dateTime : g.start.dateTime + 'Z', timeZone: g.start.timeZone },
    end: g.isAllDay
      ? { date: g.end.dateTime.slice(0, 10) }
      : { dateTime: g.end.dateTime.endsWith('Z') || g.end.dateTime.includes('+') ? g.end.dateTime : g.end.dateTime + 'Z', timeZone: g.end.timeZone },
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
        email: a.emailAddress.address,
        displayName: a.emailAddress.name,
        optional: a.type === 'optional',
        responseStatus:
          a.status?.response === 'accepted' ? 'accepted'
          : a.status?.response === 'declined' ? 'declined'
          : a.status?.response === 'tentativelyAccepted' ? 'tentative'
          : 'needsAction',
      }))
  }

  return ev
}

export async function googleCalendarImportEvent(
  userEmail: string,
  graphEvent: GraphEvent
): Promise<{ id: string } | null> {
  const evt = buildGoogleEvent(graphEvent)
  if (!evt) return null

  const token = await getGoogleAccessTokenForUser(userEmail, CALENDAR_SCOPE)

  // import = on dépose l'événement sans envoyer d'invitations
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(userEmail)}/events/import`
  )
  url.searchParams.set('sendUpdates', 'none')

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(evt),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Google Calendar import error (${res.status}): ${err}`)
  }
  return (await res.json()) as { id: string }
}
