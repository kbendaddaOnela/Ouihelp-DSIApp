import { useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { UpdateDeviceMigrationRequest } from '@dsi-app/shared'
import { deviceMigrationApi } from './api'

export function useDeviceMigrations() {
  return useQuery({
    queryKey: ['device-migrations'],
    queryFn: deviceMigrationApi.devices,
  })
}

/** Suit la synchro en cours ; recharge l'inventaire quand elle se termine. */
export function useDeviceSyncState() {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['device-migration-sync'],
    queryFn: deviceMigrationApi.syncState,
    refetchInterval: (q) => (q.state.data?.sync.running ? 3000 : false),
  })
  const wasRunning = useRef(false)
  const running = query.data?.sync.running ?? false
  useEffect(() => {
    if (wasRunning.current && !running) qc.invalidateQueries({ queryKey: ['device-migrations'] })
    wasRunning.current = running
  }, [running, qc])
  return query
}

export function useStartDeviceSync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deviceMigrationApi.startSync,
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-migration-sync'] }),
  })
}

export function useUpdateDeviceMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...req }: UpdateDeviceMigrationRequest & { id: string }) =>
      deviceMigrationApi.update(id, req),
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-migrations'] }),
  })
}

export function useResetDeviceAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deviceMigrationApi.resetAgent,
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-migrations'] }),
  })
}
