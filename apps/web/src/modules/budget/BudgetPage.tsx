import { useState } from 'react'
import {
  Euro, AlertTriangle, Clock, Plus, Search, Pencil, Trash2, X,
  Building2, Cloud, Monitor, Key, Headphones, Phone, Package, CheckCircle2, XCircle,
  AlertCircle,
} from 'lucide-react'
import { usePermission } from '@/hooks/usePermission'
import { cn } from '@/lib/utils'
import {
  useBudgetStats, useBudgetItems, useCreateBudgetItem, useUpdateBudgetItem, useDeleteBudgetItem,
} from './hooks'
import type { BudgetItem, BudgetCategory, BillingCycle, BillingEntity, BudgetItemInput } from './api'
import { BILLING_ENTITIES } from './api'

// ── Config ────────────────────────────────────────────────────────────────────
const CATEGORY_CONFIG: Record<BudgetCategory, { label: string; icon: React.ElementType; color: string }> = {
  cloud:     { label: 'Cloud / Infra',   icon: Cloud,       color: 'bg-sky-100 text-sky-700' },
  saas:      { label: 'SaaS',            icon: Package,     color: 'bg-violet-100 text-violet-700' },
  hardware:  { label: 'Matériel',        icon: Monitor,     color: 'bg-orange-100 text-orange-700' },
  license:   { label: 'Licence',         icon: Key,         color: 'bg-yellow-100 text-yellow-700' },
  support:   { label: 'Support / MCO',   icon: Headphones,  color: 'bg-pink-100 text-pink-700' },
  telecom:   { label: 'Télécom',         icon: Phone,       color: 'bg-teal-100 text-teal-700' },
  other:     { label: 'Autre',           icon: Building2,   color: 'bg-gray-100 text-gray-600' },
}

const BILLING_LABELS: Record<BillingCycle, string> = {
  monthly:   'Mensuel',
  quarterly: 'Trimestriel',
  annual:    'Annuel',
  one_time:  'Ponctuel',
}

const STATUS_CONFIG = {
  active:        { label: 'Actif',       icon: CheckCircle2, color: 'text-green-600 bg-green-50' },
  expiring_soon: { label: 'Expire bientôt', icon: AlertCircle, color: 'text-orange-600 bg-orange-50' },
  expired:       { label: 'Expiré',      icon: XCircle,      color: 'text-red-600 bg-red-50' },
  cancelled:     { label: 'Annulé',      icon: XCircle,      color: 'text-gray-400 bg-gray-50' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toAnnual(item: BudgetItem): number {
  const amt = Number(item.amount)
  switch (item.billingCycle) {
    case 'monthly':   return amt * 12
    case 'quarterly': return amt * 4
    case 'annual':    return amt
    case 'one_time':  return amt
  }
}

function formatEur(n: number) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

function daysUntil(d: string | null): number | null {
  if (!d) return null
  return Math.round((new Date(d).getTime() - Date.now()) / 864e5)
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon: Icon, accent }: {
  label: string; value: string; sub?: string; icon: React.ElementType; accent: string
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className={cn('inline-flex h-9 w-9 items-center justify-center rounded-lg', accent)}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="mt-3 text-2xl font-semibold text-gray-900">{value}</p>
      <p className="mt-0.5 text-xs text-gray-500">{label}</p>
      {sub && <p className="mt-1 text-[11px] text-gray-400">{sub}</p>}
    </div>
  )
}

// ── Category bar chart ────────────────────────────────────────────────────────
function CategoryChart({ byCategory }: { byCategory: Record<string, number> }) {
  const entries = Object.entries(byCategory).sort(([, a], [, b]) => b - a)
  const total = entries.reduce((s, [, v]) => s + v, 0)
  if (!entries.length) return null

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500">Répartition par catégorie</h3>
      <div className="space-y-3">
        {entries.map(([cat, amt]) => {
          const cfg = CATEGORY_CONFIG[cat as BudgetCategory] ?? CATEGORY_CONFIG.other
          const pct = total > 0 ? Math.round((amt / total) * 100) : 0
          return (
            <div key={cat}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className={cn('inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-medium', cfg.color)}>
                  <cfg.icon className="h-3 w-3" />
                  {cfg.label}
                </span>
                <span className="text-gray-600">{formatEur(amt)} <span className="text-gray-400">({pct}%)</span></span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Expiry timeline ───────────────────────────────────────────────────────────
function ExpiryTimeline({ items }: { items: BudgetItem[] }) {
  const upcoming = items
    .filter(i => i.contractEnd && (i.status === 'active' || i.status === 'expiring_soon'))
    .sort((a, b) => (a.contractEnd ?? '').localeCompare(b.contractEnd ?? ''))
    .slice(0, 8)

  if (!upcoming.length) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Prochaines échéances</h3>
        <p className="text-sm text-gray-400">Aucune échéance à venir.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500">Prochaines échéances</h3>
      <div className="space-y-2">
        {upcoming.map(item => {
          const days = daysUntil(item.contractEnd)
          const urgent = days !== null && days <= 30
          const warning = days !== null && days <= 90 && !urgent
          const cfg = CATEGORY_CONFIG[item.category] ?? CATEGORY_CONFIG.other
          return (
            <div key={item.id} className="flex items-center gap-3 rounded-lg p-2 hover:bg-gray-50">
              <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', cfg.color)}>
                <cfg.icon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-800">{item.name}</p>
                <p className="text-xs text-gray-400">{item.vendor ?? ''}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs text-gray-600">{formatDate(item.contractEnd)}</p>
                {days !== null && (
                  <p className={cn('text-[11px] font-medium', urgent ? 'text-red-600' : warning ? 'text-orange-500' : 'text-gray-400')}>
                    {days <= 0 ? 'Expiré' : `J-${days}`}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Budget Form Modal ─────────────────────────────────────────────────────────
interface FormState {
  name: string; vendor: string; category: BudgetCategory; amount: string
  currency: string; billingCycle: BillingCycle; contractStart: string; contractEnd: string
  autoRenewal: boolean; renewalAlertDays: string; billingEntity: BillingEntity | ''; notes: string
}

const EMPTY_FORM: FormState = {
  name: '', vendor: '', category: 'saas', amount: '',
  currency: 'EUR', billingCycle: 'annual', contractStart: '', contractEnd: '',
  autoRenewal: false, renewalAlertDays: '60', billingEntity: '', notes: '',
}

function itemToForm(item: BudgetItem): FormState {
  return {
    name: item.name,
    vendor: item.vendor ?? '',
    category: item.category,
    amount: item.amount,
    currency: item.currency,
    billingCycle: item.billingCycle,
    contractStart: item.contractStart ?? '',
    contractEnd: item.contractEnd ?? '',
    autoRenewal: item.autoRenewal === 1,
    renewalAlertDays: String(item.renewalAlertDays),
    billingEntity: item.billingEntity ?? '',
    notes: item.notes ?? '',
  }
}

function formToInput(f: FormState): BudgetItemInput {
  return {
    name: f.name,
    vendor: f.vendor || null,
    category: f.category,
    amount: f.amount,
    currency: f.currency,
    billingCycle: f.billingCycle,
    contractStart: f.contractStart || null,
    contractEnd: f.contractEnd || null,
    autoRenewal: f.autoRenewal ? 1 : 0,
    renewalAlertDays: Number(f.renewalAlertDays),
    billingEntity: (f.billingEntity || null) as BillingEntity | null,
    notes: f.notes || null,
  }
}

function BudgetForm({ item, onClose }: { item?: BudgetItem; onClose: () => void }) {
  const [form, setForm] = useState<FormState>(item ? itemToForm(item) : EMPTY_FORM)
  const { mutate: create, isPending: creating } = useCreateBudgetItem()
  const { mutate: update, isPending: updating } = useUpdateBudgetItem()
  const pending = creating || updating

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(f => ({ ...f, [k]: v }))

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const input = formToInput(form)
    if (item) {
      update({ id: item.id, data: input }, { onSuccess: onClose })
    } else {
      create(input, { onSuccess: onClose })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
      <div className="w-full max-h-[90vh] overflow-y-auto rounded-t-2xl bg-white sm:max-w-xl sm:rounded-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b bg-white px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900">
            {item ? 'Modifier la ligne' : 'Nouvelle ligne budget'}
          </h2>
          <button onClick={onClose} className="rounded-md p-1 text-gray-400 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          {/* Nom */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Nom du contrat / service *</label>
            <input
              required
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="Ex: Microsoft 365 E3"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>

          {/* Fournisseur + Catégorie */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Fournisseur</label>
              <input
                value={form.vendor}
                onChange={e => set('vendor', e.target.value)}
                placeholder="Microsoft, AWS..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Catégorie</label>
              <select
                value={form.category}
                onChange={e => set('category', e.target.value as BudgetCategory)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              >
                {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Entité de facturation */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Entité de facturation</label>
            <select
              value={form.billingEntity}
              onChange={e => set('billingEntity', e.target.value as BillingEntity | '')}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            >
              <option value="">— Non défini —</option>
              {BILLING_ENTITIES.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>

          {/* Montant + Fréquence */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Montant (€) *</label>
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={e => set('amount', e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Fréquence</label>
              <select
                value={form.billingCycle}
                onChange={e => set('billingCycle', e.target.value as BillingCycle)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              >
                {Object.entries(BILLING_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Dates contrat */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Début du contrat</label>
              <input
                type="date"
                value={form.contractStart}
                onChange={e => set('contractStart', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Fin du contrat</label>
              <input
                type="date"
                value={form.contractEnd}
                onChange={e => set('contractEnd', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
            </div>
          </div>

          {/* Renouvellement auto */}
          <div className="flex items-center gap-3 rounded-lg bg-gray-50 p-3">
            <input
              type="checkbox"
              id="autoRenewal"
              checked={form.autoRenewal}
              onChange={e => set('autoRenewal', e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-primary-600"
            />
            <label htmlFor="autoRenewal" className="flex-1 text-sm text-gray-700">Renouvellement automatique</label>
            {form.autoRenewal && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">Alerte</span>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={form.renewalAlertDays}
                  onChange={e => set('renewalAlertDays', e.target.value)}
                  className="w-16 rounded border border-gray-300 px-2 py-1 text-xs"
                />
                <span className="text-xs text-gray-500">j avant</span>
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              rows={2}
              placeholder="Référence contrat, contact fournisseur..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
              Annuler
            </button>
            <button type="submit" disabled={pending} className="flex-1 rounded-lg bg-primary-600 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50">
              {pending ? 'Enregistrement…' : item ? 'Mettre à jour' : 'Ajouter'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Items table ───────────────────────────────────────────────────────────────
function ItemsTable({ items, onEdit }: { items: BudgetItem[]; onEdit: (item: BudgetItem) => void }) {
  const { mutate: del } = useDeleteBudgetItem()

  if (!items.length) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center">
        <p className="text-sm text-gray-400">Aucune ligne budget. Ajoutez votre première ligne.</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
            <th className="px-4 py-3 text-left">Contrat / Service</th>
            <th className="px-4 py-3 text-left">Entité</th>
            <th className="px-4 py-3 text-left">Catégorie</th>
            <th className="px-4 py-3 text-right">Montant</th>
            <th className="px-4 py-3 text-right">Annualisé</th>
            <th className="px-4 py-3 text-left">Fin contrat</th>
            <th className="px-4 py-3 text-left">Statut</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {items.map(item => {
            const catCfg = CATEGORY_CONFIG[item.category] ?? CATEGORY_CONFIG.other
            const statusCfg = STATUS_CONFIG[item.status]
            const StatusIcon = statusCfg.icon
            const days = daysUntil(item.contractEnd)
            return (
              <tr key={item.id} className="hover:bg-gray-50/50">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900">{item.name}</p>
                  {item.vendor && <p className="text-xs text-gray-400">{item.vendor}</p>}
                </td>
                <td className="px-4 py-3">
                  {item.billingEntity
                    ? <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700">{item.billingEntity}</span>
                    : <span className="text-gray-300">—</span>
                  }
                </td>
                <td className="px-4 py-3">
                  <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium', catCfg.color)}>
                    <catCfg.icon className="h-3 w-3" />
                    {catCfg.label}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-gray-700">
                  {formatEur(Number(item.amount))}
                  <span className="ml-1 text-[10px] text-gray-400">/ {BILLING_LABELS[item.billingCycle]}</span>
                </td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">
                  {formatEur(toAnnual(item))}
                </td>
                <td className="px-4 py-3">
                  <p className="text-gray-700">{formatDate(item.contractEnd)}</p>
                  {days !== null && days >= 0 && days <= 90 && (
                    <p className={cn('text-[11px] font-medium', days <= 30 ? 'text-red-600' : 'text-orange-500')}>
                      J-{days}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', statusCfg.color)}>
                    <StatusIcon className="h-3 w-3" />
                    {statusCfg.label}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => onEdit(item)} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => { if (confirm(`Supprimer "${item.name}" ?`)) del(item.id) }}
                      className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
type Tab = 'overview' | 'contracts'

export default function BudgetPage() {
  const canRead = usePermission('budget:read')
  const canWrite = usePermission('budget:write')
  const [tab, setTab] = useState<Tab>('overview')
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterEntity, setFilterEntity] = useState('')
  const [editItem, setEditItem] = useState<BudgetItem | null | 'new'>(null)

  const { data: stats } = useBudgetStats()
  const { data: itemsData } = useBudgetItems(
    search || filterCat || filterStatus || filterEntity
      ? { q: search || undefined, category: filterCat || undefined, status: filterStatus || undefined, entity: filterEntity || undefined }
      : undefined
  )
  const { data: allItemsData } = useBudgetItems()
  const items = itemsData?.items ?? []
  const allItems = allItemsData?.items ?? []

  if (!canRead) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
        <p className="text-4xl">🔒</p>
        <h1 className="text-xl font-semibold text-gray-900">Accès restreint</h1>
        <p className="max-w-sm text-sm text-gray-500">Ce module est réservé aux administrateurs DSI.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Budget & Facturation</h1>
          <p className="mt-1 text-sm text-gray-500">Gestion du budget IT — contrats, dépenses et échéances</p>
        </div>
        {canWrite && (
          <button
            onClick={() => setEditItem('new')}
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
          >
            <Plus className="h-4 w-4" />
            Ajouter
          </button>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="Budget annuel total"
          value={stats ? formatEur(stats.totalAnnual) : '—'}
          sub={stats ? `≈ ${formatEur(stats.totalMonthly)} / mois` : undefined}
          icon={Euro}
          accent="bg-primary-50 text-primary-600"
        />
        <StatCard
          label="Contrats actifs"
          value={stats ? String(stats.activeCount) : '—'}
          icon={CheckCircle2}
          accent="bg-green-50 text-green-600"
        />
        <StatCard
          label="Expirent dans 90j"
          value={stats ? String(stats.expiringSoonCount) : '—'}
          sub={stats?.expiring30Count ? `dont ${stats.expiring30Count} dans 30j` : undefined}
          icon={AlertTriangle}
          accent={stats?.expiring30Count ? 'bg-red-50 text-red-600' : 'bg-orange-50 text-orange-600'}
        />
        <StatCard
          label="Expirés / annulés"
          value={stats ? String(stats.expiredCount) : '—'}
          icon={Clock}
          accent="bg-gray-100 text-gray-500"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1 w-fit">
        {(['overview', 'contracts'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
              tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            )}
          >
            {t === 'overview' ? 'Vue d\'ensemble' : 'Contrats'}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {stats && <CategoryChart byCategory={stats.byCategory} />}
          <ExpiryTimeline items={allItems} />
        </div>
      )}

      {/* Contracts tab */}
      {tab === 'contracts' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Rechercher un contrat..."
                className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
            </div>
            <select
              value={filterCat}
              onChange={e => setFilterCat(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
            >
              <option value="">Toutes catégories</option>
              {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
            >
              <option value="">Tous statuts</option>
              {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <select
              value={filterEntity}
              onChange={e => setFilterEntity(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
            >
              <option value="">Toutes entités</option>
              {BILLING_ENTITIES.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>

          {/* Table */}
          <ItemsTable items={items} onEdit={item => setEditItem(item)} />

          {/* Total ligne */}
          {items.length > 0 && (
            <div className="flex justify-end">
              <p className="text-sm text-gray-500">
                <span className="font-medium text-gray-900">{items.length}</span> ligne{items.length > 1 ? 's' : ''} —
                total annualisé : <span className="font-semibold text-primary-700">
                  {formatEur(items.reduce((s, i) => s + toAnnual(i), 0))}
                </span>
              </p>
            </div>
          )}
        </div>
      )}

      {/* Modal form */}
      {editItem !== null && (
        <BudgetForm
          item={editItem === 'new' ? undefined : editItem}
          onClose={() => setEditItem(null)}
        />
      )}
    </div>
  )
}
