import { apiClient } from '@/lib/api'
import type {
  SearchOnelaUsersResponse,
  MigrateUsersRequest,
  MigrateUsersResponse,
  MigrationHistoryResponse,
  MigrationRecord,
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

  addGoogleAlias: (id: string, alias?: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/google-alias`, alias ? { alias } : {}).then((r) => r.data),

  migrateMail: (id: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/migrate-mail`).then((r) => r.data),

  migrateCalendar: (id: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/migrate-calendar`).then((r) => r.data),

  migrateContacts: (id: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/migrate-contacts`).then((r) => r.data),

  fetchErrors: (id: string, phase: 'mail' | 'calendar' | 'contacts') =>
    apiClient.get<{
      phase: string
      errors: Array<{ id: number; graphId: string; internetMessageId?: string | null; iCalUid?: string | null; errorDetails: string | null; createdAt: string }>
    }>(`/migration/${id}/errors/${phase}`).then((r) => r.data),
}
