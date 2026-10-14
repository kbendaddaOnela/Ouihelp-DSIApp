import { useState } from 'react'
import {
  Loader2,
  UserPlus,
  X,
  Users,
} from 'lucide-react'
import type { SharedMigrationRecord } from '@dsi-app/shared'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  useDelegateCandidates,
  useGoogleUserSearch,
  useAddDelegate,
  useRemoveDelegate,
  useLiveDelegates,
  useApplyDelegates,
} from '../hooks/useSharedMailbox'
import { useAlertOnError, StepBadge } from './cardShared'

// ── Délégations Gmail ───────────────────────────────────────────────────────

export function DelegatesPanel({ migration }: { migration: SharedMigrationRecord }) {
  const alertOnError = useAlertOnError()
  const { confirm, alert } = useConfirm()
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
                void alert({
                  title: 'Délégations réappliquées',
                  tone: d.failed > 0 ? 'danger' : 'default',
                  message: `${d.applied}/${d.total} appliquées, ${d.failed} en erreur.`,
                }),
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
                  onClick={async () => {
                    const res = await confirm({
                      title: 'Retirer la délégation',
                      tone: 'danger',
                      confirmLabel: 'Retirer',
                      message: `Retirer la délégation de ${d.googleEmail} sur cette boîte ?`,
                    })
                    if (res.confirmed)
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
