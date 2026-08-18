import { apiClient } from '@/lib/api'
import type {
  ResolveSiteResponse,
  BrowseResponse,
  SearchSharedDrivesResponse,
  CreateSharepointMigrationRequest,
  SharepointMigrationRecord,
  SharepointMigrationHistoryResponse,
  SharepointMigrationErrorsResponse,
  SharepointMigrationChangesResponse,
} from '@dsi-app/shared'

export const sharepointMigrationApi = {
  resolveSite: (url: string) =>
    apiClient
      .get<ResolveSiteResponse>(`/sharepoint-migration/resolve-site?url=${encodeURIComponent(url)}`)
      .then((r) => r.data),

  browse: (driveId: string, itemId?: string | null) =>
    apiClient
      .get<BrowseResponse>(
        `/sharepoint-migration/browse?driveId=${encodeURIComponent(driveId)}` +
          (itemId ? `&itemId=${encodeURIComponent(itemId)}` : ''),
      )
      .then((r) => r.data),

  searchDrives: (q: string) =>
    apiClient
      .get<SearchSharedDrivesResponse>(
        `/sharepoint-migration/search-drives${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      )
      .then((r) => r.data),

  history: ({ archived = false }: { archived?: boolean } = {}) =>
    apiClient
      .get<SharepointMigrationHistoryResponse>(
        `/sharepoint-migration/history?archived=${archived ? 1 : 0}`,
      )
      .then((r) => r.data),

  create: (req: CreateSharepointMigrationRequest) =>
    apiClient.post<SharepointMigrationRecord>('/sharepoint-migration', req).then((r) => r.data),

  run: (id: string) =>
    apiClient.post<SharepointMigrationRecord>(`/sharepoint-migration/${id}/run`).then((r) => r.data),

  pause: (id: string) =>
    apiClient.post<{ ok: boolean }>(`/sharepoint-migration/${id}/pause`).then((r) => r.data),

  unstick: (id: string) =>
    apiClient.post<{ ok: boolean }>(`/sharepoint-migration/${id}/unstick`).then((r) => r.data),

  rename: (id: string, label: string) =>
    apiClient
      .patch<SharepointMigrationRecord>(`/sharepoint-migration/${id}`, { label })
      .then((r) => r.data),

  archive: (id: string) =>
    apiClient
      .post<SharepointMigrationRecord>(`/sharepoint-migration/${id}/archive`)
      .then((r) => r.data),

  unarchive: (id: string) =>
    apiClient
      .post<SharepointMigrationRecord>(`/sharepoint-migration/${id}/unarchive`)
      .then((r) => r.data),

  remove: (id: string) =>
    apiClient.delete(`/sharepoint-migration/${id}`).then((r) => r.data),

  errors: (id: string) =>
    apiClient
      .get<SharepointMigrationErrorsResponse>(`/sharepoint-migration/${id}/errors`)
      .then((r) => r.data),

  changes: (id: string) =>
    apiClient
      .get<SharepointMigrationChangesResponse>(`/sharepoint-migration/${id}/changes`)
      .then((r) => r.data),
}
