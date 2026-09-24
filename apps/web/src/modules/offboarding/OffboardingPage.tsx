import { useEffect, useState } from 'react'
import { UserMinus, Info, X, Loader2, KeyRound, Users, CheckCircle2, AlertTriangle, History, Inbox } from 'lucide-react'
import type { OffboardingGoogleUser, OffboardingUserDetail, ResetPasswordResponse } from '@dsi-app/shared'
import { usePermission } from '@/hooks/usePermission'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { CopyButton } from '@/modules/migration/components/CopyButton'
import {
  useOffboardingSearch,
  useOffboardingUser,
  useOffboardingHistory,
  useOffboardingDelegations,
  useResetPassword,
  useAddOffboardingDelegate,
  useRemoveOffboardingDelegate,
} from './hooks'

const inputCls =
  'w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500'

// ── Autocomplétion annuaire Google ───────────────────────────────────────────
function GoogleUserPicker({
  placeholder,
  excludeEmail,
  onSelect,
}: {
  placeholder: string
  excludeEmail?: string
  onSelect: (u: OffboardingGoogleUser) => void
}) {
  const [input, setInput] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 300)
    return () => clearTimeout(t)
  }, [input])

  const { data, isFetching, error } = useOffboardingSearch(debounced)
  const users = (data?.users ?? []).filter(
    (u) => u.primaryEmail.toLowerCase() !== excludeEmail?.toLowerCase(),
  )

  return (
    <div className="relative">
      <input
        className={inputCls}
        placeholder={placeholder}
        value={input}
        onChange={(e) => {
          setInput(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        autoComplete="off"
      />
      {isFetching && <Loader2 className="absolute right-2 top-2.5 h-4 w-4 animate-spin text-gray-400" />}
      {open && debounced.length >= 2 && (data || error) && (
        <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg">
          {error ? (
            <div className="px-3 py-2 text-xs text-red-600">{(error as Error).message}</div>
          ) : users.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400">Aucun résultat dans Google</div>
          ) : (
            users.map((u) => (
              <button
                key={u.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(u)
                  setOpen(false)
                  setInput('')
                }}
                className="block w-full px-3 py-2 text-left hover:bg-primary-50"
              >
                <div className="flex items-center gap-2 text-sm font-medium text-gray-800">
                  {u.displayName}
                  {u.suspended && (
                    <span className="rounded bg-red-50 px-1.5 text-[10px] font-medium text-red-600">suspendu</span>
                  )}
                </div>
                <div className="truncate text-xs text-gray-400">
                  {u.primaryEmail} · {u.orgUnitPath}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Résumé du compte ciblé ───────────────────────────────────────────────────
function UserSummary({ detail, onClear }: { detail: OffboardingUserDetail; onClear: () => void }) {
  const { google, entra, entraError } = detail
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-gray-900">{google.displayName}</h2>
            {google.suspended && (
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-600">
                Google suspendu
              </span>
            )}
          </div>
          <p className="truncate font-mono text-xs text-gray-500">{google.primaryEmail}</p>
        </div>
        <button onClick={onClear} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" title="Changer d'utilisateur">
          <X className="h-4 w-4" />
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-gray-400">OU Google</dt>
          <dd className="font-mono text-gray-700">{google.orgUnitPath}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Alias</dt>
          <dd className="break-all font-mono text-gray-700">{google.aliases.join(', ') || '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-gray-400">Compte Entra GOH (Ouihelp)</dt>
          <dd className="text-gray-700">
            {entra ? (
              <>
                <span className="font-mono">{entra.userPrincipalName}</span>
                <span className={entra.accountEnabled ? 'ml-2 text-green-600' : 'ml-2 text-red-600'}>
                  {entra.accountEnabled ? 'actif' : 'désactivé'}
                </span>
              </>
            ) : entraError ? (
              <span className="text-red-600">Erreur : {entraError}</span>
            ) : (
              <span className="text-orange-600">Introuvable — le changement de mot de passe est impossible</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  )
}

// ── Mot de passe Entra GOH ───────────────────────────────────────────────────
function PasswordPanel({ detail, canWrite }: { detail: OffboardingUserDetail; canWrite: boolean }) {
  const [mode, setMode] = useState<'generate' | 'custom'>('generate')
  const [custom, setCustom] = useState('')
  const [revoke, setRevoke] = useState(true)
  const [result, setResult] = useState<ResetPasswordResponse | null>(null)
  const reset = useResetPassword()

  const disabled = !canWrite || !detail.entra || reset.isPending || (mode === 'custom' && custom.length < 8)

  const submit = () => {
    if (!window.confirm(`Changer le mot de passe Entra GOH de ${detail.google.displayName} ?`)) return
    setResult(null)
    reset.mutate(
      {
        email: detail.google.primaryEmail,
        password: mode === 'custom' ? custom : undefined,
        revokeSessions: revoke,
      },
      { onSuccess: (r) => { setResult(r); setCustom('') } },
    )
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-800">
        <KeyRound className="h-4 w-4 text-primary-600" /> Mot de passe Entra GOH
      </h3>
      <p className="mb-3 text-xs text-gray-500">
        La connexion Google passe par Entra (SSO) : changer ce mot de passe coupe l’accès de l’utilisateur.
      </p>

      <div className="space-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === 'generate'} onChange={() => setMode('generate')} />
          Générer un mot de passe fort
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} />
          Saisir un mot de passe
        </label>
        {mode === 'custom' && (
          <input
            type="text"
            className={inputCls}
            placeholder="8 caractères min., 3 types parmi majuscule / minuscule / chiffre / symbole"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            autoComplete="off"
          />
        )}
        <label className="flex items-center gap-2 pt-1 text-xs text-gray-600">
          <input type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} />
          Révoquer les sessions en cours (déconnexion des appareils)
        </label>
      </div>

      <Button className="mt-3" onClick={submit} disabled={disabled}>
        {reset.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        Changer le mot de passe
      </Button>

      {reset.error && (
        <p className="mt-3 flex gap-1.5 text-xs text-red-600">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {(reset.error as Error).message}
        </p>
      )}
      {result && (
        <div className="mt-3 rounded-md border border-green-200 bg-green-50 p-3 text-xs text-green-900">
          <p className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="h-4 w-4" /> Mot de passe changé pour {result.entraUpn}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <code className="rounded bg-white px-2 py-1 font-mono text-sm text-gray-900">{result.password}</code>
            <CopyButton text={result.password} />
          </div>
          <p className="mt-1 text-[11px] text-green-800">Affiché une seule fois, non conservé par l’application.</p>
          {result.revokeError ? (
            <p className="mt-1 text-orange-700">Révocation des sessions échouée : {result.revokeError}</p>
          ) : result.sessionsRevoked ? (
            <p className="mt-1">Sessions révoquées.</p>
          ) : null}
        </div>
      )}
    </section>
  )
}

// ── Délégation de la boîte Gmail ─────────────────────────────────────────────
function DelegationPanel({ detail, canWrite }: { detail: OffboardingUserDetail; canWrite: boolean }) {
  const add = useAddOffboardingDelegate()
  const remove = useRemoveOffboardingDelegate()
  const email = detail.google.primaryEmail

  const onSelect = (u: OffboardingGoogleUser) => {
    if (!window.confirm(`Donner à ${u.displayName} (${u.primaryEmail}) l’accès à la boîte de ${detail.google.displayName} ?`)) return
    add.mutate({ email, delegateEmail: u.primaryEmail })
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-800">
        <Users className="h-4 w-4 text-primary-600" /> Délégation de la boîte mail
      </h3>
      <p className="mb-3 text-xs text-gray-500">
        Le délégué retrouve la boîte dans le sélecteur de compte de son Gmail (menu avatar) : lecture,
        réponse et envoi, sans rien connecter. Propagation jusqu’à quelques heures côté Google.
      </p>

      {detail.delegatesError ? (
        <p className="mb-3 text-xs text-orange-600">{detail.delegatesError}</p>
      ) : detail.delegates.length === 0 ? (
        <p className="mb-3 text-xs text-gray-400">Aucune délégation en place.</p>
      ) : (
        <ul className="mb-3 divide-y divide-gray-100 rounded border border-gray-200">
          {detail.delegates.map((d) => (
            <li key={d.delegateEmail} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
              <div className="min-w-0">
                <div className="truncate font-mono text-gray-800">{d.delegateEmail}</div>
                {d.verificationStatus && d.verificationStatus !== 'accepted' && (
                  <div className="text-[11px] text-orange-600">Google : {d.verificationStatus}</div>
                )}
              </div>
              {canWrite && (
                <button
                  onClick={() => {
                    if (window.confirm(`Retirer la délégation de ${d.delegateEmail} ?`))
                      remove.mutate({ email, delegate: d.delegateEmail })
                  }}
                  disabled={remove.isPending}
                  className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  title="Retirer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && !detail.delegatesError && (
        <div className="space-y-1">
          <GoogleUserPicker
            placeholder="Déléguer à… (nom ou adresse Google)"
            excludeEmail={email}
            onSelect={onSelect}
          />
          {add.isPending && (
            <p className="flex items-center gap-1.5 text-xs text-gray-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Ajout de la délégation…
            </p>
          )}
        </div>
      )}
      {add.error && <p className="mt-2 text-xs text-red-600">{(add.error as Error).message}</p>}
      {remove.error && <p className="mt-2 text-xs text-red-600">{(remove.error as Error).message}</p>}
      {add.isSuccess && !add.isPending && (
        <p className="mt-2 text-xs text-green-700">
          {add.data.created ? 'Délégation ajoutée' : 'Délégation déjà en place'} pour {add.data.delegateEmail}.
        </p>
      )}
    </section>
  )
}

// ── Délégations actives (toutes boîtes déléguées via le module) ─────────────
function ActiveDelegations({ canWrite, onOpen }: { canWrite: boolean; onOpen: (email: string) => void }) {
  const { data, isLoading } = useOffboardingDelegations()
  const remove = useRemoveOffboardingDelegate()

  return (
    <div className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
        <Inbox className="h-4 w-4" /> Délégations actives
      </h2>
      {isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : !data || data.mailboxes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 py-8 text-center text-sm text-gray-400">
          Aucune délégation active.
        </p>
      ) : (
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {data.mailboxes.map((mb) => (
            <div key={mb.email} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <button onClick={() => onOpen(mb.email)} className="min-w-0 text-left hover:underline" title="Ouvrir la fiche">
                  <div className="truncate text-sm font-medium text-gray-800">{mb.displayName ?? mb.email}</div>
                  <div className="truncate font-mono text-[11px] text-gray-400">{mb.email}</div>
                </button>
              </div>
              {mb.error && <p className="mt-1 text-[11px] text-orange-600">{mb.error}</p>}
              {mb.delegates.length === 0 ? (
                <p className="mt-1 text-xs text-gray-400">Aucun délégué.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {mb.delegates.map((d) => (
                    <li
                      key={d.delegateEmail}
                      className="flex items-center justify-between gap-2 rounded bg-gray-50 px-2.5 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-gray-400">→ </span>
                        <span className="font-mono text-gray-800">{d.delegateEmail}</span>
                        {d.verificationStatus && d.verificationStatus !== 'accepted' && (
                          <span className="ml-2 text-orange-600">({d.verificationStatus})</span>
                        )}
                      </span>
                      {canWrite && (
                        <button
                          onClick={() => {
                            if (window.confirm(`Retirer l’accès de ${d.delegateEmail} à la boîte ${mb.email} ?`))
                              remove.mutate({ email: mb.email, delegate: d.delegateEmail })
                          }}
                          disabled={remove.isPending}
                          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" /> Retirer
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      {remove.error && <p className="text-xs text-red-600">{(remove.error as Error).message}</p>}
    </div>
  )
}

// ── Journal ──────────────────────────────────────────────────────────────────
const ACTION_LABELS = {
  reset_password: 'Mot de passe',
  add_delegate: 'Délégation +',
  remove_delegate: 'Délégation −',
} as const

function HistoryList() {
  const { data, isLoading } = useOffboardingHistory()
  return (
    <div className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
        <History className="h-4 w-4" /> Journal des actions
      </h2>
      {isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : !data || data.actions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 py-8 text-center text-sm text-gray-400">
          Aucune action pour l’instant.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Utilisateur</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Détail</th>
                <th className="px-3 py-2 font-medium">Par</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.actions.map((a) => (
                <tr key={a.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                    {new Date(a.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-gray-800">{a.targetDisplayName ?? a.targetEmail}</div>
                    {a.targetDisplayName && <div className="font-mono text-[11px] text-gray-400">{a.targetEmail}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className={a.status === 'success' ? 'text-green-700' : 'text-red-600'}>
                      {ACTION_LABELS[a.action]} {a.status === 'success' ? '✓' : '✗'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {a.detail}
                    {a.errorDetails && <div className="mt-0.5 break-all text-[11px] text-red-600">{a.errorDetails}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-500">{a.initiatedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function OffboardingPage() {
  const canWrite = usePermission('offboarding:write')
  const [selected, setSelected] = useState<string | null>(null)
  const { data: detail, isLoading, error } = useOffboardingUser(selected)

  return (
    <div className="mx-auto max-w-5xl space-y-6 py-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50">
          <UserMinus className="h-5 w-5 text-primary-600" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Offboarding</h1>
          <p className="text-sm text-gray-500">Départ d’un collaborateur ONELA</p>
        </div>
      </div>

      <div className="flex gap-2 rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-xs text-blue-900">
        <Info className="h-4 w-4 shrink-0 text-blue-500" />
        <p>
          Changer le mot de passe Entra GOH coupe l’accès, puis déléguer la boîte Gmail à un collègue
          pour qu’il reprenne les échanges. <strong>Ne suspendez pas le compte Google</strong> tant que la
          délégation est nécessaire : Gmail désactive les délégations d’une boîte suspendue.
        </p>
      </div>

      {!selected ? (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">Utilisateur qui part</label>
          <GoogleUserPicker
            placeholder="Nom, prénom ou adresse Google…"
            onSelect={(u) => setSelected(u.primaryEmail)}
          />
        </div>
      ) : isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : error || !detail ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {(error as Error | null)?.message ?? 'Utilisateur introuvable'}
          <button onClick={() => setSelected(null)} className="ml-3 underline">Changer d’utilisateur</button>
        </div>
      ) : (
        <div className="space-y-4">
          <UserSummary detail={detail} onClear={() => setSelected(null)} />
          <div className="grid gap-4 lg:grid-cols-2">
            <PasswordPanel key={`pwd-${selected}`} detail={detail} canWrite={canWrite} />
            <DelegationPanel key={`del-${selected}`} detail={detail} canWrite={canWrite} />
          </div>
        </div>
      )}

      <ActiveDelegations canWrite={canWrite} onOpen={setSelected} />

      <HistoryList />
    </div>
  )
}
