import { apiClient } from '@/lib/api'
import type {
  DeviceAppCatalogResponse,
  MigrationPackageResponse,
  MigrationProfilesResponse,
  UpdateAppRuleRequest,
  ScheduleMigrationRequest,
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

  // ── Bascule (lot 3) ──
  getPackage: () =>
    apiClient.get<MigrationPackageResponse>('/device-migration/package').then((r) => r.data),

  uploadPackage: (file: File, tokenExpiresAt: string | null) => {
    const form = new FormData()
    form.append('file', file)
    if (tokenExpiresAt) form.append('tokenExpiresAt', tokenExpiresAt)
    // Le client impose application/json par défaut : axios convertirait alors le FormData en
    // JSON et le fichier serait perdu. multipart/form-data laisse le navigateur poser la frontière.
    return apiClient
      .post('/device-migration/package', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data)
  },

  scheduleMigration: (id: string, req: ScheduleMigrationRequest) =>
    apiClient.post(`/device-migration/devices/${id}/migration`, req).then((r) => r.data),

  previewProfiles: (
    id: string,
    profileTargets: Record<string, string | null>,
    mainProfileSid: string | null
  ) =>
    apiClient
      .post<MigrationProfilesResponse>(`/device-migration/devices/${id}/migration/profiles`, {
        profileTargets,
        mainProfileSid,
      })
      .then((r) => r.data),

  resumeMigration: (id: string) =>
    apiClient.post(`/device-migration/devices/${id}/migration/resume`).then((r) => r.data),

  clearMigration: (id: string) =>
    apiClient.post(`/device-migration/devices/${id}/migration/clear`).then((r) => r.data),

  abandonMigration: (id: string) =>
    apiClient.post(`/device-migration/devices/${id}/migration/abandon`).then((r) => r.data),

  apps: () => apiClient.get<DeviceAppCatalogResponse>('/device-migration/apps').then((r) => r.data),

  updateAppRules: (req: UpdateAppRuleRequest) =>
    apiClient.put('/device-migration/apps/rules', req).then((r) => r.data),

  cancelMigration: (id: string) =>
    apiClient.post(`/device-migration/devices/${id}/migration/cancel`).then((r) => r.data),

  updateTargetName: (id: string, name: string | null) =>
    apiClient.patch(`/device-migration/devices/${id}/target-name`, { name }).then((r) => r.data),

  breakglass: (id: string) =>
    apiClient
      .get<{
        user: string
        password: string
      }>(`/device-migration/devices/${id}/migration/breakglass`)
      .then((r) => r.data),
}
