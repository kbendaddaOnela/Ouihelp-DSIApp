import { apiClient } from '@/lib/api'
import type {
  SearchOnelaUsersResponse,
  MigrateUsersRequest,
  MigrateExistingRequest,
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

  runExisting: (req: MigrateExistingRequest) =>
    apiClient.post<MigrateUsersResponse>('/migration/run-existing', req).then((r) => r.data),

  history: (page = 1) =>
    apiClient.get<MigrationHistoryResponse>(`/migration/history?page=${page}`).then((r) => r.data),

  addGoogleAlias: (id: string, alias?: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/google-alias`, alias ? { alias } : {}).then((r) => r.data),

  activateNewFormat: (id: string) =>
    apiClient
      .post<{
        ok: boolean
        alias: string
        aliasAdded: boolean
        sendAsAdded: boolean
        warnings: string[]
      }>(`/migration/${id}/activate-new-format`)
      .then((r) => r.data),

  migrateMail: (id: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/migrate-mail`).then((r) => r.data),

  migrateCalendar: (id: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/migrate-calendar`).then((r) => r.data),

  migrateContacts: (id: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/migrate-contacts`).then((r) => r.data),

  checkGoogle: (id: string) =>
    apiClient.get<{ exists: boolean; email: string | null }>(`/migration/${id}/check-google`).then((r) => r.data),

  fetchErrors: (id: string, phase: 'mail' | 'calendar' | 'contacts') =>
    apiClient.get<{
      phase: string
      errors: Array<{ id: number; graphId: string; internetMessageId?: string | null; iCalUid?: string | null; errorDetails: string | null; createdAt: string }>
    }>(`/migration/${id}/errors/${phase}`).then((r) => r.data),

  downloadErrorsUrl: (id: string, phase: 'mail' | 'calendar' | 'contacts') =>
    `/migration/${id}/errors/${phase}/download`,

  archive: (id: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/archive`).then((r) => r.data),

  unarchive: (id: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/unarchive`).then((r) => r.data),

  remove: (id: string) =>
    apiClient.delete(`/migration/${id}`).then((r) => r.data),

  stop: (id: string, phase: 'mail' | 'calendar' | 'contacts') =>
    apiClient.post<MigrationRecord>(`/migration/${id}/stop/${phase}`).then((r) => r.data),

  reset: (id: string, phase: 'mail' | 'calendar' | 'contacts') =>
    apiClient.post<MigrationRecord>(`/migration/${id}/reset/${phase}`).then((r) => r.data),

  relabelMail: (id: string) =>
    apiClient.post<{ message: string }>(`/migration/${id}/relabel-mail`).then((r) => r.data),

  dedupeMail: (id: string) =>
    apiClient.post<{ message: string }>(`/migration/${id}/dedupe-mail`).then((r) => r.data),

  moveOu: (id: string) =>
    apiClient.post<MigrationRecord>(`/migration/${id}/move-ou`).then((r) => r.data),

  setForwarding: (id: string) =>
    apiClient.post<{ success: boolean; forwardTo: string }>(`/migration/${id}/forwarding`).then((r) => r.data),

  removeForwarding: (id: string) =>
    apiClient.delete<{ success: boolean }>(`/migration/${id}/forwarding`).then((r) => r.data),

  checkForwarding: (id: string) =>
    apiClient.get<{ active: boolean; forwardTo: string | null }>(`/migration/${id}/forwarding`).then((r) => r.data),
}

export interface MigrationStats {
  totals: { total: number; pending: number; in_progress: number; done: number }
  byDept: Array<{ department: string; total: number; done: number; in_progress: number }>
  byOffice: Array<{ office: string; total: number; done: number; in_progress: number }>
}

export const migrationTargetsApi = {
  importCSV: (csv: string) =>
    apiClient.post<{ imported: number; inserted: number; updated: number }>('/migration-targets/import', { csv }).then((r) => r.data),

  stats: () =>
    apiClient.get<MigrationStats>('/migration-targets/stats').then((r) => r.data),

  resetDone: () =>
    apiClient.post<{ ok: boolean }>('/migration-targets/reset-done').then((r) => r.data),
}
