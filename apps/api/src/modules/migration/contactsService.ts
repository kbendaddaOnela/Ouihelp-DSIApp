// Migration contacts Exchange → Google Contacts (People API)
// Lecture Graph (Contacts.Read App) → Écriture People API (impersonation user)

import { getGoogleAccessTokenForUser } from './googleService'
import { getOnelaToken } from './service'

const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts'

interface GraphContact {
  id: string
  displayName?: string
  givenName?: string
  surname?: string
  middleName?: string
  nickName?: string
  title?: string
  companyName?: string
  jobTitle?: string
  department?: string
  emailAddresses?: Array<{ address: string; name?: string }>
  businessPhones?: string[]
  homePhones?: string[]
  mobilePhone?: string
  homeAddress?: { street?: string; city?: string; state?: string; postalCode?: string; countryOrRegion?: string }
  businessAddress?: { street?: string; city?: string; state?: string; postalCode?: string; countryOrRegion?: string }
  birthday?: string
  personalNotes?: string
}

export async function countOnelaContacts(userId: string, since?: Date | null): Promise<number> {
  const token = await getOnelaToken()
  const filter = since ? `&$filter=lastModifiedDateTime gt ${since.toISOString()}` : ''
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/contacts?$count=true&$top=1${filter}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
  })
  if (!res.ok) throw new Error(`Graph contacts count error (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { '@odata.count'?: number }
  return data['@odata.count'] ?? 0
}

export async function* iterateOnelaContacts(
  userId: string,
  since?: Date | null
): AsyncGenerator<GraphContact> {
  const filter = since ? `&$filter=lastModifiedDateTime gt ${since.toISOString()}` : ''
  // $orderby pour une pagination stable avec $filter (sinon Graph peut couper prématurément)
  let url: string | null =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/contacts?$top=100${filter}&$orderby=${encodeURIComponent('lastModifiedDateTime')}`
  while (url) {
    const token = await getOnelaToken()
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Graph contacts error (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { value: GraphContact[]; '@odata.nextLink'?: string }
    for (const c of data.value) yield c
    url = data['@odata.nextLink'] ?? null
  }
}

interface PeoplePersonPayload {
  names?: Array<{ givenName?: string; familyName?: string; middleName?: string; honorificPrefix?: string }>
  nicknames?: Array<{ value: string }>
  emailAddresses?: Array<{ value: string }>
  phoneNumbers?: Array<{ value: string; type?: string }>
  addresses?: Array<{ streetAddress?: string; city?: string; region?: string; postalCode?: string; country?: string; type?: string }>
  organizations?: Array<{ name?: string; title?: string; department?: string }>
  birthdays?: Array<{ date: { year?: number; month: number; day: number } }>
  biographies?: Array<{ value: string; contentType: 'TEXT_PLAIN' }>
}

function buildPeoplePayload(c: GraphContact): PeoplePersonPayload {
  const p: PeoplePersonPayload = {}

  if (c.givenName || c.surname || c.middleName || c.title) {
    p.names = [{
      givenName: c.givenName,
      familyName: c.surname,
      middleName: c.middleName,
      honorificPrefix: c.title,
    }]
  }
  if (c.nickName) p.nicknames = [{ value: c.nickName }]

  if (c.emailAddresses?.length) {
    p.emailAddresses = c.emailAddresses
      .filter((e) => !!e.address)
      .map((e) => ({ value: e.address }))
  }

  const phones: Array<{ value: string; type?: string }> = []
  for (const ph of c.businessPhones ?? []) phones.push({ value: ph, type: 'work' })
  for (const ph of c.homePhones ?? []) phones.push({ value: ph, type: 'home' })
  if (c.mobilePhone) phones.push({ value: c.mobilePhone, type: 'mobile' })
  if (phones.length) p.phoneNumbers = phones

  const addresses: NonNullable<PeoplePersonPayload['addresses']> = []
  if (c.homeAddress && Object.keys(c.homeAddress).length) {
    addresses.push({
      streetAddress: c.homeAddress.street,
      city: c.homeAddress.city,
      region: c.homeAddress.state,
      postalCode: c.homeAddress.postalCode,
      country: c.homeAddress.countryOrRegion,
      type: 'home',
    })
  }
  if (c.businessAddress && Object.keys(c.businessAddress).length) {
    addresses.push({
      streetAddress: c.businessAddress.street,
      city: c.businessAddress.city,
      region: c.businessAddress.state,
      postalCode: c.businessAddress.postalCode,
      country: c.businessAddress.countryOrRegion,
      type: 'work',
    })
  }
  if (addresses.length) p.addresses = addresses

  if (c.companyName || c.jobTitle || c.department) {
    p.organizations = [{
      name: c.companyName,
      title: c.jobTitle,
      department: c.department,
    }]
  }

  if (c.birthday) {
    const d = new Date(c.birthday)
    if (!isNaN(d.getTime())) {
      p.birthdays = [{ date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } }]
    }
  }

  if (c.personalNotes) {
    p.biographies = [{ value: c.personalNotes, contentType: 'TEXT_PLAIN' }]
  }

  return p
}

const CONTACTS_MAX_RETRIES = 4

export async function googlePeopleCreateContact(
  userEmail: string,
  contact: GraphContact
): Promise<{ resourceName: string }> {
  const payload = buildPeoplePayload(contact)

  for (let attempt = 0; attempt < CONTACTS_MAX_RETRIES; attempt++) {
    const token = await getGoogleAccessTokenForUser(userEmail, CONTACTS_SCOPE)

    const res = await fetch('https://people.googleapis.com/v1/people:createContact', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (res.ok) {
      return (await res.json()) as { resourceName: string }
    }

    // Retry sur rate limit (403/429) et erreurs transitoires (502/503)
    if ((res.status === 403 || res.status === 429 || res.status === 502 || res.status === 503) && attempt < CONTACTS_MAX_RETRIES - 1) {
      const backoff = Math.min(1000 * Math.pow(2, attempt + 1), 16000)
      console.warn(`[contacts] ${res.status} on create (attempt ${attempt + 1}/${CONTACTS_MAX_RETRIES}), retry in ${backoff}ms`)
      await new Promise((r) => setTimeout(r, backoff))
      continue
    }

    const err = await res.text()
    throw new Error(`Google People create error (${res.status}): ${err}`)
  }

  throw new Error('Google People create: max retries exceeded')
}
