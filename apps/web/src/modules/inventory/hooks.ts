import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from './api'

export function useInventoryStats() {
  return useQuery({
    queryKey: ['inventory-stats'],
    queryFn: () => inventoryApi.stats(),
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
}

export function useInventorySync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => inventoryApi.sync(),
    onSuccess: () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ['inventory-stats'] }), 3000)
    },
  })
}

export function useDevices(params?: Parameters<typeof inventoryApi.devices>[0]) {
  return useQuery({
    queryKey: ['inventory-devices', params],
    queryFn: () => inventoryApi.devices(params),
    staleTime: 60_000,
  })
}

export function useUsers(params?: Parameters<typeof inventoryApi.users>[0]) {
  return useQuery({
    queryKey: ['inventory-users', params],
    queryFn: () => inventoryApi.users(params),
    staleTime: 60_000,
  })
}
