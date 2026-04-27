import { SignJWT, importPKCS8 } from 'jose'

interface TokenCache {
  token: string
  expiresAt: number
}

let googleTokenCache: TokenCache | null = null

async function getGoogleAccessToken(): Promise<string> {
  if (googleTokenCache && Date.now() < googleTokenCache.expiresAt - 60_000) {
    return googleTokenCache.token
  }

  const saEmail = process.env['GOOGLE_SA_EMAIL']
  const saPrivateKeyRaw = process.env['GOOGLE_SA_PRIVATE_KEY']
  const adminEmail = process.env['GOOGLE_ADMIN_EMAIL']

  if (!saEmail || !saPrivateKeyRaw || !adminEmail) {
    throw new Error('GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY ou GOOGLE_ADMIN_EMAIL manquant')
  }

  // Azure env vars stockent les \n comme littéraux — on les convertit en vrais sauts de ligne
  const saPrivateKey = saPrivateKeyRaw.replace(/\\n/g, '\n')

  const privateKey = await importPKCS8(saPrivateKey, 'RS256')

  const now = Math.floor(Date.now() / 1000)
  const assertion = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/admin.directory.user',
    sub: adminEmail,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(saEmail)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey)

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Google OAuth error (${res.status}): ${err}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  googleTokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return data.access_token
}

export async function googleUserExists(email: string): Promise<boolean> {
  const token = await getGoogleAccessToken()
  const res = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}?projection=basic`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return res.status === 200
}

export async function addGoogleAlias(userEmail: string, alias: string): Promise<void> {
  const token = await getGoogleAccessToken()
  const res = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(userEmail)}/aliases`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias }),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    // 409 = alias déjà existant — pas une erreur bloquante
    if (res.status === 409) return
    throw new Error(`Google alias error (${res.status}): ${err}`)
  }
}
