import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateAccountRequest } from '@dsi-app/shared'
import { accountsApi } from '../api'

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
