import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { budgetApi, type BudgetItemInput } from './api'

export function useBudgetStats() {
  return useQuery({
    queryKey: ['budget-stats'],
    queryFn: () => budgetApi.stats(),
    staleTime: 30_000,
  })
}

export function useBudgetItems(params?: Parameters<typeof budgetApi.items>[0]) {
  return useQuery({
    queryKey: ['budget-items', params],
    queryFn: () => budgetApi.items(params),
    staleTime: 30_000,
  })
}

export function useCreateBudgetItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: BudgetItemInput) => budgetApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budget-items'] })
      qc.invalidateQueries({ queryKey: ['budget-stats'] })
    },
  })
}

export function useUpdateBudgetItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: BudgetItemInput }) => budgetApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budget-items'] })
      qc.invalidateQueries({ queryKey: ['budget-stats'] })
    },
  })
}

export function useDeleteBudgetItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => budgetApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budget-items'] })
      qc.invalidateQueries({ queryKey: ['budget-stats'] })
    },
  })
}
