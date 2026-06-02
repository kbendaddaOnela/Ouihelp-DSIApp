import { Play, Square, Trash2, AlertCircle, CheckCircle2, Loader2, Mailbox, ShieldOff } from 'lucide-react'
import type { SharedMigrationRecord } from '@dsi-app/shared'
import {
  useRunSharedMigration,
  useStopSharedMigration,
  useDeleteSharedMigration,
  useSharedDualDeliveryStatus,
  useEnableSharedDualDelivery,
  useDisableSharedDualDelivery,
  useAllowExternalGroupPosts,
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

      <DualDeliveryPanel migration={migration} />
    </div>
  )
}

function DualDeliveryPanel({ migration }: { migration: SharedMigrationRecord }) {
  const groupReady = migration.stepCreateGroup === 'success'
  const { data, isLoading } = useSharedDualDeliveryStatus(migration.id, groupReady)
  const { mutate: enable, isPending: enabling } = useEnableSharedDualDelivery()
  const { mutate: disable, isPending: disabling } = useDisableSharedDualDelivery()
  const { mutate: allowExternal, isPending: opening } = useAllowExternalGroupPosts()

  if (!groupReady) return null

  const forwarding = data?.forwarding
  const allowsExternal = data?.groupAllowsExternalPosts ?? false
  const isActive = !!forwarding?.active
  const wrongTarget =
    isActive && forwarding?.forwardTo?.toLowerCase() !== migration.targetGroupEmail.toLowerCase()

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-700">
          <Mailbox className="h-3.5 w-3.5" />
          Dual delivery
        </div>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>

      <div className="space-y-1.5 text-xs text-gray-600">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
          Transport rule (BCC)&nbsp;:{' '}
          {isActive ? (
            <span className="font-mono text-gray-800">
              → {forwarding!.forwardTo}
              {wrongTarget && (
                <span className="ml-1 text-orange-600">(⚠ cible ≠ groupe ; cliquer pour corriger)</span>
              )}
            </span>
          ) : (
            <span className="text-gray-500">aucune</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${allowsExternal ? 'bg-green-500' : 'bg-gray-300'}`} />
          Groupe accepte les posts externes&nbsp;:{' '}
          <span className={allowsExternal ? 'text-gray-800' : 'text-gray-500'}>
            {data?.groupPostPermission ?? 'inconnu'}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {!isActive || wrongTarget ? (
          <button
            onClick={() => enable(migration.id)}
            disabled={enabling}
            className="inline-flex items-center gap-1 rounded bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            <Mailbox className="h-3 w-3" />
            {enabling ? 'Activation…' : 'Activer dual delivery'}
          </button>
        ) : (
          <button
            onClick={() => {
              if (window.confirm('Désactiver le forwarding Exchange → Google Group ?')) {
                disable(migration.id)
              }
            }}
            disabled={disabling}
            className="inline-flex items-center gap-1 rounded bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
          >
            <ShieldOff className="h-3 w-3" />
            {disabling ? 'Désactivation…' : 'Désactiver dual delivery'}
          </button>
        )}
        {!allowsExternal && (
          <button
            onClick={() => {
              if (
                window.confirm(
                  'Ouvrir le groupe à TOUS les expéditeurs externes (ANYONE_CAN_POST) ?\n\nNécessaire pour que les mails forwardés depuis Exchange arrivent dans l\'archive. Tu pourras durcir après cutover.',
                )
              ) {
                allowExternal(migration.id)
              }
            }}
            disabled={opening}
            className="inline-flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {opening ? 'Ouverture…' : 'Ouvrir le groupe aux externes'}
          </button>
        )}
      </div>
    </div>
  )
}

