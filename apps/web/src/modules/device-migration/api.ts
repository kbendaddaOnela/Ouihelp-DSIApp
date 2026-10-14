import { apiClient } from '@/lib/api'
import type {
  DeviceMigrationListResponse,
  DeviceMigrationSyncState,
  UpdateDeviceMigrationRequest,
} from '@dsi-app/shared'

export const deviceMigrationApi = {
  devices: () =>
    apiClient.get<DeviceMigrationListResponse>('/device-migration/devices').then((r) => r.data),

  syncState: () =>
    apiClient
      .get<{ sync: DeviceMigrationSyncState; lastSyncAt: string | null }>('/device-migration/sync')
      .then((r) => r.data),

  startSync: () => apiClient.post('/device-migration/sync').then((r) => r.data),

  update: (id: string, req: UpdateDeviceMigrationRequest) =>
    apiClient.patch(`/device-migration/devices/${id}`, req).then((r) => r.data),

  resetAgent: (id: string) =>
    apiClient.post(`/device-migration/devices/${id}/agent/reset`).then((r) => r.data),
}
