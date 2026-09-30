import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Building2, ChevronRight, ChevronDown, RefreshCw, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { migrationApi } from '../api'
import { MemberPicker, MiniProgress } from './MemberPicker'

type Agency = { code: string; name: string; groupId: string; total: number; done: number; in_progress: number }

function Counts({ total, done, in_progress }: { total: number; done: number; in_progress: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className="font-semibold text-gray-700">{total}</span>
      {done > 0 && <span className="text-emerald-600">· {done} ok</span>}
      {in_progress > 0 && <span className="text-blue-500">· {in_progress} en cours</span>}
    </span>
  )
}

// ── Panneau principal : régions → agences → membres ───────────────────────────
export function AgenciesPanel() {
  const [openRegion, setOpenRegion] = useState<string | null>(null)
  const [agency, setAgency] = useState<Agency | null>(null)

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['agencies-tree'],
    queryFn: () => migrationApi.agenciesTree(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-primary-600" />
          <h2 className="text-sm font-semibold text-gray-900">Migration des agences (par région)</h2>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} /> Actualiser
        </button>
      </div>

      {isLoading && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="h-3 w-3 animate-spin" /> Chargement des agences…</p>
      )}
      {isError && (
        <p className="mt-3 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
          {error instanceof Error ? error.message : 'Erreur'} — vérifie la permission Graph « GroupMember.Read.All » sur l'app ONELA.
        </p>
      )}

      {data && (
        <div className="mt-3 space-y-1.5">
          {data.regions.map((r) => {
            const isOpen = openRegion === r.label
            return (
              <div key={r.label} className="overflow-hidden rounded-lg border border-gray-100">
                <button
                  onClick={() => { setOpenRegion(isOpen ? null : r.label); setAgency(null) }}
                  className="flex w-full items-center gap-3 bg-gray-50 px-3 py-2 text-left hover:bg-gray-100"
                >
                  {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
                  <span className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
                    {r.label}
                    <span className="text-xs font-normal text-gray-400">({r.agencies.length} agences)</span>
                  </span>
                  <div className="ml-auto flex w-40 items-center gap-2">
                    <MiniProgress total={r.total} done={r.done} in_progress={r.in_progress} />
                    <Counts total={r.total} done={r.done} in_progress={r.in_progress} />
                  </div>
                </button>

                {isOpen && (
                  <div className="p-2">
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-3">
                      {r.agencies.map((a) => {
                        const active = agency?.groupId === a.groupId
                        return (
                          <button
                            key={a.groupId}
                            onClick={() => setAgency(active ? null : a)}
                            title={`${a.name} (${a.code})`}
                            className={cn(
                              'rounded-lg border px-2.5 py-1.5 text-left text-xs',
                              active ? 'border-primary-300 bg-primary-50' : 'border-gray-200 hover:bg-gray-50'
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-medium text-gray-800">{a.name}</span>
                              <span className="flex shrink-0 items-center gap-1 text-[11px] text-gray-500">
                                {a.total}
                                {a.done > 0 && <span className="text-emerald-600">·{a.done}</span>}
                                {a.in_progress > 0 && <span className="text-blue-500">·{a.in_progress}</span>}
                              </span>
                            </div>
                            <div className="mt-1"><MiniProgress total={a.total} done={a.done} in_progress={a.in_progress} /></div>
                          </button>
                        )
                      })}
                    </div>
                    {agency && r.agencies.some((a) => a.groupId === agency.groupId) && (
                      <MemberPicker
                        groupId={agency.groupId}
                        title={agency.name}
                        subtitle={`${agency.code} · ${agency.total} membres`}
                        onLaunched={() => refetch()}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {data.errors.length > 0 && (
            <p className="text-[11px] text-amber-600">Certains groupes n'ont pu être lus : {data.errors.join(' · ')}</p>
          )}
          <p className="text-[11px] text-gray-400">
            Total / <span className="text-emerald-600">terminés</span> / <span className="text-blue-500">en cours</span>. Clique une région → une agence → coche les personnes → « Lancer la migration ».
          </p>
        </div>
      )}
    </section>
  )
}
