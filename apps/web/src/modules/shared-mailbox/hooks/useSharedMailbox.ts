import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateSharedMigrationRequest } from '@dsi-app/shared'
import { sharedMailboxApi } from '../api'

export function useSharedMailboxSearch(query: string) {
  return useQuery({
    queryKey: ['shared-mailbox-search', query],
    queryFn: () => sharedMailboxApi.search(query),
    staleTime: 30_000,
  })
}

export function useSharedMigrationHistory() {
  return useQuery({
    queryKey: ['shared-migration-history'],
    queryFn: () => sharedMailboxApi.history(),
    staleTime: 5_000,
    refetchInterval: (q) => {
      const anyRunning = q.state.data?.migrations.some(
        (m) => m.stepMailImport === 'pending' || m.stepMailImport === 'running' || m.stepCreateGroup === 'running',
      )
      return anyRunning ? 5_000 : false
    },
  })
}

export function useCreateSharedMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: CreateSharedMigrationRequest) => sharedMailboxApi.create(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-migration-history'] }),
  })
}

export function useRunSharedMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.run(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-migration-history'] }),
  })
}

export function useDeleteSharedMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-migration-history'] }),
  })
}
