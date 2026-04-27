import { useState } from 'react'
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import type { MigrationRecord } from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import { StepBadge } from './StepBadge'
import { CopyButton } from './CopyButton'
import { useAddGoogleAlias } from '../hooks/useMigration'

export function MigrationCard({ m }: { m: MigrationRecord }) {
  const [expanded, setExpanded] = useState(false)
  const [aliasMessage, setAliasMessage] = useState<string | null>(null)
  const { mutate: addAlias, isPending: isAddingAlias } = useAddGoogleAlias()

  const hasError = m.stepCreateAccount === 'error'
  const canAddAlias = m.stepCreateAccount === 'success' && m.stepGoogleAlias !== 'success'

  const handleAddAlias = () => {
    setAliasMessage(null)
    addAlias(m.id, {
      onSuccess: () => setAliasMessage(null),
      onError: (err: unknown) => {
        const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          ?? (err instanceof Error ? err.message : 'Erreur inconnue')
        setAliasMessage(msg)
      },
    })
  }

  return (
    <div className={cn('rounded-xl border bg-white p-4', hasError ? 'border-red-200' : 'border-gray-200')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-gray-900">{m.onelaDisplayName}</p>
          <p className="text-xs text-gray-500">{m.onelaUpn}</p>
          {m.gohUpn && <p className="mt-0.5 text-xs text-blue-600">→ {m.gohUpn}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          <StepBadge status={m.stepCreateAccount} label="Compte GOH" />
          <StepBadge status={m.stepSetAttributes} label="Attributs SCIM" />
          <StepBadge status={m.stepGroupMembership} label="Groupe dyn." />
          <StepBadge status={m.stepGoogleAlias} label="Alias Google" />
        </div>
      </div>

      {hasError && m.errorDetails && (
        <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{m.errorDetails}</p>
      )}

      {m.tempPassword && (
        <div className="mt-3 flex items-center justify-between rounded bg-amber-50 px-3 py-2">
          <div>
            <p className="text-xs font-medium text-amber-800">Mot de passe temporaire</p>
            <code className="font-mono text-sm text-amber-900">{m.tempPassword}</code>
          </div>
          <CopyButton text={m.tempPassword} />
        </div>
      )}

      {canAddAlias && (
        <div className="mt-3">
          <button
            onClick={handleAddAlias}
            disabled={isAddingAlias}
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3 w-3', isAddingAlias && 'animate-spin')} />
            {isAddingAlias ? 'Vérification…' : `Ajouter alias Google (${m.onelaUpn})`}
          </button>
          {aliasMessage && (
            <p className={cn(
              'mt-1.5 rounded px-2 py-1 text-xs',
              aliasMessage.includes('pas encore') ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'
            )}>
              {aliasMessage}
            </p>
          )}
        </div>
      )}

      {m.stepGoogleAlias === 'success' && (
        <p className="mt-2 text-xs text-green-600">✓ Alias <strong>{m.onelaUpn}</strong> ajouté sur {m.gohUpn}</p>
      )}

      {m.exchangePsScript && (
        <div className="mt-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Script PowerShell Exchange (ForwardingSMTPAddress)
          </button>
          {expanded && (
            <div className="mt-2 rounded border border-gray-200 bg-gray-50">
              <div className="flex justify-end border-b border-gray-200 px-3 py-1">
                <CopyButton text={m.exchangePsScript} />
              </div>
              <pre className="overflow-x-auto p-3 text-xs text-gray-700">{m.exchangePsScript}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
