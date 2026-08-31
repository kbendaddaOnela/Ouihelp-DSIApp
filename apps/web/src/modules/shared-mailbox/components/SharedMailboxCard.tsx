import { useState } from 'react'
import {
  Play,
  Square,
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
} from 'lucide-react'
import type { SharedMigrationRecord, StepStatus } from '@dsi-app/shared'
import {
  useRunSharedMigration,
  useStopSharedMigration,
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
  useAliasSendAs,
  useDelegateCandidates,
  useGoogleUserSearch,
  useAddDelegate,
  useRemoveDelegate,
  useApplyDelegates,
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

function StepBadge({ status, label }: { status: StepStatus; label: string }) {
  const map: Record<StepStatus, { cls: string; icon: React.ReactNode }> = {
    pending: { cls: 'bg-gray-100 text-gray-700', icon: <Loader2 className="h-3.5 w-3.5 animate-pulse" /> },
    running: { cls: 'bg-blue-100 text-blue-700', icon: <Loader2 className="h-3.5 w-3.5 animate-spin" /> },
    success: { cls: 'bg-green-100 text-green-700', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    error: { cls: 'bg-red-100 text-red-700', icon: <AlertCircle className="h-3.5 w-3.5" /> },
    skipped: { cls: 'bg-gray-100 text-gray-500', icon: null },
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
  const { mutate: stopMigration, isPending: isStopping } = useStopSharedMigration()
  const { mutate: deleteMigration, isPending: isDeleting } = useDeleteSharedMigration()

  const isAccountMode = migration.mode === 'account'
  const isInFlight = migration.stepMailImport === 'running' || migration.stepMailImport === 'pending'

  const pct = migration.mailTotal > 0
    ? Math.min(100, Math.round((migration.mailMigrated / migration.mailTotal) * 100))
    : 0

  const canRun =
    migration.stepMailImport !== 'running' && migration.stepMailImport !== 'pending'
  const canDelete = migration.stepMailImport !== 'running'
  // En mode compte, l'import n'a de sens qu'une fois la licence acquittée
  const runBlockedByLicense = isAccountMode && migration.stepLicense !== 'success'

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900">{migration.onelaDisplayName}</span>
            <span className="text-xs text-gray-500">{migration.onelaEmail}</span>
            {!isAccountMode && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                ancien mode : Google Group
              </span>
            )}
          </div>
          {isAccountMode ? (
            <div className="mt-1 text-sm text-gray-600">
              → <span className="font-mono text-xs">{migration.targetUserEmail}</span>{' '}
              <span className="text-gray-400">
                (alias <span className="font-mono">{migration.targetUserAlias}</span> — {migration.targetDisplayName})
              </span>
            </div>
          ) : (
            <div className="mt-1 text-sm text-gray-600">
              → <span className="font-mono text-xs">{migration.targetGroupEmail}</span>{' '}
              <span className="text-gray-400">({migration.targetGroupName})</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canRun && (
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
          {isInFlight && (
            <button
              onClick={() => {
                if (window.confirm("Arrêter la migration en cours ? Les messages déjà importés sont conservés ; tu pourras la relancer (reprise idempotente).")) {
                  stopMigration(migration.id)
                }
              }}
              disabled={isStopping}
              className="inline-flex items-center gap-1 rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
            >
              <Square className="h-3.5 w-3.5" />
              {isStopping ? 'Arrêt…' : 'Arrêter'}
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
              {migration.mailMigrated.toLocaleString()} / {migration.mailTotal.toLocaleString()} mails
              {migration.mailFailed > 0 && (
                <span className="ml-2 text-red-600">({migration.mailFailed} erreurs)</span>
              )}
            </span>
            <span>{pct}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {(migration.createGroupError ||
        migration.createAccountError ||
        migration.aliasSendAsError ||
        migration.delegatesError ||
        migration.mailError) && (
        <div className="mt-3 space-y-0.5 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          {migration.createAccountError && <div>Compte : {migration.createAccountError}</div>}
          {migration.aliasSendAsError && <div>Alias / send-as : {migration.aliasSendAsError}</div>}
          {migration.createGroupError && <div>Groupe : {migration.createGroupError}</div>}
          {migration.mailError && <div>Mail : {migration.mailError}</div>}
          {migration.delegatesError && <div>Délégations : {migration.delegatesError}</div>}
        </div>
      )}

      {isAccountMode && <AccountPanel migration={migration} />}
      {isAccountMode && <DelegatesPanel migration={migration} />}
      <DualDeliveryPanel migration={migration} />
      {!isAccountMode && <LegacyGroupPanel migration={migration} />}
    </div>
  )
}

// ── Compte Google + licence ─────────────────────────────────────────────────

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
        {migration.licenseAckAt && (
          <div className="text-gray-500">
            Licence acquittée le {new Date(migration.licenseAckAt).toLocaleString('fr-FR')}
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
            title="À cliquer une fois la licence Business Plus attribuée dans la console Google"
          >
            <BadgeCheck className="h-3 w-3" />
            {acking ? 'Vérification…' : 'Licence attribuée → lancer l’import'}
          </button>
        )}
        <button
          onClick={() => refetch()}
          className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Rafraîchir l’état
        </button>
        {migration.stepAliasSendAs !== 'success' && (
          <button
            onClick={() => fixAlias(migration.id, { onError: alertOnError('Poser l’alias / send-as') })}
            disabled={fixingAlias}
            className="rounded bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {fixingAlias ? 'Application…' : 'Poser alias + « Envoyer en tant que »'}
          </button>
        )}
      </div>

      {!licenseDone && (
        <p className="mt-2 text-[11px] text-gray-500">
          La licence est attribuée <strong>hors application</strong> (OU ou console Google Admin). Le bouton
          ci-dessus vérifie que la boîte Gmail est bien provisionnée avant de lancer l’import.
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

      {migration.delegates.length === 0 && (
        <p className="text-xs text-gray-500">
          Aucun délégué. Les personnes ajoutées ici verront la boîte partagée directement dans leur Gmail
          (sélecteur de compte), avec droit de lecture, réponse et envoi.
        </p>
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
