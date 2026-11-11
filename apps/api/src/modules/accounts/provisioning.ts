// Tâches de fond de la création de compte (lancées par les routes, sans worker) :
// provisioning Entra GOH + routage ONELA, puis finalisation côté Google.
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/index'
import { accountCreations } from './schema'
import { createGohUser, setGohUserAttributes, setGohUserManager, checkGohUserExists } from '../../integrations/microsoft/tenantDirectory'
import { googleUserExists, moveUserToOu, addGoogleAlias } from '../../integrations/google/directory'
import { ensureSendAs, setSendAsAsDefault } from '../../integrations/google/gmailSettings'
import { ensureGmailDelegate } from '../../integrations/google/users'
import { assignLicense, skuDisplayName } from '../../integrations/google/licensing'
import { ensureOnelaRouting } from './onelaRoutingService'
import { onelaContacts } from '../onela-contacts/schema'
import { pushContactsToUser } from '../onela-contacts/service'
import type { ParsedContact } from '../onela-contacts/service'

export function parseDelegateMailboxes(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

// ── Provisioning background : GOH → attributs → routage ONELA ─────────────────
export interface ProvisionParams {
  firstName: string
  lastName: string
  displayName: string
  gohUpn: string
  onelaUpn: string
  department: string
  jobTitle: string
  managerUpn: string | null
  officeLocation: string | null
  state: string | null
  streetAddress: string | null
  postalCode: string | null
  city: string | null
  password: string
  forceChangePassword: boolean
}

export async function provisionBackground(id: string, p: ProvisionParams) {
  const db = getDb()
  const [current] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!current) {
    console.error(`[accounts] ${id} introuvable, abandon`)
    return
  }

  const localPart = p.gohUpn.split('@')[0] ?? ''
  const ext10 = `${localPart}@onela.fr`
  const ext11 = p.onelaUpn

  // ── Étape 1 : créer le compte GOH ──
  let gohUserId: string | null = current.gohUserId
  if (current.stepCreateGoh !== 'success') {
    await db.update(accountCreations).set({ stepCreateGoh: 'running' }).where(eq(accountCreations.id, id))
    try {
      if (await checkGohUserExists(p.gohUpn)) {
        throw new Error(`Le compte ${p.gohUpn} existe déjà dans Entra GOH`)
      }
      const gohUser = await createGohUser({
        givenName: p.firstName,
        surname: p.lastName,
        upn: p.gohUpn,
        displayName: p.displayName,
        department: p.department,
        jobTitle: p.jobTitle,
        tempPassword: p.password,
        officeLocation: p.officeLocation,
        streetAddress: p.streetAddress,
        postalCode: p.postalCode,
        city: p.city,
        state: p.state,
        usageLocation: 'FR',
        country: 'France',
        preferredLanguage: 'fr-FR',
        forceChangePassword: p.forceChangePassword,
      })
      gohUserId = gohUser.id
      await db.update(accountCreations)
        .set({ gohUserId, stepCreateGoh: 'success', errorDetails: null })
        .where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} createGoh error:`, msg)
      await db.update(accountCreations).set({ stepCreateGoh: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  // ── Étape 2 : attributs (ext10/ext11) + manager ──
  if (current.stepSetAttributes !== 'success') {
    if (!gohUserId) {
      await db.update(accountCreations).set({ stepSetAttributes: 'error', errorDetails: 'gohUserId manquant' }).where(eq(accountCreations.id, id))
      return
    }
    await db.update(accountCreations).set({ stepSetAttributes: 'running' }).where(eq(accountCreations.id, id))
    try {
      await setGohUserAttributes(gohUserId, ext10, ext11)
      // Manager : optionnel et non bloquant (le manager peut ne pas encore exister dans GOH)
      if (p.managerUpn) {
        try {
          await setGohUserManager(gohUserId, p.managerUpn)
        } catch (mErr) {
          console.warn(`[accounts] ${id} manager non appliqué (${p.managerUpn}):`, mErr instanceof Error ? mErr.message : String(mErr))
        }
      }
      await db.update(accountCreations).set({ stepSetAttributes: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} setAttributes error:`, msg)
      await db.update(accountCreations).set({ stepSetAttributes: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  // ── Étape 3 : objet de routage Exchange ONELA (onela.com → Google) ──
  if (current.stepOnelaRouting !== 'success') {
    await db.update(accountCreations).set({ stepOnelaRouting: 'running' }).where(eq(accountCreations.id, id))
    console.log(`[accounts] ${id} step3 routage ONELA: start (${p.onelaUpn})`)
    try {
      // Garde-fou : l'étape ne peut pas rester bloquée. Si ensureOnelaRouting ne
      // rend pas la main sous 100 s, on force l'échec (au lieu de figer 'running').
      const watchdog = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('Timeout routage ONELA (>100s) — voir logs [routing] pour le cmdlet en cause')), 100_000),
      )
      const r = await Promise.race([
        ensureOnelaRouting({
          displayName: p.displayName,
          firstName: p.firstName,
          lastName: p.lastName,
          onelaAddress: p.onelaUpn,
          department: p.department,
          jobTitle: p.jobTitle,
          officeLocation: p.officeLocation,
          state: p.state,
          streetAddress: p.streetAddress,
          postalCode: p.postalCode,
          city: p.city,
        }),
        watchdog,
      ])
      console.log(`[accounts] ${id} step3 routage ONELA: OK (${r.routingAddress}, created=${r.created})`)
      await db.update(accountCreations).set({ stepOnelaRouting: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} onelaRouting error:`, msg)
      await db.update(accountCreations).set({ stepOnelaRouting: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  console.log(`[accounts] ${id} provisioning OK (${p.gohUpn}) → finalisation Google en attente du SCIM`)
  // Enchaîner sur la finalisation Google (polling SCIM)
  void finalizeGoogleBackground(id)
}

// ── Finalisation Google : attente SCIM puis OU /onela.com + alias + send-as ──
const SCIM_POLL_INTERVAL_MS = 60_000 // 1 min
const SCIM_MAX_ATTEMPTS = 45 // ~45 min

export async function finalizeGoogleBackground(id: string) {
  const db = getDb()
  const [row] = await db.select().from(accountCreations).where(eq(accountCreations.id, id))
  if (!row) return

  const ouPath = process.env['GOOGLE_ONELA_OU_PATH'] ?? '/onela.com'
  const gohUpn = row.gohUpn
  const onelaUpn = row.onelaUpn

  // 1. Attendre que le compte remonte dans Google (SCIM, 5-40 min)
  if (row.stepGoogleProvision !== 'success') {
    await db.update(accountCreations).set({ stepGoogleProvision: 'running' }).where(eq(accountCreations.id, id))
    let provisioned = false
    for (let attempt = 0; attempt < SCIM_MAX_ATTEMPTS; attempt++) {
      try {
        if (await googleUserExists(gohUpn)) { provisioned = true; break }
      } catch (err) {
        console.warn(`[accounts] ${id} check-google échec (tentative ${attempt + 1}):`, err instanceof Error ? err.message : String(err))
      }
      await new Promise((r) => setTimeout(r, SCIM_POLL_INTERVAL_MS))
    }
    if (!provisioned) {
      await db.update(accountCreations).set({
        stepGoogleProvision: 'error',
        errorDetails: `Compte ${gohUpn} toujours absent de Google après ~${SCIM_MAX_ATTEMPTS} min — relance "Finaliser sur Google" plus tard.`,
      }).where(eq(accountCreations.id, id))
      return
    }
    await db.update(accountCreations).set({ stepGoogleProvision: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
  }

  // 2. Bascule sur l'OU /onela.com
  if (row.stepOuMove !== 'success') {
    await db.update(accountCreations).set({ stepOuMove: 'running' }).where(eq(accountCreations.id, id))
    try {
      await moveUserToOu(gohUpn, ouPath)
      await db.update(accountCreations).set({ stepOuMove: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} moveOu error:`, msg)
      await db.update(accountCreations).set({ stepOuMove: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  // 2bis. Attribution de licence Google Workspace (l'auto-attribution par OU est
  //       coupée). Sans licence, Gmail n'est pas provisionné → send-as/contacts
  //       échoueraient. Étape placée avant l'alias/send-as. Non bloquante : une
  //       erreur n'empêche pas les étapes suivantes de tenter leur chance.
  if (row.stepLicense !== 'success') {
    if (!row.licenseSkuId) {
      await db.update(accountCreations).set({ stepLicense: 'skipped' }).where(eq(accountCreations.id, id))
      console.log(`[accounts] ${id} licence: aucune sélectionnée → skipped`)
    } else {
      await db.update(accountCreations).set({ stepLicense: 'running', licenseError: null }).where(eq(accountCreations.id, id))
      try {
        const productId = row.licenseProductId || 'Google-Apps'
        await assignLicense(gohUpn, productId, row.licenseSkuId)
        await db.update(accountCreations).set({
          stepLicense: 'success',
          licenseSkuName: skuDisplayName(row.licenseSkuId),
          licenseError: null,
        }).where(eq(accountCreations.id, id))
        console.log(`[accounts] ${id} licence attribuée (${skuDisplayName(row.licenseSkuId)}) à ${gohUpn}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[accounts] ${id} licence error:`, msg)
        await db.update(accountCreations).set({ stepLicense: 'error', licenseError: msg }).where(eq(accountCreations.id, id))
        // Non bloquant : on continue (send-as réessaiera, et la licence est relançable).
      }
    }
  }

  // 3. Alias prenom.nom@onela.com (le compte reçoit dès que c'est fait)
  if (row.stepNewFormat !== 'success') {
    await db.update(accountCreations).set({ stepNewFormat: 'running' }).where(eq(accountCreations.id, id))
    try {
      await addGoogleAlias(gohUpn, onelaUpn) // 409 (déjà présent) ignoré côté service
      await db.update(accountCreations).set({ stepNewFormat: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} alias error:`, msg)
      await db.update(accountCreations).set({ stepNewFormat: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      return
    }
  }

  // 4. Send-as par défaut (étape séparée : Gmail doit être initialisé, ce qui peut
  //    lagguer après la création/bascule d'OU → on retry, et ça ne bloque pas l'alias).
  if (row.stepSendAs !== 'success') {
    await db.update(accountCreations).set({ stepSendAs: 'running' }).where(eq(accountCreations.id, id))
    try {
      // Erreurs transitoires Gmail : mailbox pas encore prête (failedPrecondition) ou
      // alias pas encore propagé (invalidArgument). On réessaie ~3 min.
      let done = false
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 9 && !done; attempt++) {
        try {
          await ensureSendAs(gohUpn, onelaUpn, row.displayName)
          done = true
        } catch (sErr) {
          lastErr = sErr
          const m = sErr instanceof Error ? sErr.message : String(sErr)
          const transient = /not a valid user or group|invalidArgument|INVALID_ARGUMENT|Precondition check failed|failedPrecondition|FAILED_PRECONDITION/i.test(m)
          if (!transient) throw sErr
          console.warn(`[accounts] ${id} send-as pas encore prêt (tentative ${attempt + 1}/9), retry dans 20s`)
          await new Promise((r) => setTimeout(r, 20_000))
        }
      }
      if (!done) {
        const m = lastErr instanceof Error ? lastErr.message : String(lastErr)
        throw new Error(`Boîte Gmail pas encore prête pour le send-as (peut prendre quelques minutes) — reclique « Finaliser sur Google » un peu plus tard. Détail : ${m}`)
      }
      try {
        await setSendAsAsDefault(gohUpn, onelaUpn)
      } catch (dErr) {
        console.warn(`[accounts] ${id} setDefault non bloquant:`, dErr instanceof Error ? dErr.message : String(dErr))
      }
      await db.update(accountCreations).set({ stepSendAs: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
      console.log(`[accounts] ${id} send-as OK (${gohUpn} → ${onelaUpn})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} sendAs error:`, msg)
      await db.update(accountCreations).set({ stepSendAs: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
      // Non bloquant pour l'étape 8 : on continue.
    }
  }

  // 5. Import de l'annuaire ONELA dans les contacts Google du nouvel utilisateur
  //    (même mécanique que l'étape 8 de la migration : groupe « ONELA » + People API).
  if (row.stepContactsOnela !== 'success') {
    await db.update(accountCreations).set({ stepContactsOnela: 'running' }).where(eq(accountCreations.id, id))
    try {
      const rows = await db.select().from(onelaContacts)
      if (rows.length === 0) {
        // Rien à importer (annuaire pas encore importé via le module onela-contacts) → on n'échoue pas.
        await db.update(accountCreations).set({ stepContactsOnela: 'skipped' }).where(eq(accountCreations.id, id))
        console.log(`[accounts] ${id} contacts ONELA: aucun contact en base → skipped`)
      } else {
        const contacts: ParsedContact[] = rows.map((r) => ({
          givenName: r.givenName,
          familyName: r.familyName,
          organization: r.organization,
          title: r.title,
          email: r.email,
          phone: r.phone,
        }))
        const result = await pushContactsToUser(gohUpn, contacts)
        await db.update(accountCreations).set({ stepContactsOnela: 'success', errorDetails: null }).where(eq(accountCreations.id, id))
        console.log(`[accounts] ${id} contacts ONELA importés: ${result.created} créés, ${result.skipped} déjà présents, ${result.errors} erreurs`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[accounts] ${id} contactsOnela error:`, msg)
      await db.update(accountCreations).set({ stepContactsOnela: 'error', errorDetails: msg }).where(eq(accountCreations.id, id))
    }
  }

  // 6. Délégations Gmail : le nouvel arrivant devient délégué des boîtes partagées
  //    migrées sélectionnées (mailboxEmail = compte Google de la boîte, délégué =
  //    adresse primaire du nouvel arrivant). Idempotent, non bloquant par boîte.
  if (row.stepDelegations !== 'success') {
    const targets = parseDelegateMailboxes(row.delegateMailboxes) ?? []
    if (targets.length === 0) {
      await db.update(accountCreations).set({ stepDelegations: 'skipped' }).where(eq(accountCreations.id, id))
      console.log(`[accounts] ${id} délégations: aucune boîte sélectionnée → skipped`)
    } else {
      await db.update(accountCreations).set({ stepDelegations: 'running' }).where(eq(accountCreations.id, id))
      const failures: string[] = []
      for (const mailbox of targets) {
        try {
          // Erreurs transitoires (compte délégué pas encore pleinement propagé) → quelques retries.
          let done = false
          let lastErr: unknown = null
          for (let attempt = 0; attempt < 5 && !done; attempt++) {
            try {
              const r = await ensureGmailDelegate(mailbox, gohUpn)
              console.log(`[accounts] ${id} délégation ${gohUpn} sur ${mailbox}: ${r.created ? 'créée' : 'déjà présente'}${r.verificationStatus ? ` (${r.verificationStatus})` : ''}`)
              done = true
            } catch (dErr) {
              lastErr = dErr
              const m = dErr instanceof Error ? dErr.message : String(dErr)
              const transient = /not a valid user or group|invalidArgument|INVALID_ARGUMENT|Precondition check failed|failedPrecondition|FAILED_PRECONDITION|more delegates/i.test(m)
              if (!transient) throw dErr
              console.warn(`[accounts] ${id} délégation ${mailbox} pas encore prête (tentative ${attempt + 1}/5), retry dans 20s`)
              await new Promise((r) => setTimeout(r, 20_000))
            }
          }
          if (!done) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[accounts] ${id} délégation ${mailbox} échouée:`, msg)
          failures.push(`${mailbox}: ${msg}`)
        }
      }
      if (failures.length === 0) {
        await db.update(accountCreations).set({ stepDelegations: 'success', delegationsError: null }).where(eq(accountCreations.id, id))
        console.log(`[accounts] ${id} délégations OK (${targets.length} boîte(s))`)
      } else {
        await db.update(accountCreations).set({
          stepDelegations: 'error',
          delegationsError: `${failures.length}/${targets.length} délégation(s) en échec — ${failures.join(' | ')}`,
        }).where(eq(accountCreations.id, id))
      }
    }
  }

  console.log(`[accounts] ${id} finalisation Google terminée (${gohUpn})`)
}
