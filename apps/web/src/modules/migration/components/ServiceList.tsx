import { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MemberPicker, MiniProgress } from './MemberPicker'

type ServiceRow = { label: string; groupId: string; total: number; done: number; in_progress: number }

/**
 * Tableau « Par service » interactif : chaque service (groupe ONELA) est
 * cliquable → drill-down des membres (sélection + lancement), avec compteurs et
 * barre de progression. Même principe que la vue agences.
 */
export function ServiceList({ rows }: { rows: ServiceRow[] }) {
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const sorted = [...rows].sort((a, b) => b.total - a.total)

  return (
    <div className="space-y-1.5">
      {sorted.map((s) => {
        const isOpen = openGroup === s.groupId
        const pct = s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0
        return (
          <div key={s.groupId} className="overflow-hidden rounded-lg border border-gray-100">
            <button
              onClick={() => setOpenGroup(isOpen ? null : s.groupId)}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-gray-50"
            >
              {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
              <span className="w-32 shrink-0 truncate text-sm font-medium text-gray-800">{s.label}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-gray-500">
                <span className="font-semibold text-gray-700">{s.total}</span>
                <span className="text-emerald-600">{s.done} ok</span>
                {s.in_progress > 0 && <span className="text-blue-500">{s.in_progress} en cours</span>}
              </span>
              <div className="ml-auto flex w-40 items-center gap-2">
                <MiniProgress total={s.total} done={s.done} in_progress={s.in_progress} />
                <span className="w-8 shrink-0 text-right text-[10px] text-gray-400">{pct}%</span>
              </div>
            </button>
            {isOpen && (
              <div className="px-2 pb-2">
                <MemberPicker groupId={s.groupId} title={s.label} subtitle={`${s.total} membres`} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
