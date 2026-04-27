import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { MigrationRecord } from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import { StepBadge } from './StepBadge'
import { CopyButton } from './CopyButton'

export function MigrationCard({ m }: { m: MigrationRecord }) {
  const [expanded, setExpanded] = useState(false)
  const hasError = m.stepCreateAccount === 'error'

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
