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
      // 8 s plutôt que 4 : pendant un gros transfert, /history peut mettre
      // plusieurs secondes et un intervalle court empile les requêtes.
      return anyRunning ? 8_000 : false
    },
  })
}

/** Migrations archivées — chargées seulement quand la section est dépliée. */
export function useArchivedSharepointMigrations(enabled: boolean) {
  return useQuery({
    queryKey: ['sharepoint-migration-archived'],
    queryFn: () => sharepointMigrationApi.history({ archived: true }),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
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

/** Invalide les DEUX listes : un archivage fait passer une carte de l'une à l'autre. */
function useArchiveMutation(fn: (id: string) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sharepoint-migration-history'] })
      void qc.invalidateQueries({ queryKey: ['sharepoint-migration-archived'] })
    },
  })
}

export function useRenameSharepointMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      sharepointMigrationApi.rename(id, label),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sharepoint-migration-history'] })
      void qc.invalidateQueries({ queryKey: ['sharepoint-migration-archived'] })
    },
  })
}

export function useArchiveSharepointMigration() {
  return useArchiveMutation((id) => sharepointMigrationApi.archive(id))
}

export function useUnarchiveSharepointMigration() {
  return useArchiveMutation((id) => sharepointMigrationApi.unarchive(id))
}

export function useDeleteSharepointMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharepointMigrationApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sharepoint-migration-history'] })
      void qc.invalidateQueries({ queryKey: ['sharepoint-migration-archived'] })
    },
  })
}
