import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateSharedMigrationRequest } from '@dsi-app/shared'
import { sharedMailboxApi } from '../api'

export function useSharedMailboxSearch(query: string) {
  return useQuery({
    queryKey: ['shared-mailbox-search', query],
    queryFn: () => sharedMailboxApi.search(query),
    staleTime: 30_000,
  })
}

export function useSharedMigrationHistory() {
  return useQuery({
    queryKey: ['shared-migration-history'],
    queryFn: () => sharedMailboxApi.history(),
    staleTime: 5_000,
    refetchInterval: (q) => {
      const anyRunning = q.state.data?.migrations.some(
        (m) =>
          m.stepMailImport === 'pending' ||
          m.stepMailImport === 'running' ||
          m.stepCreateGroup === 'running' ||
          m.stepCreateAccount === 'running' ||
          m.stepDelegates === 'running',
      )
      return anyRunning ? 5_000 : false
    },
  })
}

export function useCreateSharedMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: CreateSharedMigrationRequest) => sharedMailboxApi.create(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-migration-history'] }),
  })
}

export function useRunSharedMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.run(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-migration-history'] }),
  })
}

export function useStopSharedMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.stop(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-migration-history'] }),
  })
}

export function useSharedDualDeliveryStatus(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['shared-dual-delivery', id],
    queryFn: () => sharedMailboxApi.checkDualDelivery(id),
    enabled,
    staleTime: 30_000,
  })
}

export function useEnableSharedDualDelivery() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, bccAddress }: { id: string; bccAddress?: string }) =>
      sharedMailboxApi.enableDualDelivery(id, bccAddress),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ['shared-dual-delivery', vars.id] }),
  })
}

export function useDisableSharedDualDelivery() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.disableDualDelivery(id),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ['shared-dual-delivery', id] }),
  })
}

export function useAllowExternalGroupPosts() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.allowExternalGroupPosts(id),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ['shared-dual-delivery', id] }),
  })
}

export function useEnableCollaborativeInbox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.enableCollaborativeInbox(id),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ['shared-dual-delivery', id] }),
  })
}

export function useAddMigAlias() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.addMigAlias(id),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ['shared-dual-delivery', id] }),
  })
}

export function useSetupLabel() {
  return useMutation({ mutationFn: (id: string) => sharedMailboxApi.setupLabel(id) })
}
export function useSetupFilter() {
  return useMutation({ mutationFn: (id: string) => sharedMailboxApi.setupFilter(id) })
}
export function useSetupSendAs() {
  return useMutation({ mutationFn: (id: string) => sharedMailboxApi.setupSendAs(id) })
}

export function useSilenceMembers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.silenceMembers(id),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ['shared-dual-delivery', id] }),
  })
}

export function useDeleteSharedMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-migration-history'] }),
  })
}

// ── Mode « compte Google classique » ────────────────────────────────────────

export function useSharedAccountStatus(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['shared-account-status', id],
    queryFn: () => sharedMailboxApi.accountStatus(id),
    enabled,
    staleTime: 30_000,
  })
}

export function useLicenseAck() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.licenseAck(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['shared-migration-history'] })
      qc.invalidateQueries({ queryKey: ['shared-account-status', id] })
    },
  })
}

export function useAliasSendAs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.aliasSendAs(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['shared-migration-history'] })
      qc.invalidateQueries({ queryKey: ['shared-account-status', id] })
    },
  })
}

/** Candidats à la délégation, déduits du FullAccess Exchange sur la BAL. */
export function useDelegateCandidates(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['shared-delegate-candidates', id],
    queryFn: () => sharedMailboxApi.delegateCandidates(id),
    enabled,
    staleTime: 60_000,
  })
}

/** Recherche dans l'annuaire Google (ajout manuel d'un délégué). */
export function useGoogleUserSearch(query: string) {
  return useQuery({
    queryKey: ['shared-google-users', query],
    queryFn: () => sharedMailboxApi.searchGoogleUsers(query),
    enabled: query.trim().length >= 2,
    staleTime: 60_000,
  })
}

export function useAddDelegate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, googleEmail, sourceUpn }: { id: string; googleEmail: string; sourceUpn?: string | null }) =>
      sharedMailboxApi.addDelegate(id, googleEmail, sourceUpn),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['shared-migration-history'] })
      qc.invalidateQueries({ queryKey: ['shared-delegate-candidates', vars.id] })
    },
  })
}

export function useRemoveDelegate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, delegateId }: { id: string; delegateId: number }) =>
      sharedMailboxApi.removeDelegate(id, delegateId),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['shared-migration-history'] })
      qc.invalidateQueries({ queryKey: ['shared-delegate-candidates', vars.id] })
    },
  })
}

export function useApplyDelegates() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharedMailboxApi.applyDelegates(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shared-migration-history'] }),
  })
}
