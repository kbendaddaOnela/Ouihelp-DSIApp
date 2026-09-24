import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Loader2, RefreshCw } from 'lucide-react'
import type { MigrationRecord } from '@dsi-app/shared'
import { migrationApi } from '../api'

/**
 * Étape « Licence Google » : liste les licences en usage et permet d'en attribuer
 * une au compte migré. Affiche « restantes = total − utilisées » ; le total de
 * sièges achetés se saisit à la main (Google ne l'expose pas par API pour un
 * client direct) et est persisté (table license_quotas), partagé entre toutes
 * les cartes.
 */
export function LicenseStep({ m }: { m: MigrationRecord }) {
  const queryClient = useQueryClient()
  const [edits, setEdits] = useState<Record<string, string>>({})

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['migration-history'] }),
  })

  const saveQuota = useMutation({
    mutationFn: ({ skuId, total }: { skuId: string; total: number | null }) =>
      migrationApi.setLicenseQuota(skuId, total),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['license-skus'] }),
  })

  if (!m.gohUpn) {
    return <p className="text-xs text-gray-500">Compte Google requis avant d'attribuer une licence.</p>
  }

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
                      <>{s.used} utilisées · total non défini</>
                    )}
                  </div>
                </div>
                <input
                  type="number"
                  min={0}
                  placeholder="total"
                  value={edits[s.skuId] ?? (s.total != null ? String(s.total) : '')}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [s.skuId]: e.target.value }))}
                  onBlur={() => commitQuota(s.skuId)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  title="Nombre de sièges achetés pour cette licence"
                  className="w-16 shrink-0 rounded border border-gray-200 px-1.5 py-1 text-xs text-gray-700"
                />
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
          <p className="text-[11px] text-gray-400">Saisis le nombre de sièges achetés dans le champ « total » pour voir les restantes.</p>
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
