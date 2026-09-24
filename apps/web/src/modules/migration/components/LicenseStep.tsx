import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Loader2, RefreshCw } from 'lucide-react'
import type { MigrationRecord } from '@dsi-app/shared'
import { migrationApi } from '../api'

/**
 * Étape « Licence Google » d'une carte : attribue une licence au compte migré.
 * Les restantes sont en lecture seule ici — le nombre de sièges achetés se gère
 * une seule fois dans le panneau « Licences Google disponibles » du dashboard.
 */
export function LicenseStep({ m }: { m: MigrationRecord }) {
  const queryClient = useQueryClient()

  const enabled = !!m.gohUpn
  const { data: skus, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['license-skus'],
    queryFn: migrationApi.licenseSkus,
    enabled,
    staleTime: 60_000,
  })

  const assign = useMutation({
    mutationFn: ({ productId, skuId }: { productId: string; skuId: string }) =>
      migrationApi.assignLicense(m.id, productId, skuId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
      queryClient.invalidateQueries({ queryKey: ['license-skus'] })
      queryClient.invalidateQueries({ queryKey: ['live-stats'] })
    },
  })

  if (!m.gohUpn) {
    return <p className="text-xs text-gray-500">Compte Google requis avant d'attribuer une licence.</p>
  }

  return (
    <div className="space-y-2">
      {m.stepLicense === 'success' && m.licenseSkuName && (
        <div className="flex items-center gap-1.5 rounded bg-green-50 px-2 py-1 text-xs text-green-700">
          <BadgeCheck className="h-3.5 w-3.5 shrink-0" />
          Licence assignée : <span className="font-medium">{m.licenseSkuName}</span>
        </div>
      )}

      {isLoading && (
        <p className="flex items-center gap-1.5 text-xs text-gray-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Chargement des licences…
        </p>
      )}

      {isError && (
        <div className="space-y-1">
          <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">
            {error instanceof Error ? error.message : 'Erreur de récupération des licences'}
          </p>
          <button onClick={() => refetch()} className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700">
            <RefreshCw className="h-3 w-3" /> Réessayer
          </button>
        </div>
      )}

      {skus && skus.length > 0 && (
        <div className="space-y-1.5">
          {skus.map((s) => {
            const isAssigned = m.stepLicense === 'success' && m.licenseSkuId === s.skuId
            const noneLeft = s.remaining != null && s.remaining <= 0
            return (
              <div key={`${s.productId}|${s.skuId}`} className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1.5">
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
                      <>{s.used} utilisées</>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => assign.mutate({ productId: s.productId, skuId: s.skuId })}
                  disabled={assign.isPending || isAssigned}
                  title={isAssigned ? 'Déjà assignée à ce compte' : undefined}
                  className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  {isAssigned ? '✓' : 'Assigner'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {skus && skus.length === 0 && !isError && (
        <p className="text-xs text-amber-600">
          Aucune licence détectée. Vérifie le scope DwD « apps.licensing » et le productId côté Google.
        </p>
      )}

      {m.stepLicense === 'error' && m.licenseError && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{m.licenseError}</p>
      )}
    </div>
  )
}
