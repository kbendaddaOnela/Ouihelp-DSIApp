import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Trash2, RefreshCw, Cloud, Copy, Check, KeyRound, Mail } from 'lucide-react'
import {
  mailboxesForService,
  type AccountCreationRecord,
  type AccountStepStatus,
} from '@dsi-app/shared'
import { StepBadge } from '@/modules/migration/components/StepBadge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  useFinalizeGoogle,
  useRetryAccount,
  useDeleteAccount,
  useLicenseSkus,
  useAgencies,
  useMigratedSharedMailboxes,
} from '../hooks/useAccounts'

const STEPS: Array<{ key: keyof AccountCreationRecord; label: string }> = [
  { key: 'stepCreateGoh', label: '1. Compte Ouihelp' },
  { key: 'stepSetAttributes', label: '2. Attributs + manager' },
  { key: 'stepOnelaRouting', label: '3. Routage ONELA' },
  { key: 'stepGoogleProvision', label: '4. SCIM → Google' },
  { key: 'stepOuMove', label: '5. OU /onela.com' },
  { key: 'stepLicense', label: '6. Licence Google' },
  { key: 'stepNewFormat', label: '7. Alias' },
  { key: 'stepSendAs', label: '8. Send-as' },
  { key: 'stepContactsOnela', label: '9. Contacts ONELA' },
  { key: 'stepDelegations', label: '10. Délégations' },
]

function overallStatus(a: AccountCreationRecord): { label: string; cls: string } {
  const steps = STEPS.map((s) => a[s.key] as AccountStepStatus)
  if (steps.some((s) => s === 'error')) return { label: 'Erreur', cls: 'bg-red-50 text-red-700' }
  if (steps.every((s) => s === 'success' || s === 'skipped')) return { label: 'Terminé', cls: 'bg-green-50 text-green-700' }
  if (steps.some((s) => s === 'running' || s === 'pending')) return { label: 'En cours', cls: 'bg-blue-50 text-blue-700' }
  return { label: '—', cls: 'bg-gray-100 text-gray-600' }
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 hover:bg-gray-200"
      title="Copier"
    >
      {value}
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3 opacity-50" />}
    </button>
  )
}

export function AccountCard({ account }: { account: AccountCreationRecord }) {
  const [open, setOpen] = useState(false)
  const { confirm } = useConfirm()
  const finalize = useFinalizeGoogle()
  const retry = useRetryAccount()
  const del = useDeleteAccount()

  const status = overallStatus(account)
  const provisionSteps: AccountStepStatus[] = [
    account.stepCreateGoh,
    account.stepSetAttributes,
    account.stepOnelaRouting,
  ]
  // Provisioning incomplet = une étape 1-3 n'est ni success ni skipped (donc pending,
  // running ou error). On propose toujours « Relancer » dans ce cas : l'opération est
  // idempotente, ça débloque une étape figée par un recyclage du conteneur sans
  // dépendre d'un timer (la finalisation 4-6 bouge updatedAt et masquait le blocage).
  const provisionIncomplete = provisionSteps.some((s) => s !== 'success' && s !== 'skipped')
  const provisionRunning = provisionSteps.includes('running')
  const canRetry = provisionIncomplete
  const done = (s: AccountStepStatus) => s === 'success' || s === 'skipped'
  const canFinalize =
    account.stepCreateGoh === 'success' &&
    (!done(account.stepLicense) ||
      !done(account.stepNewFormat) ||
      !done(account.stepSendAs) ||
      !done(account.stepContactsOnela) ||
      !done(account.stepDelegations))

  // ── Panneau « Terminer la création » (licence + délégations) ────────────────
  // Boîtes partagées du service/agence du compte, rapprochées des boîtes migrées.
  const licenseNeeded = account.stepLicense !== 'success' && account.stepLicense !== 'skipped'
  const { data: agenciesData } = useAgencies()
  const { data: mailboxesData } = useMigratedSharedMailboxes()
  const { data: licenseData } = useLicenseSkus(open)
  const licenseSkus = licenseData ?? []
  const [skuChoice, setSkuChoice] = useState('')

  const relevantMailboxes = useMemo(() => {
    const migrated = mailboxesData?.mailboxes ?? []
    // Adresses attendues selon l'affectation
    let addrs: string[] = []
    if (account.assignmentType === 'Agence') {
      const ag = (agenciesData?.agencies ?? []).find((a) => a.name === account.officeLocation)
      if (ag?.mailbox) addrs = [ag.mailbox]
    } else if (account.assignmentType === 'Siège') {
      addrs = mailboxesForService(account.department ?? '')
    }
    const wanted = addrs.map((a) => a.toLowerCase())
    const byEmail = new Map<string, { id: string; onelaEmail: string; delegateEmail: string }>()
    // Boîtes du service/agence effectivement migrées
    for (const m of migrated) {
      if (wanted.includes(m.onelaEmail.toLowerCase()) || (m.alias && wanted.includes(m.alias.toLowerCase()))) {
        byEmail.set(m.delegateEmail, { id: m.id, onelaEmail: m.onelaEmail, delegateEmail: m.delegateEmail })
      }
    }
    // + boîtes déjà déléguées à ce compte (pour pouvoir les voir/décocher)
    for (const m of migrated) {
      if ((account.delegateMailboxes ?? []).includes(m.delegateEmail)) {
        byEmail.set(m.delegateEmail, { id: m.id, onelaEmail: m.onelaEmail, delegateEmail: m.delegateEmail })
      }
    }
    return [...byEmail.values()]
  }, [mailboxesData, agenciesData, account.assignmentType, account.officeLocation, account.department, account.delegateMailboxes])

  const defaultSelected = useMemo(
    () => Array.from(new Set([...(account.delegateMailboxes ?? []), ...relevantMailboxes.map((m) => m.delegateEmail)])),
    [account.delegateMailboxes, relevantMailboxes],
  )
  // Sélection initialisée une seule fois (ne pas écraser les cases à chaque refetch 5s)
  const [selected, setSelected] = useState<string[] | null>(null)
  useEffect(() => {
    if (selected === null && defaultSelected.length > 0) setSelected(defaultSelected)
  }, [selected, defaultSelected])
  const effectiveSelected = selected ?? defaultSelected
  const toggleDelegate = (email: string) =>
    setSelected((prev) => {
      const base = prev ?? defaultSelected
      return base.includes(email) ? base.filter((e) => e !== email) : [...base, email]
    })

  // Le panneau sert à compléter : utile tant que tout n'est pas terminé, ou pour
  // (ré)attribuer une licence / des délégations à un compte déjà « Terminé ».
  const showCompletePanel =
    account.stepCreateGoh === 'success' &&
    (canFinalize || licenseNeeded || relevantMailboxes.length > 0)

  const onComplete = () => {
    const payload: { licenseSkuId?: string; delegateMailboxes?: string[] } = {}
    if (skuChoice) payload.licenseSkuId = skuChoice
    payload.delegateMailboxes = effectiveSelected
    finalize.mutate({ id: account.id, payload })
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900">{account.displayName}</p>
          <p className="truncate text-xs text-gray-500">{account.onelaUpn}</p>
        </div>
        <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', status.cls)}>{status.label}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-gray-100 px-4 py-4">
          {/* Identité / routage */}
          <div className="grid grid-cols-1 gap-2 text-xs text-gray-600 sm:grid-cols-2">
            <div>Compte Ouihelp : <CopyChip value={account.gohUpn} /></div>
            <div>Adresse ONELA : <CopyChip value={account.onelaUpn} /></div>
            <div>Routage : <CopyChip value={account.routingAddress} /></div>
            {account.tempPassword && <div>Mot de passe initial : <CopyChip value={account.tempPassword} /></div>}
            <div>Affectation : <span className="font-medium text-gray-800">{account.assignmentType}</span>{account.officeLocation ? ` — ${account.officeLocation}` : ''}</div>
            <div>Service : <span className="font-medium text-gray-800">{account.department ?? '—'}</span></div>
            <div>Poste : <span className="font-medium text-gray-800">{account.jobTitle ?? '—'}</span></div>
            {account.managerUpn && <div>Manager : <span className="font-medium text-gray-800">{account.managerUpn}</span></div>}
            {account.delegateMailboxes && account.delegateMailboxes.length > 0 && (
              <div className="sm:col-span-2">
                Boîtes déléguées :{' '}
                <span className="font-medium text-gray-800">{account.delegateMailboxes.join(', ')}</span>
              </div>
            )}
            {account.licenseSkuName && (
              <div>Licence : <span className="font-medium text-gray-800">{account.licenseSkuName}</span></div>
            )}
          </div>

          {/* Étapes */}
          <div className="flex flex-wrap gap-2">
            {STEPS.map((s) => (
              <StepBadge key={s.key} status={account[s.key] as AccountStepStatus} label={s.label} />
            ))}
          </div>

          {account.errorDetails && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{account.errorDetails}</p>
          )}
          {account.delegationsError && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">Délégations : {account.delegationsError}</p>
          )}
          {account.licenseError && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">Licence : {account.licenseError}</p>
          )}

          {provisionRunning && !account.errorDetails && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Si cette étape reste « en cours » plusieurs minutes, la tâche a été interrompue par un redémarrage du conteneur. Clique « Relancer le provisioning » pour reprendre — sans risque, l'opération est idempotente.
            </p>
          )}

          {/* Panneau « Terminer la création » : licence + délégations puis finalisation */}
          {showCompletePanel && (
            <div className="space-y-3 rounded-md border border-gray-200 bg-gray-50/60 p-3">
              <p className="text-xs font-medium text-gray-700">Terminer la création</p>

              {licenseNeeded && (
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound className="h-4 w-4 text-gray-400" />
                  <span className="text-xs text-gray-600">Licence Google :</span>
                  <select
                    className="rounded-md border border-gray-300 px-2 py-1 text-xs focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                    value={skuChoice}
                    onChange={(e) => setSkuChoice(e.target.value)}
                  >
                    <option value="">— Aucune (ne pas attribuer) —</option>
                    {licenseSkus.map((s) => (
                      <option key={s.skuId} value={s.skuId}>
                        {s.name}
                        {s.remaining != null ? ` — ${s.remaining} dispo` : s.total != null ? ` — ${s.total - s.used} dispo` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {relevantMailboxes.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs text-gray-600">Boîtes partagées à déléguer :</p>
                  <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
                    {relevantMailboxes.map((m) => (
                      <label key={m.id} className="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-1.5 text-xs last:border-b-0 hover:bg-gray-50">
                        <input type="checkbox" checked={effectiveSelected.includes(m.delegateEmail)} onChange={() => toggleDelegate(m.delegateEmail)} />
                        <Mail className="h-3.5 w-3.5 text-gray-400" />
                        <span className="font-medium text-gray-800">{m.onelaEmail}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-gray-400">Aucune boîte partagée migrée pour ce service/agence.</p>
              )}

              <Button size="sm" onClick={onComplete} disabled={finalize.isPending}>
                <Cloud className={cn('h-4 w-4', finalize.isPending && 'animate-pulse')} />
                {finalize.isPending ? 'Finalisation…' : 'Terminer la création'}
              </Button>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {canRetry && (
              <Button size="sm" variant="outline" onClick={() => retry.mutate(account.id)} disabled={retry.isPending}>
                <RefreshCw className={cn('h-4 w-4', retry.isPending && 'animate-spin')} />
                Relancer le provisioning
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={async () => {
                // Avec window.confirm, « Annuler » supprimait quand même le suivi
                // (en gardant le routage) : impossible de renoncer. Ici, Annuler
                // n'efface rien, et la purge du routage est un choix explicite.
                const res = await confirm({
                  title: 'Supprimer le suivi de cet onboarding ?',
                  message: 'Le compte Google et le compte Entra ne sont pas supprimés.',
                  confirmLabel: 'Supprimer',
                  tone: 'danger',
                  checkbox: { label: 'Supprimer aussi le MailUser de routage sur Exchange ONELA', defaultChecked: true },
                })
                if (!res.confirmed) return
                del.mutate({ id: account.id, purgeRouting: res.checked })
              }}
              disabled={del.isPending}
            >
              <Trash2 className="h-4 w-4" />
              Supprimer
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
