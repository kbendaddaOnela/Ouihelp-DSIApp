import { apiClient } from '@/lib/api'
import type {
  CreateAccountRequest,
  CreateAccountResponse,
  AccountHistoryResponse,
  SearchManagersResponse,
  AgenciesResponse,
  Agency,
  AgencyInput,
} from '@dsi-app/shared'

export const accountsApi = {
  agencies: () => apiClient.get<AgenciesResponse>('/accounts/agencies').then((r) => r.data),
  createAgency: (input: AgencyInput) =>
    apiClient.post<Agency>('/accounts/agencies', input).then((r) => r.data),
  updateAgency: (id: string, input: AgencyInput) =>
    apiClient.put<Agency>(`/accounts/agencies/${id}`, input).then((r) => r.data),
  deleteAgency: (id: string) => apiClient.delete(`/accounts/agencies/${id}`).then((r) => r.data),

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
