import { useState } from 'react'
import { RefreshCcw, Eraser, Download, Pause, Loader2, RotateCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { LucideIcon } from 'lucide-react'
import type { StepStatus } from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import { useResetPhase, useStopPhase } from '../hooks/useMigration'
import { apiClient } from '@/lib/api'
import { msalInstance, apiLoginRequest } from '@/lib/auth'
import { migrationApi } from '../api'

interface Props {
  migrationId: string
  phase: 'mail' | 'calendar' | 'contacts'
  label: string
  icon: LucideIcon
  status: StepStatus
  total: number
  migrated: number
  failed: number
  errorMessage: string | null
  itemUnit: string
  onStart: (order?: 'asc' | 'desc', beforeDays?: number | null) => void
  isStarting: boolean
  startedAt: string | null
  finishedAt: string | null
  lastSyncAt: string | null
  color: 'purple' | 'blue' | 'emerald'
  // Si true (phase mail), propose le choix du sens : récents d'abord / anciens d'abord
  showOrderChoice?: boolean
}

const COLOR_CLASSES = {
  purple: { bar: 'bg-purple-500', btnBorder: 'border-purple-200', btnBg: 'bg-purple-50', btnText: 'text-purple-700', btnHover: 'hover:bg-purple-100' },
  blue: { bar: 'bg-blue-500', btnBorder: 'border-blue-200', btnBg: 'bg-blue-50', btnText: 'text-blue-700', btnHover: 'hover:bg-blue-100' },
  emerald: { bar: 'bg-emerald-500', btnBorder: 'border-emerald-200', btnBg: 'bg-emerald-50', btnText: 'text-emerald-700', btnHover: 'hover:bg-emerald-100' },
}

export function DataMigrationSection({
  migrationId, phase, label, icon: Icon, status, total, migrated, failed, errorMessage,
  itemUnit, onStart, isStarting, startedAt, finishedAt, lastSyncAt, color, showOrderChoice,
}: Props) {
  const { mutate: resetPhase, isPending: isResetting } = useResetPhase()
  const { mutate: stopPhase, isPending: isStopping } = useStopPhase()

  const handleStop = () => {
    if (window.confirm(
      `Mettre en pause la migration ${label} ?\n\n` +
      `La progression est sauvegardée — la reprise continuera exactement ` +
      `où tu t'es arrêté (les messages déjà migrés ne seront pas refaits).`
    )) {
      stopPhase({ id: migrationId, phase })
    }
  }

  const handleReset = () => {
    if (window.confirm(
      `Réinitialiser la migration ${label} ?\n` +
      `Cela vide le tracking en DB et permet de tout re-migrer.\n` +
      `Les données déjà dans Google ne sont pas touchées.`
    )) {
      resetPhase({ id: migrationId, phase })
    }
  }

  const [isDownloading, setIsDownloading] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const queryClient = useQueryClient()

  const handleRetryErrors = async () => {
    if (!window.confirm(
      `Réessayer ${failed} message(s) en erreur ?\n\n` +
      `Les mails seront déposés dans la boîte de réception Gmail ` +
      `(rapide, sans résolution de labels). Tu pourras ensuite cliquer ` +
      `"Re-labelliser" pour leur remettre les bons labels.`
    )) return
    setIsRetrying(true)
    try {
      const res = await migrationApi.retryMailErrors(migrationId)
      alert(`Reprise lancée sur ${res.count} message(s). Le compteur va se mettre à jour progressivement.`)
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    } catch (err) {
      alert(`Erreur : ${err instanceof Error ? err.message : 'inconnue'}`)
    } finally {
      setIsRetrying(false)
    }
  }

  const handleDownloadErrors = async () => {
    setIsDownloading(true)
    try {
      // Récupérer le token MSAL directement
      const accounts = msalInstance.getAllAccounts()
      const account = accounts[0]
      let authHeader = ''
      if (account) {
        const tokenRes = await msalInstance.acquireTokenSilent({ ...apiLoginRequest, account })
        authHeader = `Bearer ${tokenRes.accessToken}`
      }

      const baseUrl = apiClient.defaults.baseURL ?? '/api'
      const path = migrationApi.downloadErrorsUrl(migrationId, phase)

      const res = await fetch(`${baseUrl}${path}`, {
        headers: { Authorization: authHeader },
      })

      if (!res.ok) throw new Error(`Erreur ${res.status}: ${await res.text()}`)

      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `errors-${phase}-${migrationId.slice(0, 8)}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    } catch (err) {
      console.error('Download error:', err)
      alert(`Erreur : ${err instanceof Error ? err.message : 'inconnue'}`)
    } finally {
      setIsDownloading(false)
    }
  }

  const running = status === 'running' || status === 'pending'
  const showStopButton = running
  const showActionButton = !running
  const showBar = running || total > 0
  const pct = total > 0 ? Math.round(((migrated + failed) / total) * 100) : 0
  const c = COLOR_CLASSES[color]

  const buttonLabel = isStarting
    ? 'Démarrage...'
    : lastSyncAt
      ? `Synchroniser ${label.toLowerCase()} (delta)`
      : status === 'error'
        ? `Reprendre la migration ${label.toLowerCase()}`
        : `Lancer la migration ${label.toLowerCase()}`

  const ButtonIcon = lastSyncAt ? RefreshCcw : Icon

  return (
    <div className="space-y-2">
      {showStopButton && (
        <button
          onClick={handleStop}
          disabled={isStopping}
          className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-60"
        >
          <Pause className="h-3 w-3" />
          {isStopping ? 'Pause...' : 'Mettre en pause'}
        </button>
      )}

      {showActionButton && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => onStart('desc')}
            disabled={isStarting || isResetting}
            title={showOrderChoice ? 'Migre les mails les plus récents en premier' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-60',
              c.btnBorder, c.btnBg, c.btnText, c.btnHover
            )}
          >
            <ButtonIcon className={cn('h-3 w-3', isStarting && 'animate-spin')} />
            {showOrderChoice ? `${buttonLabel} (récents d'abord)` : buttonLabel}
          </button>
          {/* Sens inverse plafonné : backfill du backlog ancien (≤ J-60), sans toucher la
              fenêtre récente — laissée à la passe « récents » de vendredi (après cutover). */}
          {showOrderChoice && (
            <button
              onClick={() => onStart('asc', 60)}
              disabled={isStarting || isResetting}
              title="Migre les mails de plus de 60 jours, du plus ancien au plus récent. La fenêtre des 60 derniers jours est laissée pour la passe « récents » de vendredi (évite la divergence avec Outlook)."
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60"
            >
              <ButtonIcon className={cn('h-3 w-3', isStarting && 'animate-spin')} />
              Anciens d’abord (≤ J-60)
            </button>
          )}
          {(lastSyncAt || total > 0) && (
            <button
              onClick={handleReset}
              disabled={isResetting || isStarting}
              title="Vide le tracking et permet de tout re-migrer"
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            >
              <Eraser className={cn('h-3 w-3', isResetting && 'animate-spin')} />
              Réinitialiser
            </button>
          )}
        </div>
      )}

      {showBar && (
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-gray-700">
              {running ? `Migration ${label.toLowerCase()} en cours...` : `Migration ${label.toLowerCase()}`}
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

          {/* Erreurs : boutons de téléchargement + réessai (mail uniquement) */}
          {failed > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button
                onClick={handleDownloadErrors}
                disabled={isDownloading}
                className="flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-60"
              >
                {isDownloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                {isDownloading ? 'Téléchargement...' : `Télécharger les logs (${failed} ${itemUnit}(s) en erreur)`}
              </button>
              {phase === 'mail' && !running && (
                <button
                  onClick={handleRetryErrors}
                  disabled={isRetrying}
                  className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-60"
                >
                  {isRetrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                  {isRetrying ? 'Lancement...' : `Réessayer les erreurs (vers INBOX)`}
                </button>
              )}
            </div>
          )}

          {/* Progression d'une tâche async (reprise erreurs, dédup, relabel...) :
              messages préfixés "Reprise"/"Déduplication"/"Re-labellisation" → bleu info,
              même si failed > 0. Sinon errorMessage standard en rouge si pas d'erreurs comptées. */}
          {errorMessage && /^(Reprise|Déduplication|Re-labellisation|Anciens)/.test(errorMessage) && (
            <p className="mt-1 text-xs text-blue-600">{errorMessage}</p>
          )}
          {!failed && errorMessage && !/^(Reprise|Déduplication|Re-labellisation|Anciens)/.test(errorMessage) && (
            <p className="mt-1 text-xs text-red-600">{errorMessage}</p>
          )}

          {finishedAt && status === 'success' && (
            <p className="mt-1 text-xs text-green-600">
              Terminé{startedAt ? ` en ${formatDuration(startedAt, finishedAt)}` : ''}
            </p>
          )}
          {lastSyncAt && (
            <p className="mt-0.5 text-[11px] text-gray-500">
              Dernière synchro : {formatRelative(lastSyncAt)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return "a l'instant"
  if (ms < 3_600_000) return `il y a ${Math.round(ms / 60_000)} min`
  if (ms < 86_400_000) return `il y a ${Math.round(ms / 3_600_000)}h`
  return `il y a ${Math.round(ms / 86_400_000)}j`
}
