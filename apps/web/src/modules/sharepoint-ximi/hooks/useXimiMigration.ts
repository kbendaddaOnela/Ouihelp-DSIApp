import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateXimiMigrationRequest } from '@dsi-app/shared'
import { ximiApi } from '../api'

const HISTORY_KEY = ['ximi-history']
const ARCHIVED_KEY = ['ximi-archived']

export function useXimiHistory() {
  return useQuery({
    queryKey: HISTORY_KEY,
    queryFn: () => ximiApi.history(),
    staleTime: 5_000,
    refetchInterval: (q) => {
      const anyRunning = q.state.data?.migrations.some(
        (m) => m.status === 'pending' || m.status === 'running',
      )
      return anyRunning ? 8_000 : false
    },
  })
}

export function useArchivedXimiMigrations(enabled: boolean) {
  return useQuery({
    queryKey: ARCHIVED_KEY,
    queryFn: () => ximiApi.history({ archived: true }),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
}

/**
 * Liste des sites du tenant ONELA. L'énumération Graph pagine sur tout le
 * tenant : elle est lente et ne bouge quasiment jamais, d'où un cache long et
 * un déclenchement explicite plutôt qu'au montage de la page.
 */
export function useXimiSourceSites(enabled: boolean) {
  return useQuery({
    queryKey: ['ximi-source-sites'],
    queryFn: () => ximiApi.sourceSites(),
    enabled,
    staleTime: 10 * 60_000,
  })
}

export function useXimiTargetGroups(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ['ximi-target-groups', query],
    queryFn: () => ximiApi.targetGroups(query),
    enabled,
    staleTime: 60_000,
  })
}

export function useXimiMapping(enabled: boolean) {
  return useQuery({
    queryKey: ['ximi-mapping'],
    queryFn: () => ximiApi.mapping(),
    enabled,
    staleTime: 15_000,
  })
}

/** Invalide les listes impactées par une action sur une migration. */
function useXimiMutation<TArgs, TData>(fn: (args: TArgs) => Promise<TData>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: HISTORY_KEY })
      void qc.invalidateQueries({ queryKey: ARCHIVED_KEY })
      // Le mappage est le livrable : il doit refléter immédiatement toute
      // création de site ou attribution de droits.
      void qc.invalidateQueries({ queryKey: ['ximi-mapping'] })
      // Un site nouvellement migré doit apparaître comme tel dans le sélecteur.
      void qc.invalidateQueries({ queryKey: ['ximi-source-sites'] })
    },
  })
}

export function useCreateXimiMigrations() {
  return useXimiMutation((sites: CreateXimiMigrationRequest[]) => ximiApi.createBulk(sites))
}

export function useRunXimiMigration() {
  return useXimiMutation((id: string) => ximiApi.run(id))
}

export function useRunAllXimiMigrations() {
  return useXimiMutation(() => ximiApi.runAll())
}

export function usePauseXimiMigration() {
  return useXimiMutation((id: string) => ximiApi.pause(id))
}

export function useUnstickXimiMigration() {
  return useXimiMutation((id: string) => ximiApi.unstick(id))
}

export function useRetryXimiPermissions() {
  return useXimiMutation(({ id, groupName }: { id: string; groupName?: string }) =>
    ximiApi.retryPermissions(id, groupName),
  )
}

export function useRenameXimiMigration() {
  return useXimiMutation(({ id, label }: { id: string; label: string }) =>
    ximiApi.rename(id, label),
  )
}

export function useSetXimiAlias() {
  return useXimiMutation(({ id, alias }: { id: string; alias: string }) =>
    ximiApi.setAlias(id, alias),
  )
}

export function useArchiveXimiMigration() {
  return useXimiMutation((id: string) => ximiApi.archive(id))
}

export function useUnarchiveXimiMigration() {
  return useXimiMutation((id: string) => ximiApi.unarchive(id))
}

export function useDeleteXimiMigration() {
  return useXimiMutation((id: string) => ximiApi.remove(id))
}
