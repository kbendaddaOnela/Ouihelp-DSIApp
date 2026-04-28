import { useState } from 'react'
import { ChevronDown, ChevronUp, RefreshCw, Mail } from 'lucide-react'
import type { MigrationRecord } from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import { StepBadge } from './StepBadge'
import { CopyButton } from './CopyButton'
import { useAddGoogleAlias, useMigrateMail } from '../hooks/useMigration'

export function MigrationCard({ m }: { m: MigrationRecord }) {
  const [expanded, setExpanded] = useState(false)
  const [aliasMessage, setAliasMessage] = useState<string | null>(null)
  const defaultAlias = m.onelaUpn.replace('@onela.com', '@test-mig.onela.com')
  const [aliasInput, setAliasInput] = useState(defaultAlias)
  const { mutate: addAlias, isPending: isAddingAlias } = useAddGoogleAlias()
  const { mutate: migrateMail, isPending: isStartingMail } = useMigrateMail()

  const hasError = m.stepCreateAccount === 'error'
  const mailRunning = m.stepMailMigration === 'running' || m.stepMailMigration === 'pending'
  const canStartMail = m.stepCreateAccount === 'success' && !mailRunning
  const mailPct = m.mailTotal > 0 ? Math.round(((m.mailMigrated + m.mailFailed) / m.mailTotal) * 100) : 0
  const canAddAlias = m.stepCreateAccount === 'success' && m.stepGoogleAlias !== 'success'

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
          <StepBadge status={m.stepMailMigration} label="Mail" />
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
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              placeholder="alias@domaine.com"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleAddAlias}
              disabled={isAddingAlias || !aliasInput.trim()}
              className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-60"
            >
              <RefreshCw className={cn('h-3 w-3', isAddingAlias && 'animate-spin')} />
              {isAddingAlias ? 'Vérification…' : 'Ajouter alias Google'}
            </button>
          </div>
          {aliasMessage && (
            <p className={cn(
              'rounded px-2 py-1 text-xs',
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

      {/* Migration mail */}
      {canStartMail && m.stepMailMigration !== 'success' && (
        <div className="mt-3">
          <button
            onClick={() => migrateMail(m.id)}
            disabled={isStartingMail}
            className="flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-medium text-purple-700 hover:bg-purple-100 disabled:opacity-60"
          >
            <Mail className="h-3 w-3" />
            {isStartingMail
              ? 'Démarrage…'
              : m.stepMailMigration === 'error'
                ? 'Reprendre la migration mail'
                : 'Lancer la migration mail (Exchange → Gmail)'}
          </button>
        </div>
      )}

      {(mailRunning || m.mailTotal > 0) && (
        <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-gray-700">
              {mailRunning ? 'Migration mail en cours…' : 'Migration mail'}
            </span>
            <span className="font-mono text-gray-600">
              {m.mailMigrated + m.mailFailed} / {m.mailTotal} ({mailPct}%)
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
            <div
              className={cn(
                'h-full transition-all duration-500',
                m.stepMailMigration === 'error' ? 'bg-red-500' : 'bg-purple-500'
              )}
              style={{ width: `${mailPct}%` }}
            />
          </div>
          {m.mailFailed > 0 && (
            <p className="mt-1 text-xs text-red-600">{m.mailFailed} message(s) en erreur</p>
          )}
          {m.mailError && (
            <p className="mt-1 text-xs text-red-600">{m.mailError}</p>
          )}
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
