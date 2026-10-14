import { useState } from 'react'
import {
  RefreshCw,
  FileWarning,
} from 'lucide-react'
import type { SharedMigrationRecord } from '@dsi-app/shared'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  useSharedMigrationErrors,
  useRetrySharedErrors,
} from '../hooks/useSharedMailbox'
import { useAlertOnError } from './cardShared'

// ── Messages en erreur + reprise ciblée ─────────────────────────────────────

export function MailErrorsPanel({ migration }: { migration: SharedMigrationRecord }) {
  const alertOnError = useAlertOnError()
  const { alert } = useConfirm()
  const [expanded, setExpanded] = useState(false)
  const { data, isFetching } = useSharedMigrationErrors(migration.id, expanded)
  const { mutate: retry, isPending: retrying } = useRetrySharedErrors()

  const isInFlight = migration.stepMailImport === 'running' || migration.stepMailImport === 'pending'
  // En pause, la reprise ciblée est bloquée : elle recalculerait l'état final de
  // l'étape et effacerait la pause alors que le balayage n'est pas terminé. De
  // toute façon « Reprendre » rejoue les erreurs (le delta est désactivé dès
  // qu'il en reste).
  const isPaused = migration.stepMailImport === 'paused'
  const errors = data?.errors ?? []

  return (
    <div className="mt-3 rounded border border-red-100 bg-red-50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-red-800">
          <FileWarning className="h-3.5 w-3.5" />
          {migration.mailFailed} message(s) en erreur
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded border border-red-200 bg-white px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50"
          >
            {expanded ? 'Masquer' : 'Voir le détail'}
          </button>
          <button
            onClick={() =>
              retry(migration.id, {
                onError: alertOnError('Reprise des erreurs'),
                onSuccess: (d) => void alert({ title: 'Reprise des erreurs', message: d.message }),
              })
            }
            disabled={retrying || isInFlight || isPaused || migration.archived}
            title={
              isInFlight
                ? 'Un traitement est déjà en cours sur cette migration'
                : isPaused
                  ? 'Import en pause — clique « Reprendre » : la reprise rejoue aussi les erreurs'
                  : 'Rejoue uniquement les messages en erreur, sans reparcourir toute la boîte'
            }
            className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${retrying ? 'animate-spin' : ''}`} />
            Retenter ces {migration.mailFailed}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2">
          {isFetching && !data ? (
            <p className="text-[11px] text-gray-500">Chargement…</p>
          ) : errors.length === 0 ? (
            <p className="text-[11px] text-gray-500">Aucun détail disponible.</p>
          ) : (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {errors.map((e) => (
                <li key={e.id} className="rounded border border-red-100 bg-white px-2 py-1.5">
                  <div className="truncate text-[11px] font-medium text-gray-800">
                    {e.subject || '(sans objet)'}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    {e.receivedAt ? new Date(e.receivedAt).toLocaleString('fr-FR') : 'date inconnue'}
                  </div>
                  <div className="mt-0.5 break-words text-[10px] text-red-700">{e.errorDetails}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
