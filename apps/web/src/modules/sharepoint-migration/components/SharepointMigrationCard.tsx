import { useState } from 'react'
import {
  Play,
  Pause,
  Trash2,
  AlertTriangle,
  HardDriveDownload,
  Loader2,
  CheckCircle2,
  XCircle,
  FolderOpen,
} from 'lucide-react'
import type { SharepointMigrationRecord } from '@dsi-app/shared'
import {
  useRunSharepointMigration,
  usePauseSharepointMigration,
  useUnstickSharepointMigration,
  useDeleteSharepointMigration,
} from '../hooks/useSharepointMigration'
import { sharepointMigrationApi } from '../api'

function fmtBytes(n: number): string {
  if (!n) return '0 o'
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const STATUS_STYLES: Record<
  SharepointMigrationRecord['status'],
  { label: string; cls: string; icon: React.ElementType }
> = {
  pending: { label: 'En attente', cls: 'bg-gray-100 text-gray-700', icon: Loader2 },
  running: { label: 'En cours', cls: 'bg-blue-100 text-blue-700', icon: Loader2 },
  paused: { label: 'En pause', cls: 'bg-amber-100 text-amber-700', icon: Pause },
  success: { label: 'Terminé', cls: 'bg-green-100 text-green-700', icon: CheckCircle2 },
  error: { label: 'Erreur', cls: 'bg-red-100 text-red-700', icon: XCircle },
}

export function SharepointMigrationCard({ migration: m }: { migration: SharepointMigrationRecord }) {
  const [showErrors, setShowErrors] = useState(false)
  const run = useRunSharepointMigration()
  const pause = usePauseSharepointMigration()
  const unstick = useUnstickSharepointMigration()
  const del = useDeleteSharepointMigration()

  const isActive = m.status === 'running' || m.status === 'pending'
  const status = STATUS_STYLES[m.status]
  const StatusIcon = status.icon
  const total = Math.max(m.totalItems, m.migratedItems + m.failedItems)
  const pct = total > 0 ? Math.round((m.migratedItems / total) * 100) : 0

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <HardDriveDownload className="h-4 w-4 shrink-0 text-gray-400" />
            <h3 className="truncate font-semibold text-gray-900">{m.gdSharedDriveName}</h3>
          </div>
          <p className="mt-0.5 truncate text-xs text-gray-500">
            {m.siteName} / {m.driveName}
            {m.rootPath ? ` / ${m.rootPath}` : ''}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${status.cls}`}
        >
          <StatusIcon className={`h-3.5 w-3.5 ${m.status === 'running' || m.status === 'pending' ? 'animate-spin' : ''}`} />
          {status.label}
        </span>
      </div>

      {/* Progression */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
          <span>
            {m.migratedItems} / {total} fichiers
            {m.failedItems > 0 && <span className="ml-1 text-red-600">· {m.failedItems} échec(s)</span>}
          </span>
          <span>{fmtBytes(m.migratedBytes)}</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className={`h-full transition-all ${m.failedItems > 0 ? 'bg-amber-500' : 'bg-blue-600'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {m.errorDetails && (
        <div className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{m.errorDetails}</div>
      )}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!isActive && (
          <button
            onClick={() => run.mutate(m.id)}
            disabled={run.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {m.migratedItems > 0 ? 'Reprendre' : 'Lancer'}
          </button>
        )}
        {isActive && (
          <button
            onClick={() => pause.mutate(m.id)}
            disabled={pause.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            <Pause className="h-3.5 w-3.5" />
            Mettre en pause
          </button>
        )}
        {m.status === 'running' && (
          <button
            onClick={() => unstick.mutate(m.id)}
            disabled={unstick.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="Forcer le statut en erreur si le worker est bloqué (redéploiement, hang)"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Débloquer
          </button>
        )}
        {m.failedItems > 0 && (
          <button
            onClick={() => setShowErrors((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {showErrors ? 'Masquer' : 'Voir'} les erreurs
          </button>
        )}
        <button
          onClick={() => {
            if (confirm(`Supprimer la migration vers "${m.gdSharedDriveName}" ? (le Shared Drive Google n'est PAS supprimé)`)) {
              del.mutate(m.id)
            }
          }}
          disabled={del.isPending || isActive}
          className="ml-auto inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          title={isActive ? 'Arrête la migration avant de supprimer' : 'Supprimer le suivi'}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {showErrors && <ErrorList migrationId={m.id} />}
    </div>
  )
}

function ErrorList({ migrationId }: { migrationId: string }) {
  const [errors, setErrors] = useState<
    Awaited<ReturnType<typeof sharepointMigrationApi.errors>>['errors'] | null
  >(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await sharepointMigrationApi.errors(migrationId)
      setErrors(data.errors)
    } finally {
      setLoading(false)
    }
  }

  if (errors === null && !loading) {
    void load()
    return null
  }

  return (
    <div className="mt-3 max-h-60 overflow-y-auto rounded border border-gray-100 bg-gray-50 p-2 text-xs">
      {loading && <p className="text-gray-500">Chargement…</p>}
      {errors?.length === 0 && <p className="text-gray-500">Aucune erreur.</p>}
      <ul className="space-y-1.5">
        {errors?.map((e) => (
          <li key={e.id} className="border-b border-gray-100 pb-1.5 last:border-0">
            <div className="font-medium text-gray-800">{e.name ?? e.spItemId}</div>
            {e.spPath && <div className="text-gray-400">{e.spPath}</div>}
            <div className="text-red-600">{e.errorDetails}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
