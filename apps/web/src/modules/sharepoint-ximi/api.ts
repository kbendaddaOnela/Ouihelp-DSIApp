import { apiClient } from '@/lib/api'
import type {
  CreateXimiMigrationRequest,
  XimiMigrationRecord,
  XimiMigrationHistoryResponse,
  XimiMigrationErrorsResponse,
  XimiMigrationChangesResponse,
  XimiSourceSitesResponse,
  XimiTargetGroupsResponse,
  XimiMappingResponse,
} from '@dsi-app/shared'

export const ximiApi = {
  sourceSites: (q?: string) =>
    apiClient
      .get<XimiSourceSitesResponse>(
        `/sharepoint-ximi/source-sites${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      )
      .then((r) => r.data),

  targetGroups: (q: string) =>
    apiClient
      .get<XimiTargetGroupsResponse>(`/sharepoint-ximi/target-groups?q=${encodeURIComponent(q)}`)
      .then((r) => r.data),

  history: ({ archived = false }: { archived?: boolean } = {}) =>
    apiClient
      .get<XimiMigrationHistoryResponse>(`/sharepoint-ximi/history?archived=${archived ? 1 : 0}`)
      .then((r) => r.data),

  create: (req: CreateXimiMigrationRequest) =>
    apiClient.post<XimiMigrationRecord>('/sharepoint-ximi', req).then((r) => r.data),

  createBulk: (sites: CreateXimiMigrationRequest[]) =>
    apiClient
      .post<{ created: number; skipped: string[] }>('/sharepoint-ximi/bulk', { sites })
      .then((r) => r.data),

  run: (id: string) =>
    apiClient.post<XimiMigrationRecord>(`/sharepoint-ximi/${id}/run`).then((r) => r.data),

  runAll: () =>
    apiClient.post<{ queued: number }>('/sharepoint-ximi/run-all').then((r) => r.data),

  pause: (id: string) =>
    apiClient.post<{ ok: boolean }>(`/sharepoint-ximi/${id}/pause`).then((r) => r.data),

  unstick: (id: string) =>
    apiClient.post<{ ok: boolean }>(`/sharepoint-ximi/${id}/unstick`).then((r) => r.data),

  retryPermissions: (id: string, dynamicGroupName?: string) =>
    apiClient
      .post<XimiMigrationRecord>(
        `/sharepoint-ximi/${id}/retry-permissions`,
        dynamicGroupName ? { dynamicGroupName } : {},
      )
      .then((r) => r.data),

  rename: (id: string, label: string) =>
    apiClient.patch<XimiMigrationRecord>(`/sharepoint-ximi/${id}`, { label }).then((r) => r.data),

  setAlias: (id: string, targetSiteAlias: string) =>
    apiClient
      .patch<XimiMigrationRecord>(`/sharepoint-ximi/${id}`, { targetSiteAlias })
      .then((r) => r.data),

  archive: (id: string) =>
    apiClient.post<XimiMigrationRecord>(`/sharepoint-ximi/${id}/archive`).then((r) => r.data),

  unarchive: (id: string) =>
    apiClient.post<XimiMigrationRecord>(`/sharepoint-ximi/${id}/unarchive`).then((r) => r.data),

  remove: (id: string) => apiClient.delete(`/sharepoint-ximi/${id}`).then((r) => r.data),

  errors: (id: string) =>
    apiClient
      .get<XimiMigrationErrorsResponse>(`/sharepoint-ximi/${id}/errors`)
      .then((r) => r.data),

  changes: (id: string) =>
    apiClient
      .get<XimiMigrationChangesResponse>(`/sharepoint-ximi/${id}/changes`)
      .then((r) => r.data),

  mapping: () =>
    apiClient.get<XimiMappingResponse>('/sharepoint-ximi/mapping').then((r) => r.data),
}
