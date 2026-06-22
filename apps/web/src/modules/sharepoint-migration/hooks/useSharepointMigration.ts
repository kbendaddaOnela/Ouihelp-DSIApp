import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateSharepointMigrationRequest } from '@dsi-app/shared'
import { sharepointMigrationApi } from '../api'

export function useSharepointHistory() {
  return useQuery({
    queryKey: ['sharepoint-migration-history'],
    queryFn: () => sharepointMigrationApi.history(),
    staleTime: 5_000,
    refetchInterval: (q) => {
      const anyRunning = q.state.data?.migrations.some(
        (m) => m.status === 'pending' || m.status === 'running',
      )
      return anyRunning ? 4_000 : false
    },
  })
}

export function useResolveSite() {
  return useMutation({
    mutationFn: (url: string) => sharepointMigrationApi.resolveSite(url),
  })
}

export function useBrowse() {
  return useMutation({
    mutationFn: ({ driveId, itemId }: { driveId: string; itemId?: string | null }) =>
      sharepointMigrationApi.browse(driveId, itemId),
  })
}

export function useSearchSharedDrives(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ['sharepoint-search-drives', query],
    queryFn: () => sharepointMigrationApi.searchDrives(query),
    enabled,
    staleTime: 15_000,
  })
}

export function useCreateSharepointMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: CreateSharepointMigrationRequest) => sharepointMigrationApi.create(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharepoint-migration-history'] }),
  })
}

export function useRunSharepointMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharepointMigrationApi.run(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharepoint-migration-history'] }),
  })
}

export function usePauseSharepointMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharepointMigrationApi.pause(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharepoint-migration-history'] }),
  })
}

export function useUnstickSharepointMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharepointMigrationApi.unstick(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharepoint-migration-history'] }),
  })
}

export function useDeleteSharepointMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharepointMigrationApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharepoint-migration-history'] }),
  })
}
