import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { migrationApi } from '../api'

/**
 * Panneau « Licences Google » au niveau du dashboard : gère UNE seule fois le
 * nombre de sièges achetés par licence (total → restantes = total − utilisées).
 * L'attribution à un compte reste sur chaque carte de migration (elle est propre
 * à un utilisateur), mais la définition des « dispo » se fait ici.
 */
export function LicensePanel() {
  const queryClient = useQueryClient()
  const [edits, setEdits] = useState<Record<string, string>>({})

  const { data: skus, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['license-skus'],
    queryFn: migrationApi.licenseSkus,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })

  const saveQuota = useMutation({
    mutationFn: ({ skuId, total }: { skuId: string; total: number | null }) =>
      migrationApi.setLicenseQuota(skuId, total),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['license-skus'] })
      queryClient.invalidateQueries({ queryKey: ['live-stats'] })
    },
  })

  const commitQuota = (skuId: string) => {
    const raw = edits[skuId]
    if (raw === undefined) return
    const trimmed = raw.trim()
    const total = trimmed === '' ? null : Number(trimmed)
    if (total !== null && (!Number.isFinite(total) || total < 0)) return
    saveQuota.mutate({ skuId, total })
    setEdits((e) => {
      const next = { ...e }
      delete next[skuId]
      return next
    })
  }

  const totalRemaining = (skus ?? []).reduce((acc, s) => acc + (s.remaining ?? 0), 0)
  const hasAnyQuota = (skus ?? []).some((s) => s.total != null)

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-indigo-600" />
          <h2 className="text-sm font-semibold text-gray-900">Licences Google disponibles</h2>
          {hasAnyQuota && (
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', totalRemaining <= 0 ? 'bg-red-50 text-red-600' : 'bg-indigo-50 text-indigo-700')}>
              {totalRemaining} restantes
            </span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
          Actualiser
        </button>
      </div>

      {isLoading && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-gray-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Chargement des licences…
        </p>
      )}

      {isError && (
        <p className="mt-3 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
          {error instanceof Error ? error.message : 'Erreur de récupération des licences'} — vérifie le scope DwD « apps.licensing ».
        </p>
      )}

      {skus && skus.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {skus.map((s) => {
            const noneLeft = s.remaining != null && s.remaining <= 0
            return (
              <div key={`${s.productId}|${s.skuId}`} className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-gray-800">{s.name}</div>
                  <div className="text-[11px] text-gray-500">
                    {s.total != null ? (
                      <>
                        <span className={noneLeft ? 'font-medium text-red-600' : 'font-medium text-emerald-600'}>
                          {s.remaining} restante{Math.abs(s.remaining ?? 0) > 1 ? 's' : ''}
                        </span>
                        {' · '}{s.used}/{s.total} utilisées
                      </>
                    ) : (
                      <>{s.used} utilisées · total non défini</>
                    )}
                  </div>
                </div>
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-gray-400">
                  total
                  <input
                    type="number"
                    min={0}
                    placeholder="—"
                    value={edits[s.skuId] ?? (s.total != null ? String(s.total) : '')}
                    onChange={(e) => setEdits((prev) => ({ ...prev, [s.skuId]: e.target.value }))}
                    onBlur={() => commitQuota(s.skuId)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    title="Nombre de sièges achetés pour cette licence"
                    className="w-16 rounded border border-gray-200 px-1.5 py-1 text-xs text-gray-700"
                  />
                </label>
              </div>
            )
          })}
        </div>
      )}

      {skus && skus.length === 0 && !isError && (
        <p className="mt-3 text-xs text-amber-600">
          Aucune licence détectée. Vérifie le scope DwD « apps.licensing » et le productId côté Google.
        </p>
      )}

      {skus && skus.length > 0 && (
        <p className="mt-2 text-[11px] text-gray-400">
          Saisis le nombre de sièges achetés dans « total » pour voir les restantes. L'attribution à un compte se fait sur sa carte de migration (étape « Licence »).
        </p>
      )}
    </section>
  )
}
