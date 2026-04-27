import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { MigrationRecord, MigrateUsersRequest } from '@dsi-app/shared'
import { migrationApi } from '../api'

export function useMigrationSearch(query: string) {
  return useQuery({
    queryKey: ['migration-search', query],
    queryFn: () => migrationApi.search(query),
    enabled: query.length >= 2,
    staleTime: 30_000,
  })
}

export function useMigrationHistory() {
  return useQuery({
    queryKey: ['migration-history'],
    queryFn: () => migrationApi.history(),
    staleTime: 30_000,
  })
}

export function useRunMigration(onSuccess: (migrations: MigrationRecord[]) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: MigrateUsersRequest) => migrationApi.run(req),
    onSuccess: (data) => {
      onSuccess(data.migrations)
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useAddGoogleAlias() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.addGoogleAlias(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useDebounce(value: string, delay = 400) {
  const [debounced, setDebounced] = useState(value)
  useState(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  })
  return debounced
}
