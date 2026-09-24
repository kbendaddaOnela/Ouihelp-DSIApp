import { apiClient } from '@/lib/api'
import type {
  OffboardingSearchResponse,
  OffboardingUserDetail,
  ResetPasswordRequest,
  ResetPasswordResponse,
  AddOffboardingDelegateRequest,
  AddOffboardingDelegateResponse,
  OffboardingHistoryResponse,
} from '@dsi-app/shared'

export const offboardingApi = {
  search: (q: string) =>
    apiClient
      .get<OffboardingSearchResponse>(`/offboarding/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.data),

  user: (email: string) =>
    apiClient
      .get<OffboardingUserDetail>(`/offboarding/user?email=${encodeURIComponent(email)}`)
      .then((r) => r.data),

  resetPassword: (req: ResetPasswordRequest) =>
    apiClient.post<ResetPasswordResponse>('/offboarding/reset-password', req).then((r) => r.data),

  addDelegate: (req: AddOffboardingDelegateRequest) =>
    apiClient.post<AddOffboardingDelegateResponse>('/offboarding/delegates', req).then((r) => r.data),

  removeDelegate: (email: string, delegate: string) =>
    apiClient
      .delete(
        `/offboarding/delegates?email=${encodeURIComponent(email)}&delegate=${encodeURIComponent(delegate)}`,
      )
      .then((r) => r.data),

  history: () => apiClient.get<OffboardingHistoryResponse>('/offboarding/history').then((r) => r.data),
}
