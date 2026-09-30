import { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { MiniProgress } from './MemberPicker'

export type TreeNode = {
  key: string
  label: string
  total: number
  done: number
  in_progress: number
  children?: TreeNode[]
}

/**
 * Arbre de SUIVI en lecture seule : Siège → services, Agences → région → agence.
 * Affiche seulement les effectifs (à migrer / migré / en cours) + barre de
 * progression. La sélection et le lancement se font dans le panneau agences.
 */
function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0)
  const hasChildren = !!node.children?.length
  const pct = node.total > 0 ? Math.min(100, Math.round((node.done / node.total) * 100)) : 0

  return (
    <>
      <div
        className={hasChildren ? 'cursor-pointer hover:bg-gray-50' : ''}
        onClick={hasChildren ? () => setOpen((o) => !o) : undefined}
      >
        <div
          className="flex items-center gap-2 border-b border-gray-50 py-2 pr-3"
          style={{ paddingLeft: 12 + depth * 20 }}
        >
          {hasChildren
            ? (open ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />)
            : <span className="h-4 w-4 shrink-0" />}
          <span className={depth === 0 ? 'text-sm font-semibold text-gray-900' : depth === 1 ? 'text-sm font-medium text-gray-800' : 'text-sm text-gray-700'}>
            {node.label}
          </span>
          <span className="flex shrink-0 items-center gap-2 text-xs text-gray-500">
            <span className="font-semibold text-gray-700">{node.total}</span>
            <span className="text-emerald-600">{node.done} ok</span>
            {node.in_progress > 0 && <span className="text-blue-500">{node.in_progress} en cours</span>}
          </span>
          <div className="ml-auto flex w-44 shrink-0 items-center gap-2">
            <MiniProgress total={node.total} done={node.done} in_progress={node.in_progress} />
            <span className="w-8 shrink-0 text-right text-[10px] text-gray-400">{pct}%</span>
          </div>
        </div>
      </div>
      {open && node.children?.map((c) => <Row key={c.key} node={c} depth={depth + 1} />)}
    </>
  )
}

export function SuiviTree({ roots }: { roots: TreeNode[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-100">
      {roots.map((n) => <Row key={n.key} node={n} depth={0} />)}
    </div>
  )
}
