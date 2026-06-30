import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight, RefreshCw, Mail, Calendar, Users, Archive, Trash2, ArchiveRestore, FolderInput, Loader2, CheckCircle2, Clock, Send, XCircle, Tags, Copy, BookUser, RotateCw } from 'lucide-react'
import type { MigrationRecord } from '@dsi-app/shared'
import { migrationApi } from '../api'
import { cn } from '@/lib/utils'
import { StepBadge } from './StepBadge'
import { CopyButton } from './CopyButton'
import { DataMigrationSection } from './DataMigrationSection'
import {
  useAddGoogleAlias,
  useMigrateMail,
  useMigrateCalendar,
  useMigrateContacts,
  useArchiveMigration,
  useUnarchiveMigration,
  useDeleteMigration,
  useMoveOu,
  useCheckGoogle,
  useSetForwarding,
  useRemoveForwarding,
  useForwardingStatus,
  useRelabelMail,
  useDedupeMail,
  useActivateNewFormat,
} from '../hooks/useMigration'

export function MigrationCard({ m, defaultExpanded = false }: { m: MigrationRecord; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [aliasMessage, setAliasMessage] = useState<string | null>(null)
  const [ouMessage, setOuMessage] = useState<string | null>(null)
  const [aliasInput, setAliasInput] = useState(m.onelaUpn)

  const { mutate: addAlias, isPending: isAddingAlias } = useAddGoogleAlias()
  const { mutate: migrateMail, isPending: isStartingMail } = useMigrateMail()
  const { mutate: migrateCalendar, isPending: isStartingCalendar } = useMigrateCalendar()
  const { mutate: migrateContacts, isPending: isStartingContacts } = useMigrateContacts()
  const { mutate: archive, isPending: isArchiving } = useArchiveMigration()
  const { mutate: unarchive, isPending: isUnarchiving } = useUnarchiveMigration()
  const { mutate: removeMigration, isPending: isDeleting } = useDeleteMigration()
  const { mutate: moveOu, isPending: isMovingOu } = useMoveOu()
  const { mutate: setForwarding, isPending: isSettingFwd } = useSetForwarding()
  const { mutate: removeForwarding, isPending: isRemovingFwd } = useRemoveForwarding()
  const { mutate: relabelMail, isPending: isRelabeling } = useRelabelMail()
  const { mutate: dedupeMail, isPending: isDeduping } = useDedupeMail()
  const { mutate: activateNewFormatRaw, isPending: isActivatingNewFormat } = useActivateNewFormat()

  const newFormatAlias = m.gohUpn ? `${m.gohUpn.split('@')[0]}@${m.onelaUpn.split('@')[1] ?? 'onela.com'}` : null
  const handleActivateNewFormat = () => {
    if (!window.confirm(
      `Activer le nouveau format ${newFormatAlias} ?\n\n` +
        `Ça va :\n` +
        `1. Ajouter l'alias ${newFormatAlias} sur le compte ${m.gohUpn}\n` +
        `2. Ajouter "Envoyer en tant que" ${newFormatAlias} dans son Gmail\n\n` +
        `Le user pourra envoyer/recevoir avec ce nouveau format dès maintenant.`,
    )) return
    activateNewFormatRaw(m.id, {
      onSuccess: (data) => {
        const lines = [`Nouveau format activé : ${data.alias}`]
        lines.push(`• Alias : ${data.aliasAdded ? 'ajouté' : '(déjà présent)'}`)
        lines.push(`• Envoyer en tant que : ${data.sendAsAdded ? 'ajouté' : '(déjà présent)'}`)
        lines.push(`• Marquée comme défaut : ${data.setAsDefault ? 'oui' : 'non'}`)
        if (data.warnings.length) lines.push('', ...data.warnings.map((w) => `⚠ ${w}`))
        window.alert(lines.join('\n'))
      },
      onError: (err: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const apiErr = (err as any)?.response?.data?.message
        window.alert(`Activation nouveau format échouée :\n\n${apiErr || (err instanceof Error ? err.message : String(err))}`)
      },
    })
  }
  const [fwdMessage, setFwdMessage] = useState<string | null>(null)
  const [relabelMessage, setRelabelMessage] = useState<string | null>(null)
  const [dedupeMessage, setDedupeMessage] = useState<string | null>(null)
  const [onelaContactsMsg, setOnelaContactsMsg] = useState<string | null>(null)
  const [isPushingOnela, setIsPushingOnela] = useState(false)
  const [isResumingFull, setIsResumingFull] = useState(false)
  const queryClient = useQueryClient()

  const handleResumeFull = async () => {
    if (!window.confirm(
      `Relancer une migration mail COMPLÈTE pour ${m.onelaDisplayName} ?\n\n` +
      `Utile si la migration a été marquée "terminée" à tort. Ça relance un ` +
      `re-parcours complet de la boîte : les mails déjà migrés sont sautés ` +
      `(rapide), et seuls les manquants sont traités. Aucun doublon.`
    )) return
    setIsResumingFull(true)
    try {
      await migrationApi.resumeFullMail(m.id)
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
      for (const ms of [3000, 8000, 15000]) {
        setTimeout(() => queryClient.invalidateQueries({ queryKey: ['migration-history'] }), ms)
      }
    } catch (err: unknown) {
      const apiErr = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      window.alert(`Reprise complète échouée : ${apiErr || (err instanceof Error ? err.message : String(err))}`)
    } finally {
      setIsResumingFull(false)
    }
  }

  const handlePushOnelaContacts = async () => {
    if (!window.confirm(
      `Intégrer l'annuaire ONELA dans les contacts Google de ${m.gohUpn} ?\n\n` +
      `Les collègues ONELA pas encore migrés et les listes de diffusion seront ajoutés ` +
      `dans ses contacts (libellé « ONELA »). Les contacts déjà présents ne seront pas dupliqués.`
    )) return
    setIsPushingOnela(true)
    setOnelaContactsMsg(null)
    try {
      const res = await migrationApi.pushOnelaContacts(m.id)
      setOnelaContactsMsg(`${res.message} (${res.total} contacts) — l'ajout se fait en arrière-plan.`)
    } catch (err: unknown) {
      const apiErr = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      setOnelaContactsMsg(apiErr || (err instanceof Error ? err.message : 'Erreur inconnue'))
    } finally {
      setIsPushingOnela(false)
    }
  }

  const hasError = m.stepCreateAccount === 'error'
  const accountReady = m.stepCreateAccount === 'success' || m.stepCreateAccount === 'skipped'

  const fwdCheckEnabled = accountReady && !!m.onelaUserId && expanded
  const { data: fwdStatus, isFetching: isCheckingFwd } = useForwardingStatus(m.id, fwdCheckEnabled)

  // Polling Google toutes les 30s pour vérifier si le compte est provisionné par SCIM
  // Actif si : compte Entra créé (pas skipped), aucune migration data n'a encore réussi
  const anyDataStarted = m.stepMailMigration !== 'skipped' ||
    m.stepCalendarMigration !== 'skipped' ||
    m.stepContactsMigration !== 'skipped'
  const needsGoogleCheck = accountReady && !!m.gohUpn &&
    m.stepCreateAccount === 'success' && !anyDataStarted
  const { data: googleCheck, isFetching: isCheckingGoogle } = useCheckGoogle(m.id, needsGoogleCheck)
  // Google est prêt si : compte existant (skipped), ou des migrations ont déjà tourné, ou le check confirme
  const googleReady = m.stepCreateAccount === 'skipped' || anyDataStarted || googleCheck?.exists === true

  const canAddAlias = accountReady && m.stepGoogleAlias !== 'success'
  const canMoveOu = accountReady && !!m.gohUpn && m.stepOuMove !== 'success'

  // Est-ce qu'il y a des données en cours de migration ?
  const hasRunningData = ['pending', 'running'].includes(m.stepMailMigration) ||
    ['pending', 'running'].includes(m.stepCalendarMigration) ||
    ['pending', 'running'].includes(m.stepContactsMigration)

  const handleDelete = () => {
    if (window.confirm(`Supprimer definitivement la migration de ${m.onelaDisplayName} ?\nCela ne supprime pas les donnees deja migrees dans Google.`)) {
      removeMigration(m.id)
    }
  }

  const handleMoveOu = () => {
    setOuMessage(null)
    moveOu(m.id, {
      onSuccess: () => setOuMessage(null),
      onError: (err: unknown) => {
        const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          ?? (err instanceof Error ? err.message : 'Erreur inconnue')
        setOuMessage(msg)
      },
    })
  }

  const handleAddAlias = () => {
    setAliasMessage(null)
    addAlias(
      { id: m.id, alias: aliasInput.trim() || undefined },
      {
        onSuccess: () => setAliasMessage(null),
        onError: (err: unknown) => {
          const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
            ?? (err instanceof Error ? err.message : 'Erreur inconnue')
          setAliasMessage(msg)
        },
      }
    )
  }

  // Résumé compact des statuts
  const statusSummary = () => {
    if (hasError) return { text: 'Erreur', color: 'text-red-600' }
    if (hasRunningData) return { text: 'En cours', color: 'text-blue-600' }
    if (m.stepMailMigration === 'success' && m.stepCalendarMigration === 'success' && m.stepContactsMigration === 'success') {
      return { text: 'Migrations terminées', color: 'text-green-600' }
    }
    if (accountReady && !googleReady) return { text: 'En attente SCIM...', color: 'text-amber-600' }
    if (accountReady) return { text: 'Compte prêt', color: 'text-blue-600' }
    return { text: 'En cours', color: 'text-gray-600' }
  }

  const summary = statusSummary()

  // ── Contenu réutilisable des étapes (déclaré une fois, placé dans l'ordre 1→8) ──

  const mailStepContent = (
    <>
      <DataMigrationSection
        migrationId={m.id} phase="mail" label="mail" icon={Mail}
        status={m.stepMailMigration} total={m.mailTotal}
        migrated={m.mailMigrated} failed={m.mailFailed}
        errorMessage={m.mailError} itemUnit="message"
        onStart={(order, beforeDays) => migrateMail({ id: m.id, order: order ?? 'desc', beforeDays })} isStarting={isStartingMail}
        startedAt={m.mailStartedAt} finishedAt={m.mailFinishedAt}
        lastSyncAt={m.mailLastSyncAt} color="purple" showOrderChoice
      />
      {/* Boutons d'entretien : visibles si des mails ont été migrés et la phase n'est pas en cours */}
      {m.mailMigrated > 0 && !['pending', 'running'].includes(m.stepMailMigration) && (
        <div className="mt-2 space-y-1">
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                setRelabelMessage(null)
                relabelMail(m.id, {
                  onSuccess: () => setRelabelMessage('Re-labellisation lancée en arrière-plan'),
                  onError: (err: unknown) => {
                    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
                      ?? (err instanceof Error ? err.message : 'Erreur')
                    setRelabelMessage(msg)
                  },
                })
              }}
              disabled={isRelabeling}
              className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-60"
            >
              <Tags className={cn('h-3 w-3', isRelabeling && 'animate-spin')} />
              {isRelabeling ? 'Lancement...' : 'Re-labelliser'}
            </button>
            <button
              onClick={() => {
                if (!window.confirm(
                  `Dédupliquer la boîte Gmail ?\n\n` +
                  `Cela va scanner tous les messages et envoyer les doublons (même Message-ID) à la Corbeille Gmail.\n` +
                  `Les messages supprimés sont récupérables pendant 30 jours.\n\n` +
                  `L'opération peut durer plusieurs minutes selon la taille de la mailbox.`
                )) return
                setDedupeMessage(null)
                dedupeMail(m.id, {
                  onSuccess: () => setDedupeMessage('Déduplication lancée en arrière-plan'),
                  onError: (err: unknown) => {
                    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
                      ?? (err instanceof Error ? err.message : 'Erreur')
                    setDedupeMessage(msg)
                  },
                })
              }}
              disabled={isDeduping}
              className="flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-60"
            >
              <Copy className={cn('h-3 w-3', isDeduping && 'animate-spin')} />
              {isDeduping ? 'Lancement...' : 'Dédupliquer'}
            </button>
            <button
              onClick={handleResumeFull}
              disabled={isResumingFull}
              title="Relance un re-parcours complet (corrige une migration marquée 'terminée' à tort). Skippe les déjà migrés."
              className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
            >
              <RotateCw className={cn('h-3 w-3', isResumingFull && 'animate-spin')} />
              {isResumingFull ? 'Lancement...' : 'Reprise complète'}
            </button>
          </div>
          {relabelMessage && (
            <p className={cn('rounded px-2 py-1 text-xs',
              relabelMessage.includes('lancée') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            )}>{relabelMessage}</p>
          )}
          {dedupeMessage && (
            <p className={cn('rounded px-2 py-1 text-xs',
              dedupeMessage.includes('lancée') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            )}>{dedupeMessage}</p>
          )}
        </div>
      )}
    </>
  )

  const aliasStepContent = canAddAlias ? (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <input type="text" value={aliasInput}
          onChange={(e) => setAliasInput(e.target.value)}
          placeholder="alias@domaine.com"
          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        <button onClick={handleAddAlias}
          disabled={isAddingAlias || !aliasInput.trim()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-60">
          <RefreshCw className={cn('h-3 w-3', isAddingAlias && 'animate-spin')} />
          {isAddingAlias ? '...' : 'Ajouter'}
        </button>
      </div>
      {aliasMessage && (
        <p className={cn('rounded px-2 py-1 text-xs',
          aliasMessage.includes('pas encore') ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'
        )}>{aliasMessage}</p>
      )}
    </div>
  ) : m.stepGoogleAlias === 'success' ? (
    <p className="text-xs text-green-700">Alias <span className="font-mono">{m.onelaUpn}</span> ajouté</p>
  ) : m.stepGoogleAlias === 'skipped' ? (
    <p className="text-xs text-gray-400">Ignoré</p>
  ) : null

  const newFormatStepContent = !newFormatAlias ? (
    <p className="text-xs text-gray-400">En attente du compte Google…</p>
  ) : m.stepNewFormat === 'success' ? (
    <div className="space-y-1.5">
      <p className="text-xs text-green-700">
        <span className="font-mono">{newFormatAlias}</span> activé (alias + send-as + défaut)
      </p>
      <button
        onClick={handleActivateNewFormat}
        disabled={isActivatingNewFormat}
        className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        title="Re-jouer (idempotent)"
      >
        <RefreshCw className={cn('h-3 w-3', isActivatingNewFormat && 'animate-spin')} />
        {isActivatingNewFormat ? 'Activation…' : 'Re-jouer'}
      </button>
    </div>
  ) : m.stepNewFormat === 'error' ? (
    <div className="space-y-1.5">
      {m.newFormatError && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{m.newFormatError}</p>
      )}
      <button
        onClick={handleActivateNewFormat}
        disabled={isActivatingNewFormat}
        className="flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-2 py-1.5 text-xs font-medium text-teal-700 hover:bg-teal-100 disabled:opacity-60"
      >
        <RefreshCw className={cn('h-3 w-3', isActivatingNewFormat && 'animate-spin')} />
        {isActivatingNewFormat ? 'Activation…' : 'Réessayer'}
      </button>
    </div>
  ) : (
    <button
      onClick={handleActivateNewFormat}
      disabled={isActivatingNewFormat || m.stepGoogleAlias !== 'success'}
      className="flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-2 py-1.5 text-xs font-medium text-teal-700 hover:bg-teal-100 disabled:opacity-60"
      title={m.stepGoogleAlias !== 'success'
        ? 'Ajoute d\'abord l\'alias legacy (étape 2)'
        : `Ajoute l'alias ${newFormatAlias} + "Envoyer en tant que" + défaut`}
    >
      <RefreshCw className={cn('h-3 w-3', isActivatingNewFormat && 'animate-spin')} />
      {isActivatingNewFormat ? 'Activation…' : `Activer ${newFormatAlias}`}
    </button>
  )

  const ouStepContent = canMoveOu ? (
    <div>
      <button onClick={handleMoveOu} disabled={isMovingOu}
        className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-60">
        <FolderInput className={cn('h-3.5 w-3.5', isMovingOu && 'animate-pulse')} />
        {isMovingOu ? 'En cours...' : 'Déplacer'}
      </button>
      {ouMessage && <p className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{ouMessage}</p>}
    </div>
  ) : m.stepOuMove === 'success' ? (
    <p className="text-xs text-green-700">Déplacé</p>
  ) : m.stepOuMove === 'skipped' ? (
    <p className="text-xs text-gray-400">Ignoré</p>
  ) : m.stepOuMove === 'error' && m.ouMoveError ? (
    <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{m.ouMoveError}</p>
  ) : null

  const forwardingStepContent = accountReady && m.onelaUserId ? (
    <div className="space-y-2">
      {isCheckingFwd && !fwdStatus ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Vérification...
        </div>
      ) : fwdStatus?.active ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded bg-green-50 px-2.5 py-1.5 text-xs text-green-700">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>Redirection active vers <strong>{fwdStatus.forwardTo}</strong></span>
          </div>
          <button
            onClick={() => {
              setFwdMessage(null)
              removeForwarding(m.id, {
                onError: (err: unknown) => {
                  const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
                    ?? (err instanceof Error ? err.message : 'Erreur inconnue')
                  setFwdMessage(msg)
                },
              })
            }}
            disabled={isRemovingFwd}
            className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-60"
          >
            <XCircle className={cn('h-3.5 w-3.5', isRemovingFwd && 'animate-spin')} />
            {isRemovingFwd ? 'Désactivation...' : 'Désactiver la redirection'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            Active une règle de transfert sur la boîte Exchange ONELA vers <strong>{m.gohUpn}</strong>
          </p>
          <button
            onClick={() => {
              setFwdMessage(null)
              setForwarding(m.id, {
                onError: (err: unknown) => {
                  const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
                    ?? (err instanceof Error ? err.message : 'Erreur inconnue')
                  setFwdMessage(msg)
                },
              })
            }}
            disabled={isSettingFwd}
            className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
          >
            <Send className={cn('h-3.5 w-3.5', isSettingFwd && 'animate-spin')} />
            {isSettingFwd ? 'Activation...' : 'Activer la redirection'}
          </button>
        </div>
      )}
      {fwdMessage && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{fwdMessage}</p>
      )}
    </div>
  ) : (
    <p className="text-xs text-gray-400">Disponible après création du compte.</p>
  )

  const calendarStepContent = (
    <DataMigrationSection
      migrationId={m.id} phase="calendar" label="calendrier" icon={Calendar}
      status={m.stepCalendarMigration} total={m.calTotal}
      migrated={m.calMigrated} failed={m.calFailed}
      errorMessage={m.calError} itemUnit="événement"
      onStart={() => migrateCalendar(m.id)} isStarting={isStartingCalendar}
      startedAt={m.calStartedAt} finishedAt={m.calFinishedAt}
      lastSyncAt={m.calLastSyncAt} color="blue"
    />
  )

  const contactsStepContent = (
    <DataMigrationSection
      migrationId={m.id} phase="contacts" label="contacts" icon={Users}
      status={m.stepContactsMigration} total={m.contactsTotal}
      migrated={m.contactsMigrated} failed={m.contactsFailed}
      errorMessage={m.contactsError} itemUnit="contact"
      onStart={() => migrateContacts(m.id)} isStarting={isStartingContacts}
      startedAt={m.contactsStartedAt} finishedAt={m.contactsFinishedAt}
      lastSyncAt={m.contactsLastSyncAt} color="emerald"
    />
  )

  // ÉTAPE 8 — Intégration de l'annuaire ONELA partagé dans les contacts Google du user.
  // L'annuaire est importé globalement (dashboard) puis poussé par user via People API.
  const onelaContactsStepContent = (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        Pousse l'annuaire ONELA partagé (collègues pas encore migrés + listes de diffusion)
        dans les contacts Google de cet utilisateur, pour qu'il les retrouve facilement.
      </p>
      <button
        onClick={handlePushOnelaContacts}
        disabled={isPushingOnela || !m.gohUpn}
        title={!m.gohUpn ? 'Compte Google requis' : 'Ajoute l\'annuaire ONELA dans les contacts Google du user'}
        className="flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-60"
      >
        <BookUser className={cn('h-3.5 w-3.5', isPushingOnela && 'animate-pulse')} />
        {isPushingOnela ? 'Lancement…' : 'Intégrer les contacts ONELA'}
      </button>
      {onelaContactsMsg && (
        <p className={cn('rounded px-2 py-1 text-xs',
          onelaContactsMsg.includes('arrière-plan') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        )}>{onelaContactsMsg}</p>
      )}
    </div>
  )

  return (
    <div className={cn('rounded-xl border bg-white', hasError ? 'border-red-200' : 'border-gray-200')}>
      {/* En-tête compact (toujours visible) */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-gray-50 transition-colors rounded-xl"
      >
        <ChevronRight className={cn('h-4 w-4 text-gray-400 transition-transform shrink-0', expanded && 'rotate-90')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-medium text-gray-900 truncate">{m.onelaDisplayName}</p>
            <span className={cn('text-xs font-medium', summary.color)}>{summary.text}</span>
          </div>
          <p className="text-xs text-gray-500 truncate">{m.onelaUpn} → {m.gohUpn ?? '...'}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-1 shrink-0">
          <StepBadge status={m.stepMailMigration} label="Mail" />
          <StepBadge status={m.stepCalendarMigration} label="Cal" />
          <StepBadge status={m.stepContactsMigration} label="Contacts" />
        </div>
      </button>

      {/* Contenu détaillé (collapsable) */}
      {expanded && (
        <div className="border-t border-gray-100 p-4 space-y-4">
          {/* Badges de toutes les étapes */}
          <div className="flex flex-wrap gap-1">
            <StepBadge status={m.stepCreateAccount} label="Compte GOH" />
            <StepBadge status={m.stepSetAttributes} label="Attributs" />
            <StepBadge status={m.stepGroupMembership} label="Groupe dyn." />
            <StepBadge status={m.stepGoogleAlias} label="Alias Google" />
            <StepBadge status={m.stepOuMove} label="OU ONELA" />
            <StepBadge status={m.stepMailMigration} label="Mail" />
            <StepBadge status={m.stepCalendarMigration} label="Calendrier" />
            <StepBadge status={m.stepContactsMigration} label="Contacts" />
          </div>

          {/* Actions de gestion */}
          <div className="flex flex-wrap gap-2 border-b border-gray-100 pb-3">
            {m.archived ? (
              <button onClick={() => unarchive(m.id)} disabled={isUnarchiving}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100">
                <ArchiveRestore className="h-3 w-3" /> Désarchiver
              </button>
            ) : (
              <button onClick={() => archive(m.id)} disabled={isArchiving}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100">
                <Archive className="h-3 w-3" /> Archiver (déplacer dans Historique)
              </button>
            )}
            <button onClick={handleDelete} disabled={isDeleting}
              className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-50">
              <Trash2 className="h-3 w-3" /> Supprimer
            </button>
          </div>

          {hasError && m.errorDetails && (
            <p className="rounded bg-red-50 p-2 text-xs text-red-700">{m.errorDetails}</p>
          )}

          {m.gohUpn && (
            <div className="flex items-center justify-between rounded bg-blue-50 px-3 py-2">
              <div>
                <p className="text-xs font-medium text-blue-800">Adresse Google (@mig.onela.com)</p>
                <code className="font-mono text-sm text-blue-900">{m.gohUpn}</code>
              </div>
              <CopyButton text={m.gohUpn} />
            </div>
          )}

          {m.tempPassword && (
            <div className="flex items-center justify-between rounded bg-amber-50 px-3 py-2">
              <div>
                <p className="text-xs font-medium text-amber-800">Mot de passe temporaire</p>
                <code className="font-mono text-sm text-amber-900">{m.tempPassword}</code>
              </div>
              <CopyButton text={m.tempPassword} />
            </div>
          )}

          {/* Statut SCIM / Google */}
          {needsGoogleCheck && (
            <div className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
              googleReady ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
            )}>
              {googleReady ? (
                <><CheckCircle2 className="h-4 w-4" /> Compte Google provisionné ({m.gohUpn})</>
              ) : (
                <>
                  {isCheckingGoogle
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Clock className="h-4 w-4" />}
                  En attente de provisionnement SCIM Google... (vérification auto toutes les 30s)
                </>
              )}
            </div>
          )}

          {/* ── Étapes numérotées (ordre opératoire 1 → 8) ──────────────────── */}
          {accountReady && (
            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Étapes de migration</h4>

              {/* Ligne 1 : 1 Mail · 2 Alias Google · 3 Nouveau format */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <StepBlock
                  number={1}
                  label="Migration mail"
                  completed={m.stepMailMigration === 'success' && m.mailTotal > 0 && m.mailMigrated >= m.mailTotal}
                >
                  {mailStepContent}
                </StepBlock>

                <StepBlock
                  number={2}
                  label="Alias Google"
                  completed={m.stepGoogleAlias === 'success'}
                >
                  {aliasStepContent}
                </StepBlock>

                <StepBlock
                  number={3}
                  label="Nouveau format prenom.nom@onela.com"
                  completed={m.stepNewFormat === 'success'}
                >
                  {newFormatStepContent}
                </StepBlock>
              </div>

              {/* Ligne 2 : 4 OU onela.com · 5 Redirection Exchange · 6 Calendrier */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <StepBlock
                  number={4}
                  label="OU onela.com"
                  completed={m.stepOuMove === 'success'}
                >
                  {ouStepContent}
                </StepBlock>

                <StepBlock
                  number={5}
                  label="Redirection Exchange"
                  completed={!!fwdStatus?.active}
                >
                  {forwardingStepContent}
                </StepBlock>

                <StepBlock
                  number={6}
                  label="Migration calendrier"
                  completed={m.stepCalendarMigration === 'success' && m.calTotal > 0 && m.calMigrated >= m.calTotal}
                >
                  {calendarStepContent}
                </StepBlock>
              </div>

              {/* Ligne 3 : 7 Contacts · 8 Intégration contacts ONELA */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <StepBlock
                  number={7}
                  label="Migration contacts"
                  completed={m.stepContactsMigration === 'success' && m.contactsTotal > 0 && m.contactsMigrated >= m.contactsTotal}
                >
                  {contactsStepContent}
                </StepBlock>

                <StepBlock
                  number={8}
                  label="Intégration contacts ONELA"
                  completed={false}
                >
                  {onelaContactsStepContent}
                </StepBlock>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Bloc numéroté pour chaque étape
function StepBlock({
  number,
  label,
  completed = false,
  children,
}: {
  number: number
  label: string
  completed?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        completed
          ? 'border-green-200 bg-green-50/50'
          : 'border-gray-100 bg-gray-50/50',
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold',
            completed
              ? 'bg-green-600 text-white'
              : 'bg-gray-200 text-gray-600',
          )}
        >
          {completed ? <CheckCircle2 className="h-3 w-3" /> : number}
        </span>
        <span
          className={cn(
            'text-xs font-semibold',
            completed ? 'text-green-800' : 'text-gray-700',
          )}
        >
          {label}
        </span>
      </div>
      {children}
    </div>
  )
}
