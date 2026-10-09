import { useState } from 'react'
import {
  Play,
  Pause,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mailbox,
  ShieldOff,
  UserPlus,
  X,
  BadgeCheck,
  Users,
  Archive,
  ArchiveRestore,
  RefreshCw,
  FileWarning,
  ChevronRight,
} from 'lucide-react'
import type { MailImportStatus, SharedMigrationRecord } from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import {
  useRunSharedMigration,
  usePauseSharedMigration,
  useResumeSharedMigration,
  useDeleteSharedMigration,
  useSharedDualDeliveryStatus,
  useEnableSharedDualDelivery,
  useDisableSharedDualDelivery,
  useAllowExternalGroupPosts,
  useEnableCollaborativeInbox,
  useSilenceMembers,
  useAddMigAlias,
  useSetupLabel,
  useSetupFilter,
  useSetupSendAs,
  useSharedAccountStatus,
  useLicenseAck,
  useSharedLicenseSkus,
  useAssignSharedLicense,
  useAliasSendAs,
  useDelegateCandidates,
  useGoogleUserSearch,
  useAddDelegate,
  useRemoveDelegate,
  useLiveDelegates,
  useApplyDelegates,
  useArchiveSharedMigration,
  useUnarchiveSharedMigration,
  useSharedMigrationErrors,
  useRetrySharedErrors,
} from '../hooks/useSharedMailbox'

interface Props {
  migration: SharedMigrationRecord
}

/** Message d'erreur lisible depuis une erreur axios ou JS. */
function errorMessage(err: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any
  const status = e?.response?.status
  const apiErr = e?.response?.data?.error
  if (status === 404 && !apiErr) {
    return 'Endpoint API introuvable (404) — le backend est probablement en cours de déploiement, réessaye dans 1-2 minutes.'
  }
  return apiErr || (err instanceof Error ? err.message : String(err))
}

const alertOnError = (action: string) => (err: unknown) =>
  window.alert(`${action} a échoué :\n\n${errorMessage(err)}`)

function StepBadge({ status, label }: { status: MailImportStatus; label: string }) {
  const map: Record<MailImportStatus, { cls: string; icon: React.ReactNode }> = {
    pending: { cls: 'bg-gray-100 text-gray-700', icon: <Loader2 className="h-3.5 w-3.5 animate-pulse" /> },
    running: { cls: 'bg-blue-100 text-blue-700', icon: <Loader2 className="h-3.5 w-3.5 animate-spin" /> },
    success: { cls: 'bg-green-100 text-green-700', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    error: { cls: 'bg-red-100 text-red-700', icon: <AlertCircle className="h-3.5 w-3.5" /> },
    skipped: { cls: 'bg-gray-100 text-gray-500', icon: null },
    paused: { cls: 'bg-amber-100 text-amber-800', icon: <Pause className="h-3.5 w-3.5" /> },
  }
  const m = map[status]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>
      {m.icon}
      {label}
    </span>
  )
}

export function SharedMailboxCard({ migration }: Props) {
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
                  onClick={() => {
                    if (
                      window.confirm(
                        isAccountMode
                          ? 'Supprimer le suivi de cette migration ?\n\nLe compte Google, sa licence et ses délégations ne sont PAS supprimés.'
                          : 'Supprimer cette migration (pas le groupe Google) ?',
                      )
                    )
                      deleteMigration(migration.id)
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
                  {isDone ? (
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
                <span>{isDone ? 'terminé' : isPaused ? `en pause — ${pct}%` : `${pct}%`}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div
                  className={`h-full transition-all ${
                    isDone ? 'bg-green-500' : isPaused ? 'bg-amber-500' : 'bg-blue-500'
                  }`}
                  style={{ width: `${isDone ? 100 : pct}%` }}
                />
              </div>
              {isDone && migration.mailMigrated < migration.mailTotal && (
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

// ── Messages en erreur + reprise ciblée ─────────────────────────────────────

function MailErrorsPanel({ migration }: { migration: SharedMigrationRecord }) {
  const [expanded, setExpanded] = useState(false)
  const { data, isFetching } = useSharedMigrationErrors(migration.id, expanded)
  const { mutate: retry, isPending: retrying } = useRetrySharedErrors()

  const isInFlight = migration.stepMailImport === 'running' || migration.stepMailImport === 'pending'
  // En pause, la reprise ciblée est bloquée : elle recalculerait l'état final de
  // l'étape et effacerait la pause alors que le balayage n'est pas terminé. De
  // toute façon « Reprendre » rejoue les erreurs (le delta est désactivé dès
  // qu'il en reste).
  const isPaused = migration.stepMailImport === 'paused'
  const errors = data?.errors ?? []

  return (
    <div className="mt-3 rounded border border-red-100 bg-red-50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-red-800">
          <FileWarning className="h-3.5 w-3.5" />
          {migration.mailFailed} message(s) en erreur
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded border border-red-200 bg-white px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50"
          >
            {expanded ? 'Masquer' : 'Voir le détail'}
          </button>
          <button
            onClick={() =>
              retry(migration.id, {
                onError: alertOnError('Reprise des erreurs'),
                onSuccess: (d) => window.alert(d.message),
              })
            }
            disabled={retrying || isInFlight || isPaused || migration.archived}
            title={
              isInFlight
                ? 'Un traitement est déjà en cours sur cette migration'
                : isPaused
                  ? 'Import en pause — clique « Reprendre » : la reprise rejoue aussi les erreurs'
                  : 'Rejoue uniquement les messages en erreur, sans reparcourir toute la boîte'
            }
            className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${retrying ? 'animate-spin' : ''}`} />
            Retenter ces {migration.mailFailed}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2">
          {isFetching && !data ? (
            <p className="text-[11px] text-gray-500">Chargement…</p>
          ) : errors.length === 0 ? (
            <p className="text-[11px] text-gray-500">Aucun détail disponible.</p>
          ) : (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {errors.map((e) => (
                <li key={e.id} className="rounded border border-red-100 bg-white px-2 py-1.5">
                  <div className="truncate text-[11px] font-medium text-gray-800">
                    {e.subject || '(sans objet)'}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {e.receivedAt ? new Date(e.receivedAt).toLocaleString('fr-FR') : 'date inconnue'}
                  </div>
                  <div className="mt-0.5 break-words text-[10px] text-red-700">{e.errorDetails}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ── Compte Google + licence ─────────────────────────────────────────────────

/**
 * Attribution d'une licence Workspace au compte partagé, directement depuis l'app.
 *
 * Les sièges affichés viennent du même endpoint que le module migration : une BAL
 * partagée consomme un siège comme un utilisateur nominatif, le compteur est donc
 * le même. Les totaux de sièges achetés restent en lecture seule ici — ils se
 * saisissent une seule fois dans le panneau licences du dashboard.
 */
function LicenseAssignBlock({ migration }: { migration: SharedMigrationRecord }) {
  const { data: skus, isLoading, isError, error, refetch } = useSharedLicenseSkus(true)
  const { mutate: assign, isPending: assigning } = useAssignSharedLicense()

  return (
    <div className="mt-3 rounded border border-gray-200 bg-gray-50/70 p-2.5">
      <div className="mb-1.5 text-[11px] font-semibold text-gray-700">
        Attribuer une licence à <span className="font-mono">{migration.targetUserEmail}</span>
      </div>

      {isLoading && (
        <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Chargement des licences…
        </p>
      )}

      {isError && (
        <div className="space-y-1">
          <p className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
            {error instanceof Error ? error.message : 'Erreur de récupération des licences'}
          </p>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700"
          >
            <RefreshCw className="h-3 w-3" /> Réessayer
          </button>
        </div>
      )}

      {skus && skus.length > 0 && (
        <div className="space-y-1.5">
          {skus.map((sku) => {
            const isAssigned = migration.licenseSkuId === sku.skuId
            const noneLeft = sku.remaining != null && sku.remaining <= 0
            return (
              <div
                key={`${sku.productId}|${sku.skuId}`}
                className="flex items-center gap-2 rounded-lg border border-gray-100 bg-white px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-gray-800">{sku.name}</div>
                  <div className="text-[11px] text-gray-500">
                    {sku.total != null ? (
                      <>
                        <span className={noneLeft ? 'font-medium text-red-600' : 'font-medium text-emerald-600'}>
                          {sku.remaining} restante{Math.abs(sku.remaining ?? 0) > 1 ? 's' : ''}
                        </span>
                        {' · '}
                        {sku.used}/{sku.total} utilisées
                      </>
                    ) : (
                      <>{sku.used} utilisées</>
                    )}
                  </div>
                </div>
                <button
                  onClick={() =>
                    assign(
                      { id: migration.id, productId: sku.productId, skuId: sku.skuId },
                      {
                        onError: alertOnError(`Attribuer « ${sku.name} »`),
                        onSuccess: (d) =>
                          window.alert(
                            d.mailboxReady
                              ? `Licence « ${sku.name} » attribuée. La boîte Gmail est prête : ` +
                                `clique « Lancer » quand tu veux démarrer l’import.`
                              : `Licence « ${sku.name} » attribuée.\n\nGmail met quelques minutes à se provisionner : ` +
                                `rafraîchis l’état, puis clique « Lancer » quand la boîte est prête.`,
                          ),
                      },
                    )
                  }
                  disabled={assigning || isAssigned}
                  title={isAssigned ? 'Déjà attribuée à ce compte' : undefined}
                  className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  {isAssigned ? '✓' : assigning ? '…' : 'Attribuer'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {skus && skus.length === 0 && !isError && (
        <p className="text-[11px] text-amber-600">
          Aucune licence détectée. Vérifie le scope DwD « apps.licensing » côté console Google.
        </p>
      )}
    </div>
  )
}

function AccountPanel({ migration }: { migration: SharedMigrationRecord }) {
  const accountCreated = migration.stepCreateAccount === 'success'
  const { data, isLoading, refetch } = useSharedAccountStatus(migration.id, accountCreated)
  const { mutate: ackLicense, isPending: acking } = useLicenseAck()
  const { mutate: fixAlias, isPending: fixingAlias } = useAliasSendAs()

  if (!accountCreated) {
    return (
      <div className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500">
        Le compte Google sera créé au lancement de la migration.
      </div>
    )
  }

  const licenseDone = migration.stepLicense === 'success'

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-700">
          <BadgeCheck className="h-3.5 w-3.5" />
          Compte Google &amp; licence
        </div>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>

      <div className="space-y-1.5 text-xs text-gray-600">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${data?.exists ? 'bg-green-500' : 'bg-gray-300'}`} />
          Compte&nbsp;: <span className="font-mono">{migration.targetUserEmail}</span>
          {data?.orgUnitPath && <span className="text-gray-400">— OU {data.orgUnitPath}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${data?.aliasPresent ? 'bg-green-500' : 'bg-gray-300'}`} />
          Alias&nbsp;: <span className="font-mono">{migration.targetUserAlias}</span>
          <span className="text-gray-400">{data?.aliasPresent ? '(posé)' : '(absent)'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${data?.mailboxReady ? 'bg-green-500' : 'bg-orange-400'}`} />
          Boîte Gmail provisionnée&nbsp;:{' '}
          <span className={data?.mailboxReady ? 'text-gray-800' : 'text-orange-600'}>
            {data?.mailboxReady ? 'oui' : 'non — licence Business Plus à attribuer'}
          </span>
        </div>
        {migration.licenseSkuName && (
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
            Licence&nbsp;: <span className="font-medium text-gray-800">{migration.licenseSkuName}</span>
            <span className="text-gray-400">(attribuée depuis l’app)</span>
          </div>
        )}
        {migration.licenseAckAt && (
          <div className="text-gray-500">
            Licence {migration.licenseSkuName ? 'attribuée' : 'acquittée'} le{' '}
            {new Date(migration.licenseAckAt).toLocaleString('fr-FR')}
            {migration.licenseAckBy ? ` par ${migration.licenseAckBy}` : ''}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {!licenseDone && (
          <button
            onClick={() =>
              ackLicense(migration.id, {
                onError: alertOnError('Acquitter la licence'),
              })
            }
            disabled={acking}
            className="inline-flex items-center gap-1 rounded bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            title="À cliquer si la licence a été posée dans la console Google ou par l’OU. Ne démarre pas l’import."
          >
            <BadgeCheck className="h-3 w-3" />
            {acking ? 'Vérification…' : 'Licence déjà attribuée (hors app)'}
          </button>
        )}
        <button
          onClick={() => refetch()}
          className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Rafraîchir l’état
        </button>
        <button
          onClick={() => fixAlias(migration.id, { onError: alertOnError('Réappliquer nom / alias / send-as') })}
          disabled={fixingAlias}
          title="Réaligne le nom du compte, l’alias et l’identité d’envoi par défaut"
          className="rounded bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {fixingAlias ? 'Application…' : 'Réappliquer nom + alias + « Envoyer en tant que »'}
        </button>
      </div>

      {!licenseDone && <LicenseAssignBlock migration={migration} />}

      {!licenseDone && (
        <p className="mt-2 text-[11px] text-gray-500">
          Deux voies&nbsp;: <strong>attribuer</strong> une licence ci-dessus (elle est posée
          immédiatement via l’API Google), ou la poser hors app (OU / console Admin) puis cliquer
          « Licence déjà attribuée », qui vérifie que la boîte Gmail est bien provisionnée. Dans
          les deux cas l’import <strong>ne démarre pas tout seul</strong>&nbsp;: c’est le bouton
          « Lancer » qui le déclenche, au moment que tu choisis.
        </p>
      )}
    </div>
  )
}

// ── Délégations Gmail ───────────────────────────────────────────────────────

function DelegatesPanel({ migration }: { migration: SharedMigrationRecord }) {
  const [showCandidates, setShowCandidates] = useState(false)
  const [search, setSearch] = useState('')

  const { data: candidatesData, isFetching: loadingCandidates } = useDelegateCandidates(
    migration.id,
    showCandidates,
  )
  const { data: searchData, isFetching: searching } = useGoogleUserSearch(search)
  // Compté côté Google et non depuis notre table : le plafond de délégations
  // s'applique à la boîte, et une délégation posée hors app compte aussi.
  const { data: liveData } = useLiveDelegates(migration.id, migration.stepCreateAccount === 'success')
  const { mutate: addDelegate, isPending: adding } = useAddDelegate()
  const { mutate: removeDelegate, isPending: removing } = useRemoveDelegate()
  const { mutate: applyDelegates, isPending: applying } = useApplyDelegates()

  const add = (googleEmail: string, sourceUpn?: string | null) =>
    addDelegate(
      { id: migration.id, googleEmail, sourceUpn },
      { onError: alertOnError(`Ajouter ${googleEmail}`), onSuccess: () => setSearch('') },
    )

  const candidates = candidatesData?.candidates ?? []
  const unresolved = candidates.filter((c) => !c.googleEmail)

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-700">
          <Users className="h-3.5 w-3.5" />
          Délégations Gmail ({migration.delegates.length})
          {liveData && (
            <span className="font-normal text-gray-400">
              — {liveData.delegates.length} posée{liveData.delegates.length > 1 ? 's' : ''} côté Gmail
            </span>
          )}
        </div>
        <button
          onClick={() =>
            applyDelegates(migration.id, {
              onError: alertOnError('Appliquer les délégations'),
              onSuccess: (d) =>
                window.alert(`Délégations : ${d.applied}/${d.total} appliquées, ${d.failed} en erreur.`),
            })
          }
          disabled={applying || migration.delegates.length === 0}
          className="rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {applying ? 'Application…' : 'Réappliquer'}
        </button>
      </div>

      {migration.delegates.some((d) => d.errorDetails?.includes('refuse une délégation de plus')) && (
        <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          Le refus porte sur la <strong>boîte</strong>, pas sur les comptes ajoutés. Sur une boîte
          créée récemment, Google bloque souvent bien avant les 25 délégations documentées et le
          quota se libère de lui-même&nbsp;: réessaie « Réappliquer » dans quelques heures, seules
          les manquantes seront reposées.
        </p>
      )}

      <p className="mb-2 text-[11px] text-gray-500">
        Le délégué n’a <strong>rien à connecter</strong> : la boîte apparaît dans le sélecteur de compte
        de son Gmail (menu avatar), sous son propre compte, avec lecture, réponse et envoi. « Ajouter un
        compte » n’est pas la bonne porte — le compte partagé n’a pas d’identité SSO.
      </p>
      {migration.delegates.length === 0 && (
        <p className="text-xs text-gray-500">Aucun délégué pour l’instant.</p>
      )}

      {migration.delegates.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded border border-gray-200">
          {migration.delegates.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium text-gray-800">{d.displayName ?? d.googleEmail}</div>
                <div className="truncate font-mono text-[11px] text-gray-500">
                  {d.googleEmail}
                  {d.sourceUpn && <span className="ml-1 text-gray-400">(Exchange : {d.sourceUpn})</span>}
                </div>
                {d.status === 'error' && d.errorDetails && (
                  <div className="mt-0.5 text-[11px] text-red-600">{d.errorDetails}</div>
                )}
                {d.status === 'success' && d.verificationStatus && d.verificationStatus !== 'accepted' && (
                  <div className="mt-0.5 text-[11px] text-orange-600">
                    Google : <span className="font-mono">{d.verificationStatus}</span> — la boîte
                    n’apparaîtra dans le Gmail du délégué qu’une fois la délégation acceptée
                    (mail de confirmation envoyé par Google à {d.googleEmail}).
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <StepBadge status={d.status} label={d.status} />
                <button
                  onClick={() => {
                    if (window.confirm(`Retirer la délégation de ${d.googleEmail} ?`))
                      removeDelegate(
                        { id: migration.id, delegateId: d.id },
                        { onError: alertOnError('Retirer le délégué') },
                      )
                  }}
                  disabled={removing}
                  className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  title="Retirer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Ajout : depuis Exchange, ou par recherche annuaire */}
      <div className="mt-3 space-y-2">
        <button
          onClick={() => setShowCandidates((v) => !v)}
          className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
        >
          {showCandidates ? 'Masquer' : 'Proposer depuis les accès Exchange (FullAccess)'}
        </button>

        {showCandidates && (
          <div className="rounded border border-gray-100 bg-gray-50 p-2.5">
            {loadingCandidates && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Lecture des permissions Exchange…
              </div>
            )}
            {!loadingCandidates && candidates.length === 0 && (
              <p className="text-xs text-gray-500">
                Aucun accès FullAccess trouvé sur cette boîte partagée.
              </p>
            )}
            {candidates.length > 0 && (
              <ul className="space-y-1">
                {candidates.map((c) => (
                  <li key={c.sourceUpn} className="flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <span className="font-mono text-[11px] text-gray-600">{c.sourceUpn}</span>
                      {c.googleEmail ? (
                        <span className="ml-1 text-gray-500">
                          → <span className="font-mono">{c.googleEmail}</span>
                          {c.displayName && <span className="ml-1 text-gray-400">({c.displayName})</span>}
                        </span>
                      ) : (
                        <span className="ml-1 text-orange-600">compte Google non retrouvé</span>
                      )}
                    </div>
                    {c.googleEmail && !c.alreadyAdded && (
                      <button
                        onClick={() => add(c.googleEmail!, c.sourceUpn)}
                        disabled={adding}
                        className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        <UserPlus className="h-3 w-3" /> Ajouter
                      </button>
                    )}
                    {c.alreadyAdded && <span className="text-[11px] text-gray-400">déjà délégué</span>}
                  </li>
                ))}
              </ul>
            )}
            {unresolved.length > 0 && (
              <p className="mt-2 text-[11px] text-gray-500">
                Les comptes non retrouvés n’ont pas encore été migrés (l’adresse Exchange{' '}
                <code>pnom@onela.com</code> et le compte Google <code>prenom.nom@mig.onela.com</code> sont
                deux identités distinctes). Ajoute-les à la main ci-dessous une fois leur migration faite.
              </p>
            )}
          </div>
        )}

        <div>
          <label className="mb-1 block text-[11px] text-gray-600">
            Ajouter depuis l’annuaire Google (nom ou début d’adresse)
          </label>
          <div className="relative">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="dupont…"
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {searching && (
              <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-gray-400" />
            )}
          </div>
          {(searchData?.users.length ?? 0) > 0 && (
            <ul className="mt-1 max-h-40 divide-y divide-gray-100 overflow-y-auto rounded border border-gray-200">
              {searchData!.users.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 px-2 py-1 text-xs">
                  <div className="min-w-0">
                    <div className="truncate text-gray-800">{u.displayName}</div>
                    <div className="truncate font-mono text-[11px] text-gray-500">{u.primaryEmail}</div>
                  </div>
                  <button
                    onClick={() => add(u.primaryEmail)}
                    disabled={adding || u.suspended}
                    title={u.suspended ? 'Compte suspendu' : undefined}
                    className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <UserPlus className="h-3 w-3" /> Ajouter
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Dual delivery (commun aux deux modes) ───────────────────────────────────

function DualDeliveryPanel({ migration }: { migration: SharedMigrationRecord }) {
  const targetReady =
    migration.mode === 'account'
      ? migration.stepCreateAccount === 'success'
      : migration.stepCreateGroup === 'success'
  const { data, isLoading } = useSharedDualDeliveryStatus(migration.id, targetReady)
  const { mutate: enableRaw, isPending: enabling } = useEnableSharedDualDelivery()
  const { mutate: disableRaw, isPending: disabling } = useDisableSharedDualDelivery()
  const [bccInput, setBccInput] = useState<string>('')

  if (!targetReady) return null

  const forwarding = data?.forwarding
  const isActive = !!forwarding?.active
  const expectedRouting = data?.expectedRoutingAddress ?? undefined
  const wrongTarget =
    isActive && expectedRouting && forwarding?.forwardTo?.toLowerCase() !== expectedRouting.toLowerCase()

  const enable = (bccAddress?: string) =>
    enableRaw({ id: migration.id, bccAddress }, { onError: alertOnError('Activer dual delivery') })
  const disable = (id: string) => disableRaw(id, { onError: alertOnError('Désactiver dual delivery') })

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-700">
          <Mailbox className="h-3.5 w-3.5" />
          Dual delivery
        </div>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>

      <div className="space-y-1.5 text-xs text-gray-600">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
          Transport rule (BCC routage Google)&nbsp;:{' '}
          {forwarding?.forwardTo ? (
            <span className={`font-mono ${isActive ? 'text-gray-800' : 'text-orange-600'}`}>
              → {forwarding.forwardTo}
              {wrongTarget && (
                <span className="ml-1 text-orange-600">(⚠ doit être {expectedRouting} ; cliquer pour mettre à jour)</span>
              )}
            </span>
          ) : (
            <span className="text-gray-500">aucune</span>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {(!isActive || wrongTarget) && (
          <div>
            <label className="mb-1 block text-xs text-gray-600">
              Adresse de routage BCC&nbsp;:
              <span className="ml-1 text-gray-400">
                (défaut&nbsp;: {migration.mode === 'account' ? 'adresse primaire du compte' : 'alias mig.<domaine> du groupe'})
              </span>
            </label>
            <input
              type="email"
              value={bccInput}
              onChange={(e) => setBccInput(e.target.value)}
              placeholder={expectedRouting ?? ''}
              className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Le BCC vise le domaine de transition <code>mig.onela.com</code> : l’adresse historique de la
              BAL reste autoritative côté Exchange, donc router dessus créerait une boucle.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {(!isActive || wrongTarget) && (
            <button
              onClick={() => enable(bccInput.trim() || undefined)}
              disabled={enabling}
              className="inline-flex items-center gap-1 rounded bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              <Mailbox className="h-3 w-3" />
              {enabling ? 'Activation…' : isActive ? 'Mettre à jour' : 'Activer dual delivery'}
            </button>
          )}
          {isActive && !wrongTarget && (
            <button
              onClick={() => {
                if (window.confirm('Désactiver le dual delivery (supprimer la transport rule) ?')) {
                  disable(migration.id)
                }
              }}
              disabled={disabling}
              className="inline-flex items-center gap-1 rounded bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
            >
              <ShieldOff className="h-3 w-3" />
              {disabling ? 'Désactivation…' : 'Désactiver dual delivery'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Réglages spécifiques aux anciennes migrations « Google Group » ──────────

function LegacyGroupPanel({ migration }: { migration: SharedMigrationRecord }) {
  const groupReady = migration.stepCreateGroup === 'success' && !!migration.targetGroupEmail
  const { data } = useSharedDualDeliveryStatus(migration.id, groupReady)
  const { mutate: allowExternalRaw, isPending: opening } = useAllowExternalGroupPosts()
  const { mutate: enableCollabRaw, isPending: enablingCollab } = useEnableCollaborativeInbox()
  const { mutate: silenceRaw, isPending: silencing } = useSilenceMembers()
  const { mutate: addAliasRaw, isPending: addingAlias } = useAddMigAlias()
  const { mutate: setupLabelRaw, isPending: settingUpLabel } = useSetupLabel()
  const { mutate: setupFilterRaw, isPending: settingUpFilter } = useSetupFilter()
  const { mutate: setupSendAsRaw, isPending: settingUpSendAs } = useSetupSendAs()

  if (!groupReady) return null

  const groupEmail = migration.targetGroupEmail!
  const groupName = migration.targetGroupName ?? migration.onelaDisplayName
  const allowsExternal = data?.groupAllowsExternalPosts ?? false
  const collaborativeInboxOn = data?.groupCollaborativeInbox ?? false

  const bulkResultAlert =
    (action: string) =>
    (d: { total: number; created: number; alreadyOk: number; failed: number; failedMembers: string[] }) =>
      window.alert(
        `${action}\n\nMembres traités : ${d.total}\n• Créés : ${d.created}\n• Déjà OK : ${d.alreadyOk}\n• Échecs : ${d.failed}` +
          (d.failedMembers.length ? `\n\nÉchecs sur :\n- ${d.failedMembers.slice(0, 10).join('\n- ')}` : ''),
      )

  return (
    <div className="mt-4 rounded border border-amber-100 bg-amber-50 p-2.5">
      <div className="mb-2 text-[11px] font-semibold text-amber-900">
        Réglages « Google Group » (ancien mode — conservés pour cette migration)
      </div>
      <div className="flex flex-wrap gap-2">
        {!allowsExternal && (
          <button
            onClick={() => {
              if (
                window.confirm(
                  "Ouvrir le groupe à TOUS les expéditeurs externes (ANYONE_CAN_POST) ?\n\nNécessaire pour que les mails BCC arrivent dans l'archive.",
                )
              )
                allowExternalRaw(migration.id, { onError: alertOnError('Ouvrir le groupe aux externes') })
            }}
            disabled={opening}
            className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {opening ? 'Ouverture…' : 'Ouvrir le groupe aux externes'}
          </button>
        )}
        {!collaborativeInboxOn && (
          <button
            onClick={() => {
              if (window.confirm('Activer la boîte de réception collaborative sur ce groupe ?'))
                enableCollabRaw(migration.id, { onError: alertOnError('Activer la boîte collaborative') })
            }}
            disabled={enablingCollab}
            className="rounded bg-purple-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {enablingCollab ? 'Activation…' : 'Activer boîte collaborative'}
          </button>
        )}
        <button
          onClick={() =>
            addAliasRaw(migration.id, {
              onError: alertOnError("Ajouter l'alias @mig.onela.com"),
              onSuccess: (d) =>
                window.alert(d.added ? `Alias ajouté : ${d.alias}` : `Alias déjà présent : ${d.alias}`),
            })
          }
          disabled={addingAlias}
          className="rounded bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {addingAlias ? 'Ajout…' : 'Ajouter alias @mig.onela.com'}
        </button>
        <button
          onClick={() => {
            if (window.confirm("Passer TOUS les membres en mode silencieux (delivery_settings='NONE') ?"))
              silenceRaw(migration.id, {
                onError: alertOnError('Désactiver le fan-out membres'),
                onSuccess: (d) =>
                  window.alert(
                    `Membres traités : ${d.total}\n• Mis en silencieux : ${d.updated}\n• Déjà silencieux : ${d.alreadySilent}\n• Échecs : ${d.failed}`,
                  ),
              })
          }}
          disabled={silencing}
          className="rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {silencing ? 'Application…' : "Pas d'email aux membres"}
        </button>
        <button
          onClick={() => {
            if (window.confirm(`Créer le libellé "${groupName}" dans le Gmail de tous les membres ?`))
              setupLabelRaw(migration.id, {
                onError: alertOnError('Créer le libellé aux membres'),
                onSuccess: bulkResultAlert('Libellé Gmail créé'),
              })
          }}
          disabled={settingUpLabel}
          className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {settingUpLabel ? 'Création…' : `Créer libellé "${groupName}"`}
        </button>
        <button
          onClick={() => {
            if (window.confirm(`Créer un filtre Gmail chez tous les membres ?\n\nCritère : to:${groupEmail}`))
              setupFilterRaw(migration.id, {
                onError: alertOnError('Créer le filtre aux membres'),
                onSuccess: (d) =>
                  window.alert(
                    `Filtre Gmail créé\n\nMembres traités : ${d.total}\n• Créés : ${d.created}\n• Déjà OK : ${d.alreadyOk}\n• Échecs : ${d.failed}\n\nMails existants reclassés : ${d.backfilledMessages}`,
                  ),
              })
          }}
          disabled={settingUpFilter}
          className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {settingUpFilter ? 'Création…' : 'Créer règle de tri'}
        </button>
        <button
          onClick={() => {
            if (window.confirm(`Ajouter "Envoyer en tant que ${groupEmail}" chez tous les membres ?`))
              setupSendAsRaw(migration.id, {
                onError: alertOnError('Ajouter "Envoyer en tant que"'),
                onSuccess: bulkResultAlert('"Envoyer en tant que" ajouté'),
              })
          }}
          disabled={settingUpSendAs}
          className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {settingUpSendAs ? 'Ajout…' : 'Ajouter "Envoyer en tant que"'}
        </button>
      </div>
    </div>
  )
}
