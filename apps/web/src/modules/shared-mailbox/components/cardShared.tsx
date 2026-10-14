// Utilitaires communs aux panneaux de la carte « boîte partagée ».
import {
  Pause,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react'
import type { MailImportStatus } from '@dsi-app/shared'
import { useConfirm } from '@/components/ui/ConfirmDialog'

/** Message d'erreur lisible depuis une erreur axios ou JS. */
function errorMessage(err: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any
  const status = e?.response?.status
  const apiErr = e?.response?.data?.error
  if (status === 404 && !apiErr) {
    return 'Endpoint API introuvable (404) — le backend est probablement en cours de déploiement, réessaye dans 1-2 minutes.'
  }
  return apiErr || (err instanceof Error ? err.message : String(err))
}

/**
 * Rapporte l'échec d'une action dans la boîte de dialogue de l'app.
 *
 * Renvoie la même signature que le handler `onError` de TanStack Query, pour que
 * les appels restent `{ onError: alertOnError('…') }`.
 */
export function useAlertOnError() {
  const { alert } = useConfirm()
  return (action: string) => (err: unknown) =>
    void alert({ title: `${action} a échoué`, tone: 'danger', message: errorMessage(err) })
}

export function StepBadge({ status, label }: { status: MailImportStatus; label: string }) {
  const map: Record<MailImportStatus, { cls: string; icon: React.ReactNode }> = {
    pending: { cls: 'bg-gray-100 text-gray-700', icon: <Loader2 className="h-3.5 w-3.5 animate-pulse" /> },
    running: { cls: 'bg-blue-100 text-blue-700', icon: <Loader2 className="h-3.5 w-3.5 animate-spin" /> },
    success: { cls: 'bg-green-100 text-green-700', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    error: { cls: 'bg-red-100 text-red-700', icon: <AlertCircle className="h-3.5 w-3.5" /> },
    skipped: { cls: 'bg-gray-100 text-gray-500', icon: null },
    paused: { cls: 'bg-amber-100 text-amber-800', icon: <Pause className="h-3.5 w-3.5" /> },
  }
  const m = map[status]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>
      {m.icon}
      {label}
    </span>
  )
}
