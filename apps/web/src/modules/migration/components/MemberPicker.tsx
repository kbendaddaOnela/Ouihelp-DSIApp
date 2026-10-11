import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Users, Loader2, Rocket, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MigrateUsersRequest } from '@dsi-app/shared'
import { migrationApi } from '../api'
import { useConfirm } from '@/components/ui/ConfirmDialog'

type Member = Awaited<ReturnType<typeof migrationApi.groupMembers>>[number]

/**
 * Liste les membres d'un groupe ONELA (service ou agence), permet de cocher les
 * personnes non encore en migration et de lancer la migration via /run.
 * Réutilisé par le tableau des services et le drill-down des agences.
 */
export function MemberPicker({ groupId, title, subtitle, onLaunched }: {
  groupId: string
  title: string
  subtitle?: string
  onLaunched?: () => void
}) {
  const queryClient = useQueryClient()
  const { confirm } = useConfirm()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState<string | null>(null)

  const { data: members, isLoading, isError, error } = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => migrationApi.groupMembers(groupId),
    staleTime: 30_000,
  })

  const launch = useMutation({
    mutationFn: (req: MigrateUsersRequest) => migrationApi.run(req),
    onSuccess: (res) => {
      const n = res.migrations?.length ?? 0
      const skipped = (res as { skipped?: unknown[] }).skipped?.length ?? 0
      setMsg(`${n} migration(s) lancée(s)${skipped ? `, ${skipped} ignorée(s) (déjà en cours)` : ''}.`)
      setSelected(new Set())
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
      queryClient.invalidateQueries({ queryKey: ['group-members', groupId] })
      queryClient.invalidateQueries({ queryKey: ['agencies-tree'] })
      queryClient.invalidateQueries({ queryKey: ['service-group-counts'] })
      onLaunched?.()
    },
    onError: (e) => setMsg(`Erreur : ${e instanceof Error ? e.message : String(e)}`),
  })

  const selectable = (members ?? []).filter((m) => m.migrationStatus === 'none')
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = selectable.length > 0 && selectable.every((m) => selected.has(m.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((m) => m.id)))

  const doLaunch = async () => {
    const chosen = (members ?? []).filter((m) => selected.has(m.id))
    if (!chosen.length) return
    const res = await confirm({
      title: 'Lancer la migration',
      message: `Lancer la migration de ${chosen.length} personne(s) — ${title} ?`,
      confirmLabel: 'Lancer',
    })
    if (!res.confirmed) return
    launch.mutate({
      users: chosen.map((m) => ({
        onelaUserId: m.id,
        onelaUpn: m.upn,
        onelaDisplayName: m.displayName,
        onelaEmail: m.email,
        onelaDepartment: m.department,
        onelaJobTitle: m.jobTitle,
        givenName: m.givenName,
        surname: m.surname,
      })),
    })
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800">
          <Users className="h-4 w-4 text-primary-600" /> {title}
          {subtitle && <span className="text-xs font-normal text-gray-400">{subtitle}</span>}
        </h4>
        {selectable.length > 0 && (
          <button onClick={toggleAll} className="text-[11px] text-primary-600 hover:underline">
            {allSelected ? 'Tout désélectionner' : 'Tout sélectionner'}
          </button>
        )}
      </div>

      {isLoading && (
        <p className="flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="h-3 w-3 animate-spin" /> Chargement des membres…</p>
      )}
      {isError && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error instanceof Error ? error.message : 'Erreur de récupération des membres'}</p>
      )}
      {members && members.length === 0 && <p className="text-xs text-gray-400">Aucun membre actif dans ce groupe.</p>}

      {members && members.length > 0 && (
        <>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {members.map((m: Member) => {
              const isDone = m.migrationStatus === 'done'
              const isActive = m.migrationStatus === 'active'
              const locked = isDone || isActive // migré ou en cours → pas re-sélectionnable
              return (
                <li key={m.id}>
                  <label className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm', locked ? 'opacity-70' : 'cursor-pointer hover:bg-gray-50')}>
                    <input type="checkbox" className="h-4 w-4 rounded border-gray-300" disabled={locked} checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-gray-800">{m.displayName}</span>
                      <span className="ml-1 text-xs text-gray-400">{m.email}</span>
                    </span>
                    {isDone && <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600"><CheckCircle2 className="h-3 w-3" /> migré</span>}
                    {isActive && <span className="flex shrink-0 items-center gap-1 text-[11px] text-blue-500"><Loader2 className="h-3 w-3 animate-spin" /> en cours</span>}
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="mt-2 flex items-center justify-between">
            {msg ? <span className={cn('text-xs', msg.startsWith('Erreur') ? 'text-red-600' : 'text-emerald-600')}>{msg}</span> : <span />}
            <button
              onClick={doLaunch}
              disabled={selected.size === 0 || launch.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {launch.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
              Lancer la migration{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// Petite barre de progression réutilisable (terminés vert / en cours bleu).
export function MiniProgress({ total, done, in_progress }: { total: number; done: number; in_progress: number }) {
  const donePct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const inPct = total > 0 ? Math.min(100 - donePct, Math.round((in_progress / total) * 100)) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
      <div className="flex h-full">
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${donePct}%` }} />
        <div className="h-full bg-blue-400 transition-all" style={{ width: `${inPct}%` }} />
      </div>
    </div>
  )
}
