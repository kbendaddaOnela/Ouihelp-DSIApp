import { useState } from 'react'
import {
  Play,
  Pause,
  Trash2,
  Archive,
  ArchiveRestore,
  ChevronRight,
} from 'lucide-react'
import type { SharedMigrationRecord } from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  useRunSharedMigration,
  usePauseSharedMigration,
  useResumeSharedMigration,
  useDeleteSharedMigration,
  useArchiveSharedMigration,
  useUnarchiveSharedMigration,
} from '../hooks/useSharedMailbox'
import { useAlertOnError, StepBadge } from './cardShared'
import { MailErrorsPanel } from './MailErrorsPanel'
import { AccountPanel } from './AccountPanel'
import { DelegatesPanel } from './DelegatesPanel'
import { DualDeliveryPanel } from './DualDeliveryPanel'
import { LegacyGroupPanel } from './LegacyGroupPanel'

interface Props {
  migration: SharedMigrationRecord
}

export function SharedMailboxCard({ migration }: Props) {
  const alertOnError = useAlertOnError()
  const { confirm } = useConfirm()
  const { mutate: runMigration, isPending: isRunning } = useRunSharedMigration()
  const { mutate: pauseMigration, isPending: isPausing } = usePauseSharedMigration()
  const { mutate: resumeMigration, isPending: isResuming } = useResumeSharedMigration()
  const { mutate: deleteMigration, isPending: isDeleting } = useDeleteSharedMigration()
  const { mutate: archiveMigration, isPending: isArchiving } = useArchiveSharedMigration()
  const { mutate: unarchiveMigration, isPending: isUnarchiving } = useUnarchiveSharedMigration()

  const isAccountMode = migration.mode === 'account'
  const isInFlight = migration.stepMailImport === 'running' || migration.stepMailImport === 'pending'
  const isPaused = migration.stepMailImport === 'paused'

  const pct = migration.mailTotal > 0
    ? Math.min(100, Math.round((migration.mailMigrated / migration.mailTotal) * 100))
    : 0

  // Un import en pause se reprend avec « Reprendre », pas avec « Lancer » :
  // le bouton dédié évite de confondre reprise et resynchronisation.
  const canRun = !isInFlight && !isPaused
  const canDelete = migration.stepMailImport !== 'running'
  // En mode compte, l'import n'a de sens qu'une fois la licence attribuée
  const runBlockedByLicense = isAccountMode && migration.stepLicense !== 'success'
  const isDone = migration.stepMailImport === 'success'

  // Un passage complet sur la boîte est allé au bout : le worker ne pose
  // mailLastSyncAt qu'à la fin naturelle d'un run, après mailStartedAt. Une
  // reprise d'erreurs ne touche à aucun des deux ; un run interrompu (plantage,
  // pause) repose mailStartedAt sans avancer mailLastSyncAt.
  // Sans ce test, la barre passait de « terminé 100 % » à « 60 % » dès qu'il
  // restait quelques messages en erreur : en statut 'error', elle retombait sur
  // le ratio importés / total Exchange, deux chiffres qui ne se recouvrent jamais.
  const passComplete =
    isDone ||
    (migration.stepMailImport === 'error' &&
      !!migration.mailLastSyncAt &&
      !!migration.mailStartedAt &&
      new Date(migration.mailLastSyncAt) >= new Date(migration.mailStartedAt))

  const [expanded, setExpanded] = useState(false)

  const hasError =
    migration.stepMailImport === 'error' ||
    !!migration.createAccountError ||
    !!migration.licenseError ||
    !!migration.aliasSendAsError ||
    !!migration.delegatesError

  // Résumé de l'en-tête replié : une phrase pour savoir si la carte mérite d'être
  // ouverte. L'ordre est volontaire — ce qui bloque passe devant ce qui est fini.
  const summary = (() => {
    if (hasError) return { text: 'Erreur', color: 'text-red-600' }
    if (isPaused) return { text: 'En pause', color: 'text-amber-600' }
    if (isInFlight) return { text: 'Import en cours', color: 'text-blue-600' }
    if (runBlockedByLicense) return { text: 'En attente de licence', color: 'text-amber-600' }
    // Licence posée mais import jamais démarré : c'est l'état d'attente normal
    // depuis qu'attribuer une licence ne déclenche plus la migration.
    if (migration.stepMailImport === 'skipped' && migration.mailMigrated === 0) {
      return { text: 'Prêt à lancer', color: 'text-blue-600' }
    }
    if (isDone && (!isAccountMode || migration.stepDelegates === 'success')) {
      return { text: 'Migration terminée', color: 'text-green-600' }
    }
    if (isDone) return { text: 'Mails importés', color: 'text-green-600' }
    return { text: 'En cours', color: 'text-gray-600' }
  })()

  return (
    <div className={cn('rounded-xl border bg-white shadow-sm', hasError ? 'border-red-200' : 'border-gray-200')}>
      {/* En-tête compact, toujours visible : même principe que les cartes du module migration ONELA */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 rounded-xl p-4 text-left transition-colors hover:bg-gray-50"
      >
        <ChevronRight
          className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform', expanded && 'rotate-90')}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-gray-900">{migration.onelaDisplayName}</span>
            <span className={cn('shrink-0 text-xs font-medium', summary.color)}>{summary.text}</span>
            {!isAccountMode && (
              <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                ancien mode : Google Group
              </span>
            )}
          </div>
          <p className="truncate text-xs text-gray-500">
            {migration.onelaEmail} →{' '}
            {(isAccountMode ? migration.targetUserEmail : migration.targetGroupEmail) ?? '…'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {isAccountMode && <StepBadge status={migration.stepLicense} label="Licence" />}
          <StepBadge status={migration.stepMailImport} label="Mail" />
          {isAccountMode && <StepBadge status={migration.stepDelegates} label="Délégations" />}
        </div>
      </button>

      {/* Détail repliable. Monté seulement à l'ouverture : les panneaux Compte,
          Délégations et Dual delivery interrogent Google et Exchange, autant ne pas
          le faire pour toutes les cartes de la liste. */}
      {expanded && (
        <div className="border-t border-gray-100 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 text-sm text-gray-600">
              {isAccountMode ? (
                <>
                  → <span className="font-mono text-xs">{migration.targetUserEmail}</span>{' '}
                  <span className="text-gray-400">
                    (alias <span className="font-mono">{migration.targetUserAlias}</span> — {migration.targetDisplayName})
                  </span>
                </>
              ) : (
                <>
                  → <span className="font-mono text-xs">{migration.targetGroupEmail}</span>{' '}
                  <span className="text-gray-400">({migration.targetGroupName})</span>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {migration.archived ? (
                <button
                  onClick={() =>
                    unarchiveMigration(migration.id, { onError: alertOnError('Désarchiver') })
                  }
                  disabled={isUnarchiving}
                  className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  <ArchiveRestore className="h-3.5 w-3.5" />
                  Désarchiver
                </button>
              ) : (
                <button
                  onClick={() => archiveMigration(migration.id, { onError: alertOnError('Archiver') })}
                  disabled={isArchiving || isInFlight}
                  title={
                    isInFlight
                      ? 'Arrête l’import avant d’archiver'
                      : 'Ranger dans l’historique (le compte Google et les délégations sont conservés)'
                  }
                  className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Archiver
                </button>
              )}
              {canRun && !migration.archived && (
                <button
                  onClick={() => runMigration(migration.id, { onError: alertOnError('Lancer la migration') })}
                  disabled={isRunning || runBlockedByLicense}
                  title={
                    runBlockedByLicense
                      ? 'Attribue d’abord la licence Business Plus, puis clique « Licence attribuée »'
                      : undefined
                  }
                  className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" />
                  {migration.stepMailImport === 'success' ? 'Resynchroniser' : 'Lancer'}
                </button>
              )}
              {isPaused && !migration.archived && (
                <button
                  onClick={() => resumeMigration(migration.id, { onError: alertOnError('Reprendre l’import') })}
                  disabled={isResuming || runBlockedByLicense}
                  title="Repart au point d’arrêt : les messages déjà importés sont sautés, pas retéléchargés"
                  className="inline-flex items-center gap-1 rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" />
                  {isResuming ? 'Reprise…' : 'Reprendre'}
                </button>
              )}
              {isInFlight && (
                <button
                  onClick={() => pauseMigration(migration.id, { onError: alertOnError('Mettre en pause') })}
                  disabled={isPausing}
                  title="S’arrête à la fin du lot en cours. Reprise possible au point d’arrêt."
                  className="inline-flex items-center gap-1 rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
                >
                  <Pause className="h-3.5 w-3.5" />
                  {isPausing ? 'Pause…' : 'Mettre en pause'}
                </button>
              )}
              {canDelete && (
                <button
                  onClick={async () => {
                    const res = await confirm({
                      title: 'Supprimer le suivi',
                      tone: 'danger',
                      confirmLabel: 'Supprimer',
                      message: isAccountMode
                        ? `Supprimer le suivi de la migration de ${migration.onelaDisplayName} ?\n\n` +
                          `Le compte Google, sa licence et ses délégations ne sont PAS supprimés.`
                        : `Supprimer cette migration (pas le groupe Google) ?`,
                    })
                    if (res.confirmed) deleteMigration(migration.id)
                  }}
                  disabled={isDeleting}
                  className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  title="Supprimer"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {isAccountMode ? (
              <>
                <StepBadge status={migration.stepCreateAccount} label={`Compte : ${migration.stepCreateAccount}`} />
                <StepBadge status={migration.stepLicense} label={`Licence : ${migration.stepLicense}`} />
                <StepBadge status={migration.stepAliasSendAs} label={`Alias / send-as : ${migration.stepAliasSendAs}`} />
                <StepBadge status={migration.stepMailImport} label={`Import mail : ${migration.stepMailImport}`} />
                <StepBadge status={migration.stepDelegates} label={`Délégations : ${migration.stepDelegates}`} />
              </>
            ) : (
              <>
                <StepBadge status={migration.stepCreateGroup} label={`Groupe : ${migration.stepCreateGroup}`} />
                <StepBadge status={migration.stepMailImport} label={`Import mail : ${migration.stepMailImport}`} />
              </>
            )}
          </div>

          {migration.mailTotal > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-gray-600">
                <span>
                  {passComplete ? (
                    <>{migration.mailMigrated.toLocaleString()} messages importés</>
                  ) : (
                    <>
                      {migration.mailMigrated.toLocaleString()} / {migration.mailTotal.toLocaleString()} mails
                    </>
                  )}
                  {migration.mailFailed > 0 && (
                    <span className="ml-2 text-red-600">({migration.mailFailed} erreurs)</span>
                  )}
                </span>
                {/* Une fois l'import terminé, un pourcentage n'a plus de sens : le
                    total vient du comptage Exchange, le migré du décompte réel en
                    base, et les deux ne se recouvrent jamais exactement. */}
                <span>
                  {passComplete
                    ? migration.mailFailed > 0
                      ? 'terminé, avec erreurs'
                      : 'terminé'
                    : isPaused
                      ? `en pause — ${pct}%`
                      : `${pct}%`}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div
                  className={`h-full transition-all ${
                    passComplete
                      ? migration.mailFailed > 0
                        ? 'bg-red-400'
                        : 'bg-green-500'
                      : isPaused
                        ? 'bg-amber-500'
                        : 'bg-blue-500'
                  }`}
                  style={{ width: `${passComplete ? 100 : pct}%` }}
                />
              </div>
              {passComplete && migration.mailMigrated < migration.mailTotal && (
                <p className="mt-1 text-[10px] text-gray-500">
                  Exchange annonçait {migration.mailTotal.toLocaleString()} messages dans les dossiers
                  visibles. L’écart porte sur des éléments que l’import ne reprend pas (dossiers
                  masqués, éléments récupérables) — à recouper avec le nombre de conversations dans la
                  boîte Gmail si le chiffre te surprend.
                </p>
              )}
            </div>
          )}

          {/* Un import en pause n'est pas une erreur : son message passe en ambre. */}
          {isPaused && migration.mailError && (
            <div className="mt-3 flex items-start gap-1.5 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <Pause className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{migration.mailError}</span>
            </div>
          )}

          {(migration.createGroupError ||
            migration.createAccountError ||
            migration.licenseError ||
            migration.aliasSendAsError ||
            migration.delegatesError ||
            (!isPaused && migration.mailError)) && (
            <div className="mt-3 space-y-0.5 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
              {migration.createAccountError && <div>Compte : {migration.createAccountError}</div>}
              {migration.licenseError && <div>Licence : {migration.licenseError}</div>}
              {migration.aliasSendAsError && <div>Alias / send-as : {migration.aliasSendAsError}</div>}
              {migration.createGroupError && <div>Groupe : {migration.createGroupError}</div>}
              {!isPaused && migration.mailError && <div>Mail : {migration.mailError}</div>}
              {migration.delegatesError && <div>Délégations : {migration.delegatesError}</div>}
            </div>
          )}

          {migration.mailFailed > 0 && <MailErrorsPanel migration={migration} />}

          {isAccountMode && <AccountPanel migration={migration} />}
          {isAccountMode && <DelegatesPanel migration={migration} />}
          <DualDeliveryPanel migration={migration} />
          {!isAccountMode && <LegacyGroupPanel migration={migration} />}
        </div>
      )}
    </div>
  )
}
