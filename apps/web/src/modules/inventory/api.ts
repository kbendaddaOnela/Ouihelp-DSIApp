import { apiClient } from '@/lib/api'

export interface SyncStats {
  status: {
    id: string
    lastSyncAt: string | null
    userCount: number
    deviceCount: number
    status: string
    error: string | null
  } | null
  userCounts: Array<{ source: string; count: number }>
  deviceCounts: Array<{ source: string; count: number }>
  complianceCounts: Array<{ source: string; complianceState: string; count: number }>
}

export interface CachedDevice {
  id: string
  source: string
  deviceName: string | null
  operatingSystem: string | null
  osVersion: string | null
  deviceType: string | null
  complianceState: string
  userPrincipalName: string | null
  userDisplayName: string | null
  lastSyncDateTime: string | null
  enrolledDateTime: string | null
}

export const inventoryApi = {
  stats: () => apiClient.get<SyncStats>('/inventory/stats').then((r) => r.data),
  sync: () => apiClient.post<{ started: boolean }>('/inventory/sync', {}).then((r) => r.data),
  devices: (params?: { source?: string; compliance?: string; q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams()
    if (params?.source) p.set('source', params.source)
    if (params?.compliance) p.set('compliance', params.compliance)
    if (params?.q) p.set('q', params.q)
    if (params?.limit) p.set('limit', String(params.limit))
    if (params?.offset) p.set('offset', String(params.offset))
    return apiClient.get<{ devices: CachedDevice[] }>(`/inventory/devices?${p}`).then((r) => r.data)
  },
}
