import { useState } from 'react'
import { ChevronDown, ChevronUp, ChevronRight, RefreshCw, Mail, Calendar, Users, Archive, Trash2, ArchiveRestore, FolderInput, Download, Loader2, CheckCircle2, Clock } from 'lucide-react'
import type { MigrationRecord } from '@dsi-app/shared'
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
} from '../hooks/useMigration'

export function MigrationCard({ m, defaultExpanded = false }: { m: MigrationRecord; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [psExpanded, setPsExpanded] = useState(false)
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

  const hasError = m.stepCreateAccount === 'error'
  const accountReady = m.stepCreateAccount === 'success' || m.stepCreateAccount === 'skipped'

  // Polling Google toutes les 30s pour vérifier si le compte est provisionné par SCIM
  // Actif uniquement si le compte Entra est créé mais que le mail n'a pas encore été lancé
  const needsGoogleCheck = accountReady && !!m.gohUpn &&
    m.stepCreateAccount === 'success' && // Pas pour les comptes existants (skipped)
    m.stepMailMigration === 'skipped' &&
    m.stepCalendarMigration === 'skipped' &&
    m.stepContactsMigration === 'skipped'
  const { data: googleCheck, isFetching: isCheckingGoogle } = useCheckGoogle(m.id, needsGoogleCheck)
  const googleReady = m.stepCreateAccount === 'skipped' || googleCheck?.exists === true

  const canAddAlias = accountReady && m.stepGoogleAlias !== 'success' && m.stepGoogleAlias !== 'skipped'
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

          {/* ── Étapes numérotées ──────────────────────────────── */}
          {accountReady && (
            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Étapes de migration</h4>

              {/* Ligne 1 : Data migrations (3 colonnes) */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <StepBlock number={1} label="Mails">
                  <DataMigrationSection
                    migrationId={m.id} phase="mail" label="mail" icon={Mail}
                    status={m.stepMailMigration} total={m.mailTotal}
                    migrated={m.mailMigrated} failed={m.mailFailed}
                    errorMessage={m.mailError} itemUnit="message"
                    onStart={() => migrateMail(m.id)} isStarting={isStartingMail}
                    startedAt={m.mailStartedAt} finishedAt={m.mailFinishedAt}
                    lastSyncAt={m.mailLastSyncAt} color="purple"
                  />
                </StepBlock>

                <StepBlock number={2} label="Calendrier">
                  <DataMigrationSection
                    migrationId={m.id} phase="calendar" label="calendrier" icon={Calendar}
                    status={m.stepCalendarMigration} total={m.calTotal}
                    migrated={m.calMigrated} failed={m.calFailed}
                    errorMessage={m.calError} itemUnit="événement"
                    onStart={() => migrateCalendar(m.id)} isStarting={isStartingCalendar}
                    startedAt={m.calStartedAt} finishedAt={m.calFinishedAt}
                    lastSyncAt={m.calLastSyncAt} color="blue"
                  />
                </StepBlock>

                <StepBlock number={3} label="Contacts">
                  <DataMigrationSection
                    migrationId={m.id} phase="contacts" label="contacts" icon={Users}
                    status={m.stepContactsMigration} total={m.contactsTotal}
                    migrated={m.contactsMigrated} failed={m.contactsFailed}
                    errorMessage={m.contactsError} itemUnit="contact"
                    onStart={() => migrateContacts(m.id)} isStarting={isStartingContacts}
                    startedAt={m.contactsStartedAt} finishedAt={m.contactsFinishedAt}
                    lastSyncAt={m.contactsLastSyncAt} color="emerald"
                  />
                </StepBlock>
              </div>

              {/* Ligne 2 : Alias + OU + Delta (3 colonnes) */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <StepBlock number={4} label="Alias Google">
                  {canAddAlias ? (
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
                    <p className="text-xs text-green-600">Alias ajouté</p>
                  ) : m.stepGoogleAlias === 'skipped' ? (
                    <p className="text-xs text-gray-400">Ignoré</p>
                  ) : null}
                </StepBlock>

                <StepBlock number={5} label="OU onela.com">
                  {canMoveOu ? (
                    <div>
                      <button onClick={handleMoveOu} disabled={isMovingOu}
                        className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-60">
                        <FolderInput className={cn('h-3.5 w-3.5', isMovingOu && 'animate-pulse')} />
                        {isMovingOu ? 'En cours...' : 'Déplacer'}
                      </button>
                      {ouMessage && <p className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{ouMessage}</p>}
                    </div>
                  ) : m.stepOuMove === 'success' ? (
                    <p className="text-xs text-green-600">Déplacé</p>
                  ) : m.stepOuMove === 'skipped' ? (
                    <p className="text-xs text-gray-400">Ignoré</p>
                  ) : m.stepOuMove === 'error' && m.ouMoveError ? (
                    <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{m.ouMoveError}</p>
                  ) : null}
                </StepBlock>

                <StepBlock number={6} label="Sync delta">
                  <p className="text-xs text-gray-500">
                    Relancez 1→3 pour synchroniser les nouveaux éléments.
                  </p>
                </StepBlock>
              </div>

              {/* Ligne 3 : SMTP (pleine largeur) */}
              <StepBlock number={7} label="Transfert SMTP Exchange">
                {m.exchangePsScript ? (
                  <div>
                    <button onClick={() => setPsExpanded((v) => !v)}
                      className="flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900">
                      {psExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      Script PowerShell (ForwardingSMTPAddress)
                    </button>
                    {psExpanded && (
                      <div className="mt-2 rounded border border-gray-200 bg-gray-50">
                        <div className="flex justify-end border-b border-gray-200 px-3 py-1">
                          <CopyButton text={m.exchangePsScript} />
                        </div>
                        <pre className="overflow-x-auto p-3 text-xs text-gray-700">{m.exchangePsScript}</pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-gray-400">Disponible après création du compte.</p>
                )}
              </StepBlock>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Bloc numéroté pour chaque étape
function StepBlock({ number, label, children }: { number: number; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-[10px] font-bold text-gray-600">
          {number}
        </span>
        <span className="text-xs font-semibold text-gray-700">{label}</span>
      </div>
      {children}
    </div>
  )
}
