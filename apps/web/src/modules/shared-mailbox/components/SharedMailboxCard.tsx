import { Play, Square, Trash2, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import type { SharedMigrationRecord } from '@dsi-app/shared'
import {
  useRunSharedMigration,
  useStopSharedMigration,
  useDeleteSharedMigration,
} from '../hooks/useSharedMailbox'

interface Props {
  migration: SharedMigrationRecord
}

function StepBadge({ status, label }: { status: SharedMigrationRecord['stepMailImport']; label: string }) {
  const map: Record<SharedMigrationRecord['stepMailImport'], { cls: string; icon: React.ReactNode }> = {
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

  const isInFlight = migration.stepMailImport === 'running' || migration.stepMailImport === 'pending'

  const pct = migration.mailTotal > 0
    ? Math.min(100, Math.round((migration.mailMigrated / migration.mailTotal) * 100))
    : 0

  const canRun =
    migration.stepMailImport !== 'running' && migration.stepMailImport !== 'pending'
  const canDelete = migration.stepMailImport !== 'running'

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900">{migration.onelaDisplayName}</span>
            <span className="text-xs text-gray-500">{migration.onelaEmail}</span>
          </div>
          <div className="mt-1 text-sm text-gray-600">
            → <span className="font-mono text-xs">{migration.targetGroupEmail}</span>{' '}
            <span className="text-gray-400">({migration.targetGroupName})</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canRun && (
            <button
              onClick={() => runMigration(migration.id)}
              disabled={isRunning}
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
                if (window.confirm('Supprimer cette migration (pas le groupe Google) ?')) deleteMigration(migration.id)
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
        <StepBadge status={migration.stepCreateGroup} label={`Groupe : ${migration.stepCreateGroup}`} />
        <StepBadge status={migration.stepMailImport} label={`Import mail : ${migration.stepMailImport}`} />
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

      {(migration.createGroupError || migration.mailError) && (
        <div className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          {migration.createGroupError && <div>Groupe : {migration.createGroupError}</div>}
          {migration.mailError && <div>Mail : {migration.mailError}</div>}
        </div>
      )}
    </div>
  )
}
