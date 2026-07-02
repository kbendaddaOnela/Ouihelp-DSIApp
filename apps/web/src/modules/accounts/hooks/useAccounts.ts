import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateAccountRequest, AgencyInput } from '@dsi-app/shared'
import { accountsApi } from '../api'

const AGENCIES_KEY = ['accounts-agencies']

export function useAgencies() {
  return useQuery({
    queryKey: AGENCIES_KEY,
    queryFn: () => accountsApi.agencies(),
    staleTime: 5 * 60_000,
  })
}

export function useCreateAgency() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: AgencyInput) => accountsApi.createAgency(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENCIES_KEY }),
  })
}

export function useUpdateAgency() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: AgencyInput }) => accountsApi.updateAgency(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENCIES_KEY }),
  })
}

export function useDeleteAgency() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => accountsApi.deleteAgency(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENCIES_KEY }),
  })
}

const HISTORY_KEY = ['accounts-history']

export function useAccountsHistory() {
  return useQuery({
    queryKey: HISTORY_KEY,
    queryFn: () => accountsApi.history(),
    staleTime: 5_000,
    refetchInterval: (q) => {
      // Rafraîchir tant qu'un onboarding n'est pas totalement finalisé
      const anyPending = q.state.data?.accounts.some((a) =>
        [
          a.stepCreateGoh,
          a.stepSetAttributes,
          a.stepOnelaRouting,
          a.stepGoogleProvision,
          a.stepOuMove,
          a.stepNewFormat,
        ].some((s) => s === 'pending' || s === 'running'),
      )
      return anyPending ? 5_000 : false
    },
  })
}

export function useSearchManagers(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ['accounts-search-managers', query],
    queryFn: () => accountsApi.searchManagers(query),
    enabled,
    staleTime: 15_000,
  })
}

export function useCreateAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: CreateAccountRequest) => accountsApi.create(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: HISTORY_KEY }),
  })
}

export function useFinalizeGoogle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => accountsApi.finalizeGoogle(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: HISTORY_KEY }),
  })
}

export function useRetryAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => accountsApi.retry(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: HISTORY_KEY }),
  })
}

export function useDeleteAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, purgeRouting }: { id: string; purgeRouting?: boolean }) =>
      accountsApi.remove(id, purgeRouting),
    onSuccess: () => qc.invalidateQueries({ queryKey: HISTORY_KEY }),
  })
}
