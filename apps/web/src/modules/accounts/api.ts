import { apiClient } from '@/lib/api'
import type {
  CreateAccountRequest,
  CreateAccountResponse,
  AccountHistoryResponse,
  SearchManagersResponse,
} from '@dsi-app/shared'

export const accountsApi = {
  searchManagers: (q: string) =>
    apiClient
      .get<SearchManagersResponse>(`/accounts/search-managers?q=${encodeURIComponent(q)}`)
      .then((r) => r.data),

  history: () => apiClient.get<AccountHistoryResponse>('/accounts/history').then((r) => r.data),

  create: (req: CreateAccountRequest) =>
    apiClient.post<CreateAccountResponse>('/accounts', req).then((r) => r.data),

  finalizeGoogle: (id: string) =>
    apiClient.post<{ message: string }>(`/accounts/${id}/finalize-google`).then((r) => r.data),

  retry: (id: string) =>
    apiClient.post<{ message: string }>(`/accounts/${id}/retry`).then((r) => r.data),

  remove: (id: string, purgeRouting = false) =>
    apiClient
      .delete(`/accounts/${id}${purgeRouting ? '?purgeRouting=1' : ''}`)
      .then((r) => r.data),
}
