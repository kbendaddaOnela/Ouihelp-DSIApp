import { apiClient } from '@/lib/api'
import type {
  SearchOnelaUsersResponse,
  MigrateUsersRequest,
  MigrateUsersResponse,
  MigrationHistoryResponse,
} from '@dsi-app/shared'

export const migrationApi = {
  search: (q: string) =>
    apiClient
      .get<SearchOnelaUsersResponse>(`/migration/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.data),

  run: (req: MigrateUsersRequest) =>
    apiClient.post<MigrateUsersResponse>('/migration/run', req).then((r) => r.data),

  history: (page = 1) =>
    apiClient.get<MigrationHistoryResponse>(`/migration/history?page=${page}`).then((r) => r.data),
}
