import { CheckCircle, XCircle, Clock } from 'lucide-react'
import type { StepStatus } from '@dsi-app/shared'
import { cn } from '@/lib/utils'

const CONFIG: Record<StepStatus, { icon: React.ReactNode; color: string } | null> = {
  pending: { icon: <Clock className="h-3 w-3" />, color: 'text-gray-400 bg-gray-100' },
  running: { icon: <Clock className="h-3 w-3 animate-spin" />, color: 'text-blue-600 bg-blue-50' },
  success: { icon: <CheckCircle className="h-3 w-3" />, color: 'text-green-700 bg-green-50' },
  error: { icon: <XCircle className="h-3 w-3" />, color: 'text-red-700 bg-red-50' },
  skipped: null,
}

export function StepBadge({ status, label }: { status: StepStatus; label: string }) {
  const config = CONFIG[status]
  if (!config) return null
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', config.color)}>
      {config.icon}
      {label}
    </span>
  )
}
