import type { Context } from 'hono'
import {
  ONELA_LOGO_PNG_B64,
  OUIHELP_LOGO_PNG_B64,
  CHROME_LOGO_PNG_B64,
} from '../assets/emailAssets'
import {
  SIG_BLOCK_PNG_B64,
  SIG_LINKEDIN_PNG_B64,
  SIG_FACEBOOK_PNG_B64,
  SIG_INSTAGRAM_PNG_B64,
} from '../assets/signatureAssets'

// Logos publics (sans auth) pour les e-mails — référencés en URL absolue car les
// images inline CID ne s'affichent pas dans Outlook Web.
const EMAIL_LOGOS: Record<string, string> = {
  'onela.png': ONELA_LOGO_PNG_B64,
  'ouihelp.png': OUIHELP_LOGO_PNG_B64,
  'chrome.png': CHROME_LOGO_PNG_B64,
  // Signature ONELA (bloc marque + icônes réseaux)
  'sig-block.png': SIG_BLOCK_PNG_B64,
  'sig-linkedin.png': SIG_LINKEDIN_PNG_B64,
  'sig-facebook.png': SIG_FACEBOOK_PNG_B64,
  'sig-instagram.png': SIG_INSTAGRAM_PNG_B64,
}

/** GET /assets/logo/:name */
export function serveEmailLogo(c: Context) {
  const b64 = EMAIL_LOGOS[c.req.param('name') ?? '']
  if (!b64) return c.json({ error: 'Not Found' }, 404)
  return c.body(Buffer.from(b64, 'base64'), 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=604800',
  })
}
