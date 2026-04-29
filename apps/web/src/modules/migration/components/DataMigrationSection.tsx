import { RefreshCcw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { StepStatus } from '@dsi-app/shared'
import { cn } from '@/lib/utils'

interface Props {
  label: string
  icon: LucideIcon
  status: StepStatus
  total: number
  migrated: number
  failed: number
  errorMessage: string | null
  itemUnit: string // ex: "message", "événement", "contact"
  onStart: () => void
  isStarting: boolean
  startedAt: string | null
  finishedAt: string | null
  lastSyncAt: string | null
  /** Couleur tailwind (purple, blue, emerald) */
  color: 'purple' | 'blue' | 'emerald'
}

const COLOR_CLASSES = {
  purple: { bar: 'bg-purple-500', btnBorder: 'border-purple-200', btnBg: 'bg-purple-50', btnText: 'text-purple-700', btnHover: 'hover:bg-purple-100' },
  blue: { bar: 'bg-blue-500', btnBorder: 'border-blue-200', btnBg: 'bg-blue-50', btnText: 'text-blue-700', btnHover: 'hover:bg-blue-100' },
  emerald: { bar: 'bg-emerald-500', btnBorder: 'border-emerald-200', btnBg: 'bg-emerald-50', btnText: 'text-emerald-700', btnHover: 'hover:bg-emerald-100' },
}

export function DataMigrationSection({
  label, icon: Icon, status, total, migrated, failed, errorMessage,
  itemUnit, onStart, isStarting, startedAt, finishedAt, lastSyncAt, color,
}: Props) {
  const running = status === 'running' || status === 'pending'
  const showActionButton = !running
  const showBar = running || total > 0
  const pct = total > 0 ? Math.round(((migrated + failed) / total) * 100) : 0
  const c = COLOR_CLASSES[color]

  const buttonLabel = isStarting
    ? 'Démarrage…'
    : status === 'success'
      ? `Synchroniser ${label.toLowerCase()} (delta)`
      : status === 'error'
        ? `Reprendre la migration ${label.toLowerCase()}`
        : `Lancer la migration ${label.toLowerCase()}`

  const ButtonIcon = status === 'success' ? RefreshCcw : Icon

  return (
    <div className="space-y-2">
      {showActionButton && (
        <button
          onClick={onStart}
          disabled={isStarting}
          className={cn(
            'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-60',
            c.btnBorder, c.btnBg, c.btnText, c.btnHover
          )}
        >
          <ButtonIcon className={cn('h-3 w-3', isStarting && 'animate-spin')} />
          {buttonLabel}
        </button>
      )}

      {showBar && (
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-gray-700">
              {running ? `Migration ${label.toLowerCase()} en cours…` : `Migration ${label.toLowerCase()}`}
            </span>
            <span className="font-mono text-gray-600">
              {migrated + failed} / {total} ({pct}%)
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
            <div
              className={cn('h-full transition-all duration-500', status === 'error' ? 'bg-red-500' : c.bar)}
              style={{ width: `${pct}%` }}
            />
          </div>
          {failed > 0 && <p className="mt-1 text-xs text-red-600">{failed} {itemUnit}(s) en erreur</p>}
          {errorMessage && <p className="mt-1 text-xs text-red-600">{errorMessage}</p>}
          {finishedAt && status === 'success' && (
            <p className="mt-1 text-xs text-green-600">
              ✓ Terminé{startedAt ? ` en ${formatDuration(startedAt, finishedAt)}` : ''}
            </p>
          )}
          {lastSyncAt && status === 'success' && (
            <p className="mt-0.5 text-[11px] text-gray-500">
              Dernière synchro : {formatRelative(lastSyncAt)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'à l\'instant'
  if (ms < 3_600_000) return `il y a ${Math.round(ms / 60_000)} min`
  if (ms < 86_400_000) return `il y a ${Math.round(ms / 3_600_000)}h`
  return `il y a ${Math.round(ms / 86_400_000)}j`
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`
  return `${(ms / 3_600_000).toFixed(1)}h`
}
