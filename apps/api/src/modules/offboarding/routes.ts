// Offboarding — départ d'un collaborateur.
//
// Périmètre v1 (actions ponctuelles, chacune tracée dans `offboarding_actions`) :
//   1. rechercher l'utilisateur dans l'annuaire Google ;
//   2. changer son mot de passe sur Entra GOH (Ouihelp) — le SSO Google passe
//      par Entra, c'est donc ce mot de passe qui coupe l'accès — + révocation
//      des sessions en cours ;
//   3. déléguer sa boîte Gmail à un autre utilisateur Google (réutilise la
//      mécanique de délégation du module shared-mailbox).
//
// ⚠️ Ne PAS suspendre le compte Google ici : Gmail désactive les délégations
// d'une boîte dont le propriétaire est suspendu.

import { Hono } from 'hono'
import { desc } from 'drizzle-orm'
import { randomUUID, randomInt } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { getDb } from '../../db/index'
import { offboardingActions } from './schema'
import {
  getGoogleUser,
  searchGoogleUsers,
  listGmailDelegates,
  ensureGmailDelegate,
  removeGmailDelegate,
  type GoogleUser,
} from '../shared-mailbox/googleUserService'
import { normalizeDelegateEmail } from '../shared-mailbox/delegateService'
import { findGohUserByEmails, resetGohUserPassword, revokeGohUserSessions } from '../migration/service'
import type {
  OffboardingActionType,
  OffboardingGoogleUser,
  OffboardingSearchResponse,
  OffboardingUserDetail,
  ResetPasswordRequest,
  ResetPasswordResponse,
  AddOffboardingDelegateRequest,
  AddOffboardingDelegateResponse,
  OffboardingHistoryResponse,
} from '@dsi-app/shared'

export const offboardingRouter = new Hono<{ Variables: RbacVariables }>()

offboardingRouter.use('*', authMiddleware, loadUserRole)

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toOffboardingUser(u: GoogleUser): OffboardingGoogleUser {
  return {
    id: u.id,
    primaryEmail: u.primaryEmail,
    displayName: u.displayName,
    suspended: u.suspended,
    orgUnitPath: u.orgUnitPath,
    aliases: u.aliases,
  }
}

/**
 * Mot de passe fort lisible (sans caractères ambigus 0/O, 1/l/I) respectant la
 * complexité Entra : 16 caractères, au moins une majuscule, minuscule, chiffre
 * et symbole.
 */
function generatePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const symbols = '#$%&*+-=?@'
  const all = upper + lower + digits + symbols
  const pick = (set: string) => set[randomInt(set.length)]!
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)]
  while (chars.length < 16) chars.push(pick(all))
  // Fisher-Yates : les 4 caractères imposés ne restent pas en tête
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join('')
}

async function logAction(params: {
  targetEmail: string
  targetDisplayName: string | null
  action: OffboardingActionType
  detail: string | null
  status: 'success' | 'error'
  errorDetails?: string | null
  initiatedBy: string
}): Promise<void> {
  try {
    await getDb().insert(offboardingActions).values({
      id: randomUUID(),
      ...params,
      errorDetails: params.errorDetails ?? null,
    })
  } catch (err) {
    // Le journal ne doit jamais faire échouer l'action elle-même
    console.error('[offboarding] écriture du journal échouée:', errMsg(err))
  }
}

/** Charge le compte Google ciblé ou renvoie un message d'erreur exploitable. */
async function loadTarget(email: string | undefined): Promise<GoogleUser | string> {
  if (!email?.trim()) return 'Adresse de l’utilisateur manquante'
  const user = await getGoogleUser(email.trim())
  if (!user) return `Aucun compte Google trouvé pour ${email}`
  return user
}

// ── Recherche (annuaire Google) ──────────────────────────────────────────────
offboardingRouter.get('/search', requirePermission('offboarding:read'), async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q || q.length < 2) return c.json<OffboardingSearchResponse>({ users: [] })
  try {
    const users = await searchGoogleUsers(q)
    return c.json<OffboardingSearchResponse>({ users: users.map(toOffboardingUser) })
  } catch (err) {
    console.error('[offboarding/search] Google error:', errMsg(err))
    return c.json({ error: 'Google error', message: errMsg(err) }, 502)
  }
})

// ── Détail : Google + Entra GOH + délégations en place ──────────────────────
offboardingRouter.get('/user', requirePermission('offboarding:read'), async (c) => {
  let target: GoogleUser | string
  try {
    target = await loadTarget(c.req.query('email'))
  } catch (err) {
    return c.json({ error: 'Google error', message: errMsg(err) }, 502)
  }
  if (typeof target === 'string') return c.json({ error: 'Not Found', message: target }, 404)

  let entra: OffboardingUserDetail['entra'] = null
  let entraError: string | null = null
  try {
    entra = await findGohUserByEmails([target.primaryEmail, ...target.aliases])
  } catch (err) {
    entraError = errMsg(err)
  }

  let delegates: OffboardingUserDetail['delegates'] = []
  let delegatesError: string | null = null
  if (target.isMailboxSetup) {
    try {
      delegates = (await listGmailDelegates(target.primaryEmail)).map((d) => ({
        delegateEmail: d.delegateEmail,
        verificationStatus: d.verificationStatus ?? null,
      }))
    } catch (err) {
      delegatesError = errMsg(err)
    }
  } else {
    delegatesError = 'Boîte Gmail non provisionnée (pas de licence ?) — délégation impossible'
  }

  return c.json<OffboardingUserDetail>({
    google: { ...toOffboardingUser(target), isMailboxSetup: target.isMailboxSetup },
    entra,
    entraError,
    delegates,
    delegatesError,
  })
})

// ── Changement du mot de passe Entra GOH ─────────────────────────────────────
offboardingRouter.post('/reset-password', requirePermission('offboarding:write'), async (c) => {
  const initiatedBy = c.get('dbUser').email
  const body = await c.req.json<ResetPasswordRequest>()

  let target: GoogleUser | string
  try {
    target = await loadTarget(body.email)
  } catch (err) {
    return c.json({ error: 'Google error', message: errMsg(err) }, 502)
  }
  if (typeof target === 'string') return c.json({ error: 'Not Found', message: target }, 404)

  const password = body.password?.trim() || generatePassword()
  const revoke = body.revokeSessions ?? true

  let entraUpn = target.primaryEmail
  try {
    const entra = await findGohUserByEmails([target.primaryEmail, ...target.aliases])
    if (!entra) throw new Error(`Aucun compte Entra GOH trouvé pour ${target.primaryEmail}`)
    entraUpn = entra.userPrincipalName
    await resetGohUserPassword(entra.id, password)

    let revokeError: string | null = null
    if (revoke) {
      try {
        await revokeGohUserSessions(entra.id)
      } catch (err) {
        revokeError = errMsg(err)
      }
    }

    await logAction({
      targetEmail: target.primaryEmail,
      targetDisplayName: target.displayName,
      action: 'reset_password',
      detail: `Entra GOH ${entraUpn}${revoke ? (revokeError ? ' — révocation sessions échouée' : ' + sessions révoquées') : ''}`,
      status: 'success',
      errorDetails: revokeError,
      initiatedBy,
    })
    console.log(`[offboarding] mot de passe réinitialisé pour ${entraUpn} par ${initiatedBy}`)

    return c.json<ResetPasswordResponse>({
      entraUpn,
      password,
      sessionsRevoked: revoke && !revokeError,
      revokeError,
    })
  } catch (err) {
    let msg = errMsg(err)
    if (/Graph 403/.test(msg)) {
      msg +=
        ' — L’app GOH doit avoir la permission applicative User-PasswordProfile.ReadWrite.All' +
        ' (et un rôle privilégié si le compte cible est administrateur).'
    }
    await logAction({
      targetEmail: target.primaryEmail,
      targetDisplayName: target.displayName,
      action: 'reset_password',
      detail: `Entra GOH ${entraUpn}`,
      status: 'error',
      errorDetails: msg,
      initiatedBy,
    })
    return c.json({ error: 'Reset failed', message: msg }, 502)
  }
})

// ── Délégation de la boîte Gmail ─────────────────────────────────────────────
offboardingRouter.post('/delegates', requirePermission('offboarding:write'), async (c) => {
  const initiatedBy = c.get('dbUser').email
  const body = await c.req.json<AddOffboardingDelegateRequest>()
  if (!body.delegateEmail?.trim()) {
    return c.json({ error: 'Bad Request', message: 'Délégué manquant' }, 400)
  }

  let target: GoogleUser | string
  try {
    target = await loadTarget(body.email)
  } catch (err) {
    return c.json({ error: 'Google error', message: errMsg(err) }, 502)
  }
  if (typeof target === 'string') return c.json({ error: 'Not Found', message: target }, 404)

  let delegateEmail = body.delegateEmail.trim()
  try {
    // Résout un alias vers l'adresse primaire (exigée par l'API Gmail) + refuse un compte suspendu
    delegateEmail = (await normalizeDelegateEmail(delegateEmail)).primaryEmail
    if (delegateEmail.toLowerCase() === target.primaryEmail.toLowerCase()) {
      throw new Error('Le délégué doit être un autre utilisateur que le titulaire de la boîte')
    }
    if (target.suspended) {
      throw new Error(
        `Le compte ${target.primaryEmail} est suspendu : Gmail n’autorise pas la délégation d’une boîte suspendue. ` +
          'Réactive-le dans la console Google (le changement de mot de passe suffit à couper l’accès).',
      )
    }
    const res = await ensureGmailDelegate(target.primaryEmail, delegateEmail)
    await logAction({
      targetEmail: target.primaryEmail,
      targetDisplayName: target.displayName,
      action: 'add_delegate',
      detail: delegateEmail,
      status: 'success',
      initiatedBy,
    })
    return c.json<AddOffboardingDelegateResponse>({
      delegateEmail,
      created: res.created,
      verificationStatus: res.verificationStatus ?? null,
    })
  } catch (err) {
    await logAction({
      targetEmail: target.primaryEmail,
      targetDisplayName: target.displayName,
      action: 'add_delegate',
      detail: delegateEmail,
      status: 'error',
      errorDetails: errMsg(err),
      initiatedBy,
    })
    return c.json({ error: 'Delegation failed', message: errMsg(err) }, 502)
  }
})

offboardingRouter.delete('/delegates', requirePermission('offboarding:write'), async (c) => {
  const initiatedBy = c.get('dbUser').email
  const email = c.req.query('email')
  const delegateEmail = c.req.query('delegate')?.trim()
  if (!email || !delegateEmail) {
    return c.json({ error: 'Bad Request', message: 'Paramètres email et delegate requis' }, 400)
  }
  try {
    await removeGmailDelegate(email, delegateEmail)
    await logAction({
      targetEmail: email,
      targetDisplayName: null,
      action: 'remove_delegate',
      detail: delegateEmail,
      status: 'success',
      initiatedBy,
    })
    return c.json({ removed: delegateEmail })
  } catch (err) {
    await logAction({
      targetEmail: email,
      targetDisplayName: null,
      action: 'remove_delegate',
      detail: delegateEmail,
      status: 'error',
      errorDetails: errMsg(err),
      initiatedBy,
    })
    return c.json({ error: 'Removal failed', message: errMsg(err) }, 502)
  }
})

// ── Journal ──────────────────────────────────────────────────────────────────
offboardingRouter.get('/history', requirePermission('offboarding:read'), async (c) => {
  const rows = await getDb()
    .select()
    .from(offboardingActions)
    .orderBy(desc(offboardingActions.createdAt))
    .limit(100)
  return c.json<OffboardingHistoryResponse>({
    actions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  })
})
