// Migration contacts Exchange → Google Contacts (People API)
// Lecture Graph (Contacts.Read App) → Écriture People API (impersonation user)

import { getGoogleAccessTokenForUser } from './googleService'

const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts'

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

export async function* iterateOnelaContacts(
  userId: string,
  since?: Date | null
): AsyncGenerator<GraphContact> {
  const token = await onelaToken()
  const filter = since ? `&$filter=lastModifiedDateTime gt ${since.toISOString()}` : ''
  let url: string | null =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/contacts?$top=100${filter}`
  while (url) {
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

export async function googlePeopleCreateContact(
  userEmail: string,
  contact: GraphContact
): Promise<{ resourceName: string }> {
  const token = await getGoogleAccessTokenForUser(userEmail, CONTACTS_SCOPE)
  const payload = buildPeoplePayload(contact)

  const res = await fetch('https://people.googleapis.com/v1/people:createContact', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Google People create error (${res.status}): ${err}`)
  }
  return (await res.json()) as { resourceName: string }
}
