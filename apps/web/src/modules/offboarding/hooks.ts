import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { offboardingApi } from './api'

export function useOffboardingSearch(query: string, enabled = true) {
  return useQuery({
    queryKey: ['offboarding-search', query],
    queryFn: () => offboardingApi.search(query),
    enabled: enabled && query.trim().length >= 2,
    staleTime: 60_000,
  })
}

export function useOffboardingUser(email: string | null) {
  return useQuery({
    queryKey: ['offboarding-user', email],
    queryFn: () => offboardingApi.user(email!),
    enabled: !!email,
    staleTime: 0,
  })
}

export function useOffboardingHistory() {
  return useQuery({
    queryKey: ['offboarding-history'],
    queryFn: offboardingApi.history,
  })
}

export function useOffboardingDelegations() {
  return useQuery({
    queryKey: ['offboarding-delegations'],
    queryFn: offboardingApi.delegations,
  })
}

export function useResetPassword() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: offboardingApi.resetPassword,
    onSettled: () => qc.invalidateQueries({ queryKey: ['offboarding-history'] }),
  })
}

export function useAddOffboardingDelegate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: offboardingApi.addDelegate,
    onSettled: (_d, _e, vars) => {
      qc.invalidateQueries({ queryKey: ['offboarding-user', vars.email] })
      qc.invalidateQueries({ queryKey: ['offboarding-history'] })
      qc.invalidateQueries({ queryKey: ['offboarding-delegations'] })
    },
  })
}

export function useRemoveOffboardingDelegate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ email, delegate }: { email: string; delegate: string }) =>
      offboardingApi.removeDelegate(email, delegate),
    onSettled: (_d, _e, vars) => {
      qc.invalidateQueries({ queryKey: ['offboarding-user', vars.email] })
      qc.invalidateQueries({ queryKey: ['offboarding-history'] })
      qc.invalidateQueries({ queryKey: ['offboarding-delegations'] })
    },
  })
}
