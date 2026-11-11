// Données : mail / calendrier / contacts (lancement, arrêt, reprise, réparation, erreurs).
import { Hono } from 'hono'
import { eq, desc, and } from 'drizzle-orm'
import { requirePermission } from '../../../middleware/rbac'
import type { RbacVariables } from '../../../middleware/rbac'
import { getDb } from '../../../db/index'
import { migrations, migratedMessages, migratedEvents, migratedContacts } from '../schema'
import { enqueueMailMigration, enqueueCalendarMigration, enqueueContactsMigration, signalStop, relabelMail } from '../mailWorker'
import { gmailDedupeMailbox, fetchOnelaMessageMime, gmailImportMime } from '../mailService'
import { serializeMigration } from '../serializers'

export const dataMigrationRoutes = new Hono<{ Variables: RbacVariables }>()

// ── Lancer la migration mail (worker en background) ──────────────────────────
dataMigrationRoutes.post('/:id/migrate-mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration de compte non réussie, mail impossible' }, 400)
  }
  if (row.stepMailMigration === 'running' || row.stepMailMigration === 'pending') {
    return c.json({ error: 'Migration mail déjà en cours' }, 409)
  }

  // Sens du parcours : 'desc' = récents d'abord (défaut), 'asc' = anciens d'abord.
  // beforeDays (optionnel) : ne migrer que les mails reçus il y a plus de N jours
  // (passe « anciens » bornée à J-N). Borné à [1, 3650] ; sinon pas de plafond.
  const body = await c.req.json<{ order?: string; beforeDays?: number }>().catch(() => ({} as { order?: string; beforeDays?: number }))
  const order: 'asc' | 'desc' = body.order === 'asc' ? 'asc' : 'desc'
  const beforeDays =
    typeof body.beforeDays === 'number' && Number.isFinite(body.beforeDays) && body.beforeDays >= 1
      ? Math.min(Math.floor(body.beforeDays), 3650)
      : null

  await enqueueMailMigration(id, order, beforeDays)
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated), 202)
})

// ── Lancer migration calendrier ──────────────────────────────────────────────
dataMigrationRoutes.post('/:id/migrate-calendar', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration de compte non réussie' }, 400)
  }
  if (row.stepCalendarMigration === 'running' || row.stepCalendarMigration === 'pending') {
    return c.json({ error: 'Migration calendrier déjà en cours' }, 409)
  }
  await enqueueCalendarMigration(id)
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated), 202)
})

// ── Lancer migration contacts ────────────────────────────────────────────────
dataMigrationRoutes.post('/:id/migrate-contacts', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if ((row.stepCreateAccount !== 'success' && row.stepCreateAccount !== 'skipped') || !row.gohUpn) {
    return c.json({ error: 'Migration de compte non réussie' }, 400)
  }
  if (row.stepContactsMigration === 'running' || row.stepContactsMigration === 'pending') {
    return c.json({ error: 'Migration contacts déjà en cours' }, 409)
  }
  await enqueueContactsMigration(id)
  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated), 202)
})

// ── Re-labelliser les messages déjà migrés (corrige les labels sans re-migrer) ──
dataMigrationRoutes.post('/:id/relabel-mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)

  // Mettre un statut temporaire pour indiquer que c'est en cours
  await db.update(migrations).set({ mailError: 'Re-labellisation en cours…' }).where(eq(migrations.id, id))

  // Lancer en background (ne bloque pas la réponse HTTP)
  relabelMail(id)
    .then(async (result) => {
      let msg: string
      if (result.errors > 0) {
        const samples = result.errorSamples.length > 0
          ? ` — Ex: ${result.errorSamples[0]?.slice(0, 100)}`
          : ''
        msg = `Re-labellisation : ${result.relabeled} corrigés, ${result.skipped} ignorés, ${result.errors} erreurs${samples}`
      } else {
        msg = `Re-labellisation terminée : ${result.relabeled} corrigés, ${result.skipped} ignorés`
      }
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })
    .catch(async (err) => {
      const msg = `Re-labellisation échouée : ${err instanceof Error ? err.message : String(err)}`
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })

  return c.json({ message: 'Re-labellisation lancée en background' }, 202)
})

// ── Déduplication Gmail : nettoie les doublons par Message-ID ───────────────
// Scanne toute la mailbox, groupe par Message-ID RFC822 et envoie les doublons
// à la Corbeille (purge auto 30j, donc réversible si erreur).
dataMigrationRoutes.post('/:id/dedupe-mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)

  await db.update(migrations).set({ mailError: 'Déduplication Gmail en cours…' }).where(eq(migrations.id, id))

  gmailDedupeMailbox(row.gohUpn, async (scanned, removed) => {
    const msg = `Déduplication : ${scanned} scannés, ${removed} doublons supprimés…`
    await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
  })
    .then(async (result) => {
      const msg = `Déduplication terminée : ${result.duplicatesRemoved} doublons supprimés sur ${result.scanned} messages scannés${result.errors > 0 ? ` (${result.errors} erreurs)` : ''}`
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })
    .catch(async (err) => {
      const msg = `Déduplication échouée : ${err instanceof Error ? err.message : String(err)}`
      await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
    })

  return c.json({ message: 'Déduplication lancée en background' }, 202)
})

// ── Réessayer uniquement les messages mail en erreur ────────────────────────
// Fast lane : on force labelIds=['INBOX'] pour éviter la résolution de labels
// custom qui causait justement les erreurs "Invalid label: Label_XX". Les
// messages atterrissent dans la boîte de réception Gmail, l'utilisateur peut
// ensuite cliquer "Re-labelliser" pour leur remettre la hiérarchie propre.
dataMigrationRoutes.post('/:id/retry-errors/mail', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)
  const gohUpn = row.gohUpn
  const onelaUserId = row.onelaUserId

  // Lister les messages en erreur (sans rien charger d'autre)
  const errors = await db
    .select({
      id: migratedMessages.id,
      graphMessageId: migratedMessages.graphMessageId,
      internetMessageId: migratedMessages.internetMessageId,
      subject: migratedMessages.subject,
      receivedAt: migratedMessages.receivedAt,
    })
    .from(migratedMessages)
    .where(and(eq(migratedMessages.migrationId, id), eq(migratedMessages.status, 'error')))

  if (errors.length === 0) {
    return c.json({ message: 'Aucune erreur à réessayer', count: 0 }, 200)
  }

  await db.update(migrations).set({ mailError: `Reprise des erreurs : 0/${errors.length}…` }).where(eq(migrations.id, id))

  // Background — pas de blocage HTTP
  ;(async () => {
    let recovered = 0
    let stillFailed = 0
    const total = errors.length
    const startedAt = Date.now()
    console.log(`[retry-errors] ${id}: démarrage sur ${total} messages → INBOX`)

    for (let i = 0; i < errors.length; i++) {
      const msg = errors[i]!
      try {
        const rawMime = await fetchOnelaMessageMime(onelaUserId, msg.graphMessageId)
        // Fast lane : INBOX direct, pas de label custom — atterrit en boîte
        // de réception même si la hiérarchie a changé. "Re-labelliser" peut
        // ensuite remettre les labels propres sans re-télécharger les MIME.
        const result = await gmailImportMime({
          userEmail: gohUpn,
          rawMime,
          labelIds: ['INBOX'],
        })
        await db.update(migratedMessages)
          .set({ status: 'success', gmailMessageId: result.id, errorDetails: null })
          .where(eq(migratedMessages.id, msg.id))
        recovered++
        // Recompter migrated/failed depuis la DB en live (cohérent)
        await db.update(migrations).set({
          mailMigrated: row.mailMigrated + recovered,
          mailFailed: Math.max(0, row.mailFailed - recovered),
          mailError: `Reprise des erreurs : ${recovered + stillFailed}/${total} (${recovered} OK, ${stillFailed} échec)…`,
        }).where(eq(migrations.id, id))
      } catch (err) {
        stillFailed++
        const errorDetails = err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000)
        await db.update(migratedMessages)
          .set({ errorDetails })
          .where(eq(migratedMessages.id, msg.id))
        console.warn(`[retry-errors] ${msg.graphMessageId} fail: ${errorDetails.slice(0, 200)}`)
      }
      // Log de progression toutes les 20 messages pour le suivi en stdout
      if ((i + 1) % 20 === 0) {
        const pct = Math.round(((i + 1) / total) * 100)
        console.log(`[retry-errors] ${id}: ${i + 1}/${total} (${pct}%) — ${recovered} OK, ${stillFailed} échec`)
      }
      // Tempo léger entre messages pour ne pas saturer
      if (i + 1 < errors.length) await new Promise((r) => setTimeout(r, 300))
    }

    const durationS = Math.round((Date.now() - startedAt) / 1000)
    const allRecovered = stillFailed === 0
    const finalMsg = allRecovered
      ? `Reprise terminée en ${durationS}s : ${recovered}/${total} récupérés`
      : `Reprise terminée en ${durationS}s : ${recovered} OK, ${stillFailed} encore en erreur (sur ${total})`
    // Si plus aucune erreur restante, la phase mail n'est plus "en erreur" :
    // on repasse le step en success (badge vert) et on met mailFailed à jour.
    // Sinon on laisse le step en error avec le nombre d'échecs restants.
    await db.update(migrations).set({
      mailError: finalMsg,
      mailFailed: stillFailed,
      ...(allRecovered ? { stepMailMigration: 'success' as const, mailFinishedAt: new Date() } : {}),
    }).where(eq(migrations.id, id))
    console.log(`[retry-errors] ${id}: ${finalMsg}`)
  })().catch(async (err) => {
    const msg = `Reprise des erreurs échouée : ${err instanceof Error ? err.message : String(err)}`
    await db.update(migrations).set({ mailError: msg }).where(eq(migrations.id, id))
  })

  return c.json({ message: `Reprise lancée en background sur ${errors.length} messages`, count: errors.length }, 202)
})

// ── Débloquer une phase coincée en 'running' sans worker actif (worker mort/hangé) ──
// Utilisé quand le bouton Pause ne répond plus (worker hung sur un appel Graph
// qui n'a jamais réveillé) ou après un crash silencieux du process Node.
// Force la phase en 'error' sans toucher au tracking → la reprise via "Reprendre"
// fonctionnera et le skipSet reprendra exactement au point d'arrêt.
dataMigrationRoutes.post('/:id/unstick/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  const stamp = new Date()
  if (phase === 'mail') {
    await db.update(migrations).set({
      stepMailMigration: 'error',
      mailError: `Déblocage manuel à ${row.mailMigrated}/${row.mailTotal} mails — clique "Reprendre" pour continuer`,
      mailFinishedAt: stamp,
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar') {
    await db.update(migrations).set({
      stepCalendarMigration: 'error',
      calError: `Déblocage manuel à ${row.calMigrated}/${row.calTotal} événements — clique "Reprendre" pour continuer`,
      calFinishedAt: stamp,
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts') {
    await db.update(migrations).set({
      stepContactsMigration: 'error',
      contactsError: `Déblocage manuel à ${row.contactsMigrated}/${row.contactsTotal} contacts — clique "Reprendre" pour continuer`,
      contactsFinishedAt: stamp,
    }).where(eq(migrations.id, id))
  } else {
    return c.json({ error: 'Phase invalide (mail, calendar, contacts)' }, 400)
  }

  // Best-effort : signaler le stop au cas où le worker reprend conscience
  signalStop(id, phase as 'mail' | 'calendar' | 'contacts')

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Forcer l'arrêt d'une phase (running → error) ────────────────────────────
dataMigrationRoutes.post('/:id/stop/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  if (phase === 'mail' && (row.stepMailMigration === 'running' || row.stepMailMigration === 'pending')) {
    // Signaler au worker de s'arrêter au prochain batch
    signalStop(id, 'mail')
    // Marquer immédiatement en DB pour le frontend
    await db.update(migrations).set({
      mailError: 'Arrêt en cours…',
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar' && (row.stepCalendarMigration === 'running' || row.stepCalendarMigration === 'pending')) {
    signalStop(id, 'calendar')
    await db.update(migrations).set({
      calError: 'Arrêt en cours…',
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts' && (row.stepContactsMigration === 'running' || row.stepContactsMigration === 'pending')) {
    signalStop(id, 'contacts')
    await db.update(migrations).set({
      contactsError: 'Arrêt en cours…',
    }).where(eq(migrations.id, id))
  } else {
    return c.json({ error: 'Phase non en cours' }, 400)
  }

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Réinitialiser une phase (pour re-migrer depuis 0 après suppression Google) ──
dataMigrationRoutes.post('/:id/reset/:phase', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  if (phase === 'mail') {
    await db.delete(migratedMessages).where(eq(migratedMessages.migrationId, id))
    await db.update(migrations).set({
      stepMailMigration: 'pending',
      mailTotal: 0, mailMigrated: 0, mailFailed: 0,
      mailError: null, mailLastSyncAt: null, mailStartedAt: null, mailFinishedAt: null,
    }).where(eq(migrations.id, id))
  } else if (phase === 'calendar') {
    await db.delete(migratedEvents).where(eq(migratedEvents.migrationId, id))
    await db.update(migrations).set({
      stepCalendarMigration: 'pending',
      calTotal: 0, calMigrated: 0, calFailed: 0,
      calError: null, calLastSyncAt: null, calStartedAt: null, calFinishedAt: null,
    }).where(eq(migrations.id, id))
  } else if (phase === 'contacts') {
    await db.delete(migratedContacts).where(eq(migratedContacts.migrationId, id))
    await db.update(migrations).set({
      stepContactsMigration: 'pending',
      contactsTotal: 0, contactsMigrated: 0, contactsFailed: 0,
      contactsError: null, contactsLastSyncAt: null, contactsStartedAt: null, contactsFinishedAt: null,
    }).where(eq(migrations.id, id))
  } else {
    return c.json({ error: 'Phase invalide' }, 400)
  }

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Reprise COMPLÈTE de la migration mail (efface lastSyncAt, garde le tracking) ──
// Utilisé pour réparer une migration marquée "terminée" à tort (ex: bug signet de
// reprise sur Esther) : on remet mailLastSyncAt à null → la relance fait un re-parcours
// COMPLET (et non un delta) qui skippe les déjà-migrés (skipSet) et complète le reste.
// Ne supprime PAS migrated_messages → les milliers déjà faits ne sont pas refaits.
dataMigrationRoutes.post('/:id/resume-full', requirePermission('migration:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)
  if (!row.gohUpn) return c.json({ error: 'Pas de compte Google associé' }, 400)

  await db.update(migrations).set({
    mailLastSyncAt: null,           // force un re-parcours complet (pas un delta)
    stepMailMigration: 'pending',   // le worker le récupère
    mailError: null, mailFinishedAt: null,
  }).where(eq(migrations.id, id))

  const [updated] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!updated) return c.json({ error: 'Not Found' }, 404)
  return c.json(serializeMigration(updated))
})

// ── Erreurs détaillées par phase ─────────────────────────────────────────────
dataMigrationRoutes.get('/:id/errors/:phase', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')

  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)

  if (phase === 'mail') {
    const rows = await db.select({
      id: migratedMessages.id,
      graphId: migratedMessages.graphMessageId,
      internetMessageId: migratedMessages.internetMessageId,
      errorDetails: migratedMessages.errorDetails,
      createdAt: migratedMessages.createdAt,
    })
      .from(migratedMessages)
      .where(and(eq(migratedMessages.migrationId, id), eq(migratedMessages.status, 'error')))
      .orderBy(desc(migratedMessages.createdAt))
      .limit(limit)
    return c.json({ phase, errors: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) })
  }

  if (phase === 'calendar') {
    const rows = await db.select({
      id: migratedEvents.id,
      graphId: migratedEvents.graphEventId,
      iCalUid: migratedEvents.iCalUid,
      errorDetails: migratedEvents.errorDetails,
      createdAt: migratedEvents.createdAt,
    })
      .from(migratedEvents)
      .where(and(eq(migratedEvents.migrationId, id), eq(migratedEvents.status, 'error')))
      .orderBy(desc(migratedEvents.createdAt))
      .limit(limit)
    return c.json({ phase, errors: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) })
  }

  if (phase === 'contacts') {
    const rows = await db.select({
      id: migratedContacts.id,
      graphId: migratedContacts.graphContactId,
      errorDetails: migratedContacts.errorDetails,
      createdAt: migratedContacts.createdAt,
    })
      .from(migratedContacts)
      .where(and(eq(migratedContacts.migrationId, id), eq(migratedContacts.status, 'error')))
      .orderBy(desc(migratedContacts.createdAt))
      .limit(limit)
    return c.json({ phase, errors: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) })
  }

  return c.json({ error: 'Phase invalide (mail, calendar, contacts)' }, 400)
})

// ── Télécharger les erreurs en CSV ───────────────────────────────────────────
dataMigrationRoutes.get('/:id/errors/:phase/download', requirePermission('migration:read'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const phase = c.req.param('phase')

  const [row] = await db.select().from(migrations).where(eq(migrations.id, id))
  if (!row) return c.json({ error: 'Not Found' }, 404)

  let rows: Array<{ graphId: string; refId: string | null; subject: string | null; receivedAt: Date | null; errorDetails: string | null; createdAt: Date }> = []

  if (phase === 'mail') {
    const data = await db.select({
      graphId: migratedMessages.graphMessageId,
      refId: migratedMessages.internetMessageId,
      subject: migratedMessages.subject,
      receivedAt: migratedMessages.receivedAt,
      errorDetails: migratedMessages.errorDetails,
      createdAt: migratedMessages.createdAt,
    }).from(migratedMessages)
      .where(and(eq(migratedMessages.migrationId, id), eq(migratedMessages.status, 'error')))
      .orderBy(desc(migratedMessages.createdAt))
    rows = data
  } else if (phase === 'calendar') {
    const data = await db.select({
      graphId: migratedEvents.graphEventId,
      refId: migratedEvents.iCalUid,
      errorDetails: migratedEvents.errorDetails,
      createdAt: migratedEvents.createdAt,
    }).from(migratedEvents)
      .where(and(eq(migratedEvents.migrationId, id), eq(migratedEvents.status, 'error')))
      .orderBy(desc(migratedEvents.createdAt))
    rows = data.map((r) => ({ ...r, subject: null, receivedAt: null }))
  } else if (phase === 'contacts') {
    const data = await db.select({
      graphId: migratedContacts.graphContactId,
      refId: migratedContacts.googleResourceName,
      errorDetails: migratedContacts.errorDetails,
      createdAt: migratedContacts.createdAt,
    }).from(migratedContacts)
      .where(and(eq(migratedContacts.migrationId, id), eq(migratedContacts.status, 'error')))
      .orderBy(desc(migratedContacts.createdAt))
    rows = data.map((r) => ({ ...r, subject: null, receivedAt: null }))
  } else {
    return c.json({ error: 'Phase invalide' }, 400)
  }

  // Construire le CSV
  const csvEscape = (s: string | null) => {
    if (!s) return ''
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const csvLines = ['subject,receivedAt,graphId,referenceId,errorDetails,createdAt']
  for (const r of rows) {
    csvLines.push([
      csvEscape(r.subject),
      r.receivedAt ? r.receivedAt.toISOString() : '',
      csvEscape(r.graphId),
      csvEscape(r.refId),
      csvEscape(r.errorDetails),
      r.createdAt.toISOString(),
    ].join(','))
  }

  const filename = `errors-${phase}-${row.onelaUpn.replace('@', '_')}-${new Date().toISOString().slice(0, 10)}.csv`
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  return c.body(csvLines.join('\n'))
})
