// Gabarits HTML du module migration : e-mail d'accès et signature Gmail ONELA.


// Base URL publique pour les logos des e-mails (images servies par l'API, car
// l'inline CID ne s'affiche pas dans Outlook Web). Priorité à CREDENTIALS_LOGO_BASE_URL,
// sinon l'origine HTTPS de la requête courante.
export function logoBaseUrl(c: { req: { header: (n: string) => string | undefined; url: string } }): string {
  const env = process.env['CREDENTIALS_LOGO_BASE_URL']?.trim()
  if (env) return env
  const host = c.req.header('host') ?? new URL(c.req.url).host
  return `https://${host}`
}

// E-mail d'accès envoyé à l'utilisateur migré (login Google + mot de passe
// temporaire + consignes de 1ʳᵉ connexion). Surchargeable via env.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
export function buildCredentialsEmail(displayName: string, gohUpn: string, tempPassword: string, logoBase: string): { subject: string; html: string } {
  const subject = process.env['CREDENTIALS_EMAIL_SUBJECT'] || 'Vos accès à votre nouvelle messagerie Google Workspace'
  const firstName = escapeHtml(displayName.split(' ')[0] || displayName)
  const login = escapeHtml(gohUpn)
  const pwd = escapeHtml(tempPassword)
  const base = logoBase.replace(/\/$/, '')
  // On n'affiche plus de bouton « se connecter » : la population agences (peu
  // technique) doit d'abord apprendre à OUVRIR Google Chrome (bureau / menu
  // Démarrer). On met donc en avant le logo Chrome + la marche à suivre. Une fois
  // connectée dans Chrome avec le compte géré, Chrome propose lui-même le profil
  // professionnel séparé (règle ProfileSeparationSettings, console d'admin Google).
  // Charte : ONELA violet #662D91 / magenta #E5007D · Ouihelp navy #10243E / vert #3ECF8E
  const html = `
<div style="margin:0;padding:0;background:#f4f4f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(17,24,39,.08);font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
        <tr><td style="height:6px;line-height:6px;font-size:0;background:#662D91;background:linear-gradient(90deg,#662D91 0%,#E5007D 50%,#3ECF8E 100%);">&nbsp;</td></tr>
        <tr><td style="padding:26px 32px 6px;text-align:center;">
          <img src="${base}/assets/logo/onela.png" alt="ONELA" width="104" style="height:auto;vertical-align:middle;" />
          <span style="color:#c4c4cc;font-size:20px;padding:0 16px;vertical-align:middle;">&#8594;</span>
          <img src="${base}/assets/logo/ouihelp.png" alt="Ouihelp" width="124" style="height:auto;vertical-align:middle;" />
        </td></tr>
        <tr><td style="padding:8px 32px 0;text-align:center;">
          <h1 style="margin:10px 0 2px;font-size:21px;color:#111827;font-weight:700;">Votre nouvelle messagerie est prête</h1>
          <p style="margin:0;color:#8b8f98;font-size:13px;">Migration vers Google&nbsp;Workspace</p>
        </td></tr>
        <tr><td style="padding:22px 32px 6px;color:#374151;font-size:14px;line-height:1.6;">
          <p style="margin:0 0 10px;">Bonjour <b>${firstName}</b>,</p>
          <p style="margin:0;">Votre boîte mail a été migrée avec succès. Voici vos accès pour votre <b>première connexion</b>&nbsp;:</p>
        </td></tr>
        <tr><td style="padding:10px 32px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf5ff;border:1px solid #ecd9fb;border-radius:12px;">
            <tr><td style="padding:18px 22px;">
              <p style="margin:0 0 3px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9333ea;">Identifiant</p>
              <p style="margin:0 0 14px;font-family:'Courier New',monospace;font-size:16px;color:#111827;word-break:break-all;">${login}</p>
              <p style="margin:0 0 3px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#9333ea;">Mot de passe temporaire</p>
              <p style="margin:0;font-family:'Courier New',monospace;font-size:16px;color:#111827;">${pwd}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:22px 32px 4px;text-align:center;">
          <img src="${base}/assets/logo/chrome.png" alt="Google Chrome" width="76" height="76" style="display:inline-block;width:76px;height:76px;" />
          <p style="margin:12px 0 0;font-size:17px;font-weight:700;color:#111827;">Ouvrez <span style="color:#1A73E8;">Google&nbsp;Chrome</span></p>
          <p style="margin:4px 0 0;color:#8b8f98;font-size:12px;line-height:1.5;">Repérez cette icône sur votre <b>bureau</b>, dans la <b>barre des tâches</b><br />ou via le <b>menu&nbsp;Démarrer</b>, puis double-cliquez dessus.</p>
        </td></tr>
        <tr><td style="padding:16px 32px 2px;color:#374151;font-size:13px;line-height:1.7;">
          <p style="margin:0 0 8px;font-weight:700;color:#111827;">Ensuite, c'est simple&nbsp;:</p>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:top;color:#E5007D;font-weight:bold;padding-right:8px;">1.</td><td style="padding-bottom:4px;">Dans Chrome, tapez <b>mail.google.com</b> dans la barre d'adresse.</td></tr>
          <tr><td style="vertical-align:top;color:#E5007D;font-weight:bold;padding-right:8px;">2.</td><td style="padding-bottom:4px;">Connectez-vous avec l'<b>identifiant</b> et le <b>mot de passe temporaire</b> ci-dessus, puis choisissez votre nouveau mot de passe personnel.</td></tr>
          <tr><td style="vertical-align:top;color:#E5007D;font-weight:bold;padding-right:8px;">3.</td><td style="padding-bottom:4px;">Chrome vous propose un <b>profil professionnel</b>&nbsp;: cliquez sur <b>«&nbsp;Continuer&nbsp;»</b> à chaque écran.</td></tr>
          <tr><td style="vertical-align:top;color:#E5007D;font-weight:bold;padding-right:8px;">4.</td><td>Votre messagerie s'ouvre. Utilisez désormais ce profil pour vos mails et vos outils ONELA.</td></tr></table>
        </td></tr>
        <tr><td style="padding:14px 32px 0;">
          <p style="margin:0;background:#fff7ed;border-left:3px solid #f59e0b;padding:11px 14px;border-radius:6px;font-size:12px;color:#92400e;line-height:1.5;">🔒 Pour votre sécurité, un nouveau mot de passe vous sera demandé dès la première connexion.</p>
        </td></tr>
        <tr><td style="padding:24px 32px 26px;text-align:center;border-top:1px solid #f0f0f2;">
          <p style="margin:18px 0 2px;color:#6b7280;font-size:12px;">Une question&nbsp;? Écrivez-nous à <a href="mailto:dsi@onela.com" style="color:#662D91;font-weight:600;">dsi@onela.com</a></p>
          <p style="margin:0;color:#b9bcc3;font-size:11px;">Service Informatique ONELA · <span style="color:#E5007D;">être bien chez soi</span></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</div>`.trim()
  return { subject, html }
}

// Adresse du siège (pas de téléphone — tout le monde n'a pas de ligne).
export const SIG_HQ = { adresse: '8 rue François Ory', cpVille: '92120 Montrouge', tel: '' }

// Signature ONELA fidèle au modèle validé Marketing (bloc gauche + bloc texte +
// icônes réseaux). Images servies en URL publique (base). Lignes vides masquées.
export function buildSignatureHtml(p: { name: string; poste: string; tel: string; adresse: string; cpVille: string; email: string; base: string }): string {
  const base = p.base.replace(/\/$/, '')
  const e = escapeHtml
  const maps = (q: string) => `https://www.google.com/maps/search/${encodeURIComponent(q)}`
  const localPart = e(p.email.split('@')[0] ?? p.email)
  const domain = e(p.email.split('@')[1] ?? 'onela.com')
  const telLine = p.tel ? `<div style="font-size:10pt;color:#595857;">${e(p.tel)}</div>` : ''
  const addrLines = p.adresse && p.cpVille
    ? `<div style="font-size:8pt;"><a href="${maps(`${p.adresse} ${p.cpVille}`)}" target="_blank" style="color:#1155CC;text-decoration:none;">${e(p.adresse)}</a></div>`
      + `<div style="font-size:8pt;"><a href="${maps(`${p.adresse} ${p.cpVille}`)}" target="_blank" style="color:#1155CC;text-decoration:none;">${e(p.cpVille)}</a></div>`
    : ''
  return `<table cellspacing="0" cellpadding="0" style="background:#fff;border-collapse:collapse;">
 <tr style="height:67.5pt">
  <td width="162" rowspan="2" style="border-right:1px solid #623D8F;padding:3px;vertical-align:top;">
    <a href="https://www.onela.com/" target="_blank"><img src="${base}/assets/logo/sig-block.png" width="140" height="106" border="0" style="display:block" alt="ONELA - être bien chez soi"></a>
  </td>
  <td style="padding:3px 3px 3px 10px;vertical-align:top;font-family:'Century Gothic',Arial,sans-serif;">
    <div><b style="font-size:11pt;color:#623D8F;">${e(p.name)}</b></div>
    ${p.poste ? `<div><b style="font-size:9pt;color:#595857;">${e(p.poste)}</b></div>` : ''}
    ${telLine}
    ${addrLines}
    <div style="font-size:8pt;"><a href="mailto:${e(p.email)}" target="_blank" style="color:#0563C1;"><u>${localPart}</u>@${domain}</a></div>
  </td>
 </tr>
 <tr style="height:16.5pt">
  <td style="padding:3px 3px 3px 10px;vertical-align:top;">
    <a href="https://www.linkedin.com/company/onela-etre-bien-chez-soi/" target="_blank"><img src="${base}/assets/logo/sig-linkedin.png" width="12" height="12" border="0" style="margin-right:5px" alt="LinkedIn"></a>
    <a href="https://www.facebook.com/people/ONELA/100076338856489/" target="_blank"><img src="${base}/assets/logo/sig-facebook.png" width="13" height="13" border="0" style="margin-right:5px" alt="Facebook"></a>
    <a href="https://www.instagram.com/onela_france/" target="_blank"><img src="${base}/assets/logo/sig-instagram.png" width="13" height="13" border="0" alt="Instagram"></a>
  </td>
 </tr>
</table>`
}

// Adresse d'envoi « nouveau format » prenom.nom@onela.com (ou domaine onelaUpn).
export function newFormatEmail(gohUpn: string, onelaUpn: string): string {
  const local = gohUpn.split('@')[0] ?? gohUpn
  const domain = onelaUpn.split('@')[1] ?? 'onela.com'
  return `${local}@${domain}`
}
