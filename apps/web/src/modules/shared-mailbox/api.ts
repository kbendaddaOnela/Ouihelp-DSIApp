import { apiClient } from '@/lib/api'
import type {
  SearchSharedMailboxesResponse,
  SharedMigrationHistoryResponse,
  CreateSharedMigrationRequest,
  SharedMigrationRecord,
} from '@dsi-app/shared'

export const sharedMailboxApi = {
  search: (q: string) =>
    apiClient
      .get<SearchSharedMailboxesResponse>(`/shared-mailbox/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.data),

  history: () =>
    apiClient.get<SharedMigrationHistoryResponse>('/shared-mailbox/history').then((r) => r.data),

  create: (req: CreateSharedMigrationRequest) =>
    apiClient.post<SharedMigrationRecord>('/shared-mailbox', req).then((r) => r.data),

  run: (id: string) =>
    apiClient.post<SharedMigrationRecord>(`/shared-mailbox/${id}/run`).then((r) => r.data),

  stop: (id: string) =>
    apiClient.post<{ ok: boolean }>(`/shared-mailbox/${id}/stop`).then((r) => r.data),

  remove: (id: string) =>
    apiClient.delete(`/shared-mailbox/${id}`).then((r) => r.data),

  errors: (id: string) =>
    apiClient
      .get<{
        errors: Array<{
          id: number
          graphId: string
          internetMessageId: string | null
          subject: string | null
          receivedAt: string | null
          errorDetails: string | null
          createdAt: string
        }>
      }>(`/shared-mailbox/${id}/errors`)
      .then((r) => r.data),
}
