import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Building2, ChevronRight, ChevronDown, RefreshCw, Loader2, Users, Rocket, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MigrateUsersRequest } from '@dsi-app/shared'
import { migrationApi } from '../api'

type Agency = { code: string; groupId: string; total: number; done: number; in_progress: number }
type Member = Awaited<ReturnType<typeof migrationApi.groupMembers>>[number]

function Counts({ total, done, in_progress }: { total: number; done: number; in_progress: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className="font-semibold text-gray-700">{total}</span>
      {done > 0 && <span className="text-emerald-600">· {done} ok</span>}
      {in_progress > 0 && <span className="text-blue-500">· {in_progress} en cours</span>}
    </span>
  )
}

// ── Liste des membres d'une agence : sélection + lancement ────────────────────
function AgencyMembers({ agency, onLaunched }: { agency: Agency; onLaunched: () => void }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState<string | null>(null)

  const { data: members, isLoading, isError, error } = useQuery({
    queryKey: ['group-members', agency.groupId],
    queryFn: () => migrationApi.groupMembers(agency.groupId),
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
      queryClient.invalidateQueries({ queryKey: ['group-members', agency.groupId] })
      queryClient.invalidateQueries({ queryKey: ['agencies-tree'] })
      onLaunched()
    },
    onError: (e) => setMsg(`Erreur : ${e instanceof Error ? e.message : String(e)}`),
  })

  const selectable = (members ?? []).filter((m) => m.migrationStatus === 'none')
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = selectable.length > 0 && selectable.every((m) => selected.has(m.id))
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(selectable.map((m) => m.id)))

  const doLaunch = () => {
    const chosen = (members ?? []).filter((m) => selected.has(m.id))
    if (!chosen.length) return
    if (!window.confirm(`Lancer la migration de ${chosen.length} personne(s) de l'agence ${agency.code} ?`)) return
    const req: MigrateUsersRequest = {
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
    }
    launch.mutate(req)
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800">
          <Users className="h-4 w-4 text-primary-600" /> Agence {agency.code}
          <span className="text-xs font-normal text-gray-400">({agency.total} membres)</span>
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
              const isActive = m.migrationStatus === 'active'
              return (
                <li key={m.id}>
                  <label className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm', isActive ? 'opacity-60' : 'cursor-pointer hover:bg-gray-50')}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300"
                      disabled={isActive}
                      checked={selected.has(m.id)}
                      onChange={() => toggle(m.id)}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-gray-800">{m.displayName}</span>
                      <span className="ml-1 text-xs text-gray-400">{m.email}</span>
                    </span>
                    {isActive && (
                      <span className="flex shrink-0 items-center gap-1 text-[11px] text-blue-500"><CheckCircle2 className="h-3 w-3" /> déjà en cours</span>
                    )}
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
                  className="flex w-full items-center justify-between bg-gray-50 px-3 py-2 text-left hover:bg-gray-100"
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
                    {isOpen ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
                    {r.label}
                    <span className="text-xs font-normal text-gray-400">({r.agencies.length} agences)</span>
                  </span>
                  <Counts total={r.total} done={r.done} in_progress={r.in_progress} />
                </button>

                {isOpen && (
                  <div className="p-2">
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
                      {r.agencies.map((a) => {
                        const active = agency?.groupId === a.groupId
                        return (
                          <button
                            key={a.groupId}
                            onClick={() => setAgency(active ? null : a)}
                            className={cn(
                              'flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-xs',
                              active ? 'border-primary-300 bg-primary-50' : 'border-gray-200 hover:bg-gray-50'
                            )}
                          >
                            <span className="font-medium text-gray-800">{a.code}</span>
                            <span className="flex items-center gap-1 text-[11px] text-gray-500">
                              {a.total}
                              {a.done > 0 && <span className="text-emerald-600">·{a.done}</span>}
                              {a.in_progress > 0 && <span className="text-blue-500">·{a.in_progress}</span>}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    {agency && r.agencies.some((a) => a.groupId === agency.groupId) && (
                      <AgencyMembers agency={agency} onLaunched={() => refetch()} />
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
