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
    staleTime: 5_000,
    refetchInterval: (q) => {
      // Refresh actif quand au moins une migration (mail/cal/contacts) est en cours
      const anyRunning = q.state.data?.migrations.some((m) =>
        ['pending', 'running'].includes(m.stepMailMigration) ||
        ['pending', 'running'].includes(m.stepCalendarMigration) ||
        ['pending', 'running'].includes(m.stepContactsMigration)
      )
      return anyRunning ? 5_000 : false
    },
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
    mutationFn: ({ id, alias }: { id: string; alias?: string }) => migrationApi.addGoogleAlias(id, alias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useMigrateMail() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.migrateMail(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useMigrateCalendar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.migrateCalendar(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useMigrateContacts() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.migrateContacts(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useMigrationErrors(id: string, phase: 'mail' | 'calendar' | 'contacts', enabled: boolean) {
  return useQuery({
    queryKey: ['migration-errors', id, phase],
    queryFn: () => migrationApi.fetchErrors(id, phase),
    enabled,
    staleTime: 30_000,
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
