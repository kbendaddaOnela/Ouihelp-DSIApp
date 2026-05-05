import { apiClient } from '@/lib/api'

export type BillingEntity = 'BALM' | 'NHS' | 'NHS PACA' | 'ONELA Services' | 'ONELA SAS' | 'Colisee Domicile'
export type BudgetCategory = 'cloud' | 'saas' | 'hardware' | 'license' | 'support' | 'telecom' | 'other'
export type BillingCycle = 'monthly' | 'quarterly' | 'annual' | 'one_time'
export type BudgetStatus = 'active' | 'expiring_soon' | 'expired' | 'cancelled'

export const BILLING_ENTITIES: BillingEntity[] = ['BALM', 'NHS', 'NHS PACA', 'ONELA Services', 'ONELA SAS', 'Colisee Domicile']
export const BILLING_ENTITY_LABELS: Record<BillingEntity, string> = {
  BALM: 'BALM', NHS: 'NHS', 'NHS PACA': 'NHS PACA',
  'ONELA Services': 'ONELA Services', 'ONELA SAS': 'ONELA SAS',
  'Colisee Domicile': 'Colisée Domicile',
}

export interface BudgetItem {
  id: string
  name: string
  vendor: string | null
  category: BudgetCategory
  amount: string
  currency: string
  billingCycle: BillingCycle
  contractStart: string | null
  contractEnd: string | null
  autoRenewal: number
  renewalAlertDays: number
  billingEntity: BillingEntity | null
  status: BudgetStatus
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface BudgetStats {
  totalAnnual: number
  totalMonthly: number
  activeCount: number
  expiringSoonCount: number
  expiring30Count: number
  expiredCount: number
  byCategory: Record<string, number>
}

export type BudgetItemInput = Omit<BudgetItem, 'id' | 'createdAt' | 'updatedAt' | 'status'>

export const budgetApi = {
  stats: () => apiClient.get<BudgetStats>('/budget/stats').then((r) => r.data),
  items: (params?: { category?: string; status?: string; entity?: string; q?: string }) => {
    const p = new URLSearchParams()
    if (params?.category) p.set('category', params.category)
    if (params?.status) p.set('status', params.status)
    if (params?.entity) p.set('entity', params.entity)
    if (params?.q) p.set('q', params.q)
    const qs = p.toString()
    return apiClient.get<{ items: BudgetItem[] }>(`/budget/items${qs ? `?${qs}` : ''}`).then((r) => r.data)
  },
  create: (data: BudgetItemInput) =>
    apiClient.post<BudgetItem>('/budget/items', data).then((r) => r.data),
  update: (id: string, data: BudgetItemInput) =>
    apiClient.put<BudgetItem>(`/budget/items/${id}`, data).then((r) => r.data),
  delete: (id: string) =>
    apiClient.delete<{ deleted: boolean }>(`/budget/items/${id}`).then((r) => r.data),
}
