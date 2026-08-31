import { apiClient } from '@/lib/api'
import type {
  SearchSharedMailboxesResponse,
  SharedMigrationHistoryResponse,
  CreateSharedMigrationRequest,
  SharedMigrationRecord,
  DelegateCandidatesResponse,
  SearchGoogleUsersResponse,
} from '@dsi-app/shared'

export interface SharedAccountStatus {
  exists: boolean
  primaryEmail?: string | null
  orgUnitPath?: string | null
  suspended?: boolean | null
  aliases?: string[]
  aliasPresent?: boolean
  mailboxReady: boolean
}

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

  // ── Compte Google cible (mode account) ────────────────────────────────────
  accountStatus: (id: string) =>
    apiClient.get<SharedAccountStatus>(`/shared-mailbox/${id}/account`).then((r) => r.data),

  licenseAck: (id: string) =>
    apiClient.post<SharedMigrationRecord>(`/shared-mailbox/${id}/license-ack`).then((r) => r.data),

  aliasSendAs: (id: string) =>
    apiClient.post<SharedMigrationRecord>(`/shared-mailbox/${id}/alias-send-as`).then((r) => r.data),

  // ── Délégations Gmail ─────────────────────────────────────────────────────
  delegateCandidates: (id: string) =>
    apiClient
      .get<DelegateCandidatesResponse>(`/shared-mailbox/${id}/delegate-candidates`)
      .then((r) => r.data),

  searchGoogleUsers: (q: string) =>
    apiClient
      .get<SearchGoogleUsersResponse>(`/shared-mailbox/google-users/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.data),

  addDelegate: (id: string, googleEmail: string, sourceUpn?: string | null) =>
    apiClient
      .post<SharedMigrationRecord>(`/shared-mailbox/${id}/delegates`, { googleEmail, sourceUpn })
      .then((r) => r.data),

  removeDelegate: (id: string, delegateId: number) =>
    apiClient
      .delete<SharedMigrationRecord>(`/shared-mailbox/${id}/delegates/${delegateId}`)
      .then((r) => r.data),

  applyDelegates: (id: string) =>
    apiClient
      .post<{ ok: boolean; total: number; applied: number; failed: number }>(
        `/shared-mailbox/${id}/delegates/apply`,
      )
      .then((r) => r.data),

  liveDelegates: (id: string) =>
    apiClient
      .get<{ delegates: Array<{ delegateEmail: string; verificationStatus?: string }> }>(
        `/shared-mailbox/${id}/delegates/live`,
      )
      .then((r) => r.data),

  // ── Dual delivery ─────────────────────────────────────────────────────────
  checkDualDelivery: (id: string) =>
    apiClient
      .get<{
        forwarding: { active: boolean; forwardTo: string | null }
        expectedRoutingAddress: string | null
        groupPostPermission: string | null
        groupAllowsExternalPosts: boolean
        groupCollaborativeInbox?: boolean
      }>(`/shared-mailbox/${id}/dual-delivery`)
      .then((r) => r.data),

  enableDualDelivery: (id: string, bccAddress?: string) =>
    apiClient
      .post<{ ok: boolean; forwardTo: string }>(
        `/shared-mailbox/${id}/dual-delivery`,
        bccAddress ? { bccAddress } : undefined,
      )
      .then((r) => r.data),

  disableDualDelivery: (id: string) =>
    apiClient.delete<{ ok: boolean }>(`/shared-mailbox/${id}/dual-delivery`).then((r) => r.data),

  // ── Legacy « Google Group » (migrations déjà réalisées) ───────────────────
  allowExternalGroupPosts: (id: string) =>
    apiClient
      .post<{ ok: boolean }>(`/shared-mailbox/${id}/group/allow-external`)
      .then((r) => r.data),

  enableCollaborativeInbox: (id: string) =>
    apiClient
      .post<{ ok: boolean }>(`/shared-mailbox/${id}/group/collaborative-inbox`)
      .then((r) => r.data),

  addMigAlias: (id: string) =>
    apiClient
      .post<{ ok: boolean; alias: string; added: boolean }>(`/shared-mailbox/${id}/group/add-mig-alias`)
      .then((r) => r.data),

  setupLabel: (id: string) =>
    apiClient
      .post<{ ok: boolean; total: number; created: number; alreadyOk: number; failed: number; failedMembers: string[] }>(
        `/shared-mailbox/${id}/members/setup-label`,
      )
      .then((r) => r.data),

  setupFilter: (id: string) =>
    apiClient
      .post<{
        ok: boolean
        total: number
        created: number
        alreadyOk: number
        failed: number
        failedMembers: string[]
        backfilledMessages: number
      }>(`/shared-mailbox/${id}/members/setup-filter`)
      .then((r) => r.data),

  setupSendAs: (id: string) =>
    apiClient
      .post<{ ok: boolean; total: number; created: number; alreadyOk: number; failed: number; failedMembers: string[] }>(
        `/shared-mailbox/${id}/members/setup-send-as`,
      )
      .then((r) => r.data),

  silenceMembers: (id: string) =>
    apiClient
      .post<{ ok: boolean; total: number; updated: number; alreadySilent: number; failed: number; failedMembers: string[] }>(
        `/shared-mailbox/${id}/group/silence-members`,
      )
      .then((r) => r.data),

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
