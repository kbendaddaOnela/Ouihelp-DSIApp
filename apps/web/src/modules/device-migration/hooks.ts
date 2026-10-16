import { useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { UpdateDeviceMigrationRequest } from '@dsi-app/shared'
import { deviceMigrationApi } from './api'

const LIVE_STATUSES = ['scheduled', 'staging', 'staged', 'cleanup', 'ready', 'resetting', 'joining']

export function useDeviceMigrations() {
  return useQuery({
    queryKey: ['device-migrations'],
    queryFn: deviceMigrationApi.devices,
    // Bascule en cours : suivi en direct des étapes
    refetchInterval: (q) =>
      q.state.data?.devices.some((d) => d.migration && LIVE_STATUSES.includes(d.migration.status))
        ? 20_000
        : false,
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

// ── Bascule (lot 3) ──

export function useMigrationPackage() {
  return useQuery({
    queryKey: ['device-migration-package'],
    queryFn: deviceMigrationApi.getPackage,
  })
}

export function useUploadMigrationPackage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, tokenExpiresAt }: { file: File; tokenExpiresAt: string | null }) =>
      deviceMigrationApi.uploadPackage(file, tokenExpiresAt),
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-migration-package'] }),
  })
}

export function useScheduleMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, promptUser }: { id: string; promptUser: boolean }) =>
      deviceMigrationApi.scheduleMigration(id, { mode: 'reset', promptUser }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-migrations'] }),
  })
}

export function useCancelMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deviceMigrationApi.cancelMigration,
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-migrations'] }),
  })
}

export function useUpdateTargetName() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string | null }) =>
      deviceMigrationApi.updateTargetName(id, name),
    onSettled: () => qc.invalidateQueries({ queryKey: ['device-migrations'] }),
  })
}
