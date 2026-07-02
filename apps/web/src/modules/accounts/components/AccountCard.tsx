import { useState } from 'react'
import { ChevronDown, ChevronRight, Trash2, RefreshCw, Cloud, Copy, Check } from 'lucide-react'
import type { AccountCreationRecord, AccountStepStatus } from '@dsi-app/shared'
import { StepBadge } from '@/modules/migration/components/StepBadge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useFinalizeGoogle, useRetryAccount, useDeleteAccount } from '../hooks/useAccounts'

const STEPS: Array<{ key: keyof AccountCreationRecord; label: string }> = [
  { key: 'stepCreateGoh', label: '1. Compte Ouihelp' },
  { key: 'stepSetAttributes', label: '2. Attributs + manager' },
  { key: 'stepOnelaRouting', label: '3. Routage ONELA' },
  { key: 'stepGoogleProvision', label: '4. SCIM → Google' },
  { key: 'stepOuMove', label: '5. OU /onela.com' },
  { key: 'stepNewFormat', label: '6. Alias + send-as' },
]

function overallStatus(a: AccountCreationRecord): { label: string; cls: string } {
  const steps = STEPS.map((s) => a[s.key] as AccountStepStatus)
  if (steps.some((s) => s === 'error')) return { label: 'Erreur', cls: 'bg-red-50 text-red-700' }
  if (steps.every((s) => s === 'success')) return { label: 'Terminé', cls: 'bg-green-50 text-green-700' }
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
  const finalize = useFinalizeGoogle()
  const retry = useRetryAccount()
  const del = useDeleteAccount()

  const status = overallStatus(account)
  const provisionSteps: AccountStepStatus[] = [
    account.stepCreateGoh,
    account.stepSetAttributes,
    account.stepOnelaRouting,
  ]
  // Étape figée : 'running' alors que l'enregistrement n'a pas bougé depuis > 3 min
  // (la tâche background a été tuée par un recyclage du conteneur Azure).
  const staleMs = Date.now() - new Date(account.updatedAt).getTime()
  const isStale = staleMs > 3 * 60_000
  const hasProvisionError = provisionSteps.includes('error')
  const isProvisionStuck = isStale && provisionSteps.includes('running')
  const canRetry = hasProvisionError || isProvisionStuck
  const canFinalize = account.stepCreateGoh === 'success' && account.stepNewFormat !== 'success'

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
          {isProvisionStuck && !account.errorDetails && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Étape figée (tâche interrompue par un redémarrage). Clique « Relancer le provisioning » pour reprendre — sans risque, l'opération est idempotente.
            </p>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {canRetry && (
              <Button size="sm" variant="outline" onClick={() => retry.mutate(account.id)} disabled={retry.isPending}>
                <RefreshCw className={cn('h-4 w-4', retry.isPending && 'animate-spin')} />
                Relancer le provisioning
              </Button>
            )}
            {canFinalize && (
              <Button size="sm" variant="outline" onClick={() => finalize.mutate(account.id)} disabled={finalize.isPending}>
                <Cloud className={cn('h-4 w-4', finalize.isPending && 'animate-pulse')} />
                Finaliser sur Google
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={() => {
                const purge = window.confirm(
                  'Supprimer le suivi de cet onboarding.\n\nOK = supprimer AUSSI l\'objet de routage MailContact sur Exchange ONELA.\nAnnuler = garder le routage (supprimer seulement le suivi).',
                )
                del.mutate({ id: account.id, purgeRouting: purge })
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
