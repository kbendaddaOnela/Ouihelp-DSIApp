import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Monitor, Search, RefreshCw, CheckCircle2, XCircle, AlertCircle, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDevices, useInventoryStats, useInventorySync } from './hooks'
import type { CachedDevice } from './api'

// ── Conformité ────────────────────────────────────────────────────────────────
const COMPLIANCE_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  compliant:       { label: 'Conforme',       color: 'text-emerald-600 bg-emerald-50', icon: CheckCircle2 },
  noncompliant:    { label: 'Non conforme',   color: 'text-red-600 bg-red-50',         icon: XCircle },
  inGracePeriod:   { label: 'Grâce',          color: 'text-amber-600 bg-amber-50',     icon: AlertCircle },
  unknown:         { label: 'Inconnu',         color: 'text-gray-500 bg-gray-100',      icon: HelpCircle },
  notApplicable:   { label: 'N/A',             color: 'text-gray-400 bg-gray-50',       icon: HelpCircle },
  configManager:   { label: 'Config Mgr',     color: 'text-blue-600 bg-blue-50',       icon: AlertCircle },
}

function ComplianceBadge({ state }: { state: string }) {
  const cfg = COMPLIANCE_CONFIG[state] ?? COMPLIANCE_CONFIG['unknown']
  const Icon = cfg.icon
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', cfg.color)}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  )
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

// ── Tableau devices ───────────────────────────────────────────────────────────
function DevicesTable({ devices }: { devices: CachedDevice[] }) {
  if (!devices.length) return <p className="py-12 text-center text-sm text-gray-400">Aucun appareil trouvé.</p>
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-medium uppercase tracking-wide text-gray-500">
            <th className="px-4 py-3">Appareil</th>
            <th className="px-4 py-3">Type / OS</th>
            <th className="px-4 py-3">Conformité</th>
            <th className="px-4 py-3">Utilisateur</th>
            <th className="px-4 py-3">Dernière synchro</th>
            <th className="px-4 py-3">Source</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
              <td className="px-4 py-3 font-medium text-gray-900">{d.deviceName ?? '—'}</td>
              <td className="px-4 py-3">
                <div className="text-gray-700">{d.deviceType ?? d.operatingSystem ?? '—'}</div>
                {d.osVersion && <div className="text-[10px] text-gray-400">{d.osVersion}</div>}
              </td>
              <td className="px-4 py-3"><ComplianceBadge state={d.complianceState} /></td>
              <td className="px-4 py-3">
                <div className="max-w-[180px] truncate text-gray-700">{d.userDisplayName ?? '—'}</div>
                {d.userPrincipalName && <div className="max-w-[180px] truncate text-[10px] text-gray-400">{d.userPrincipalName}</div>}
              </td>
              <td className="px-4 py-3 text-gray-500">{formatDate(d.lastSyncDateTime)}</td>
              <td className="px-4 py-3">
                <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', d.source === 'ouihelp' ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700')}>
                  {d.source}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Page principale ───────────────────────────────────────────────────────────
export default function InventoryPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = (searchParams.get('tab') ?? 'devices') as 'devices' | 'users'
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('')
  const [complianceFilter, setComplianceFilter] = useState<string>('')

  const { data: statsData } = useInventoryStats()
  const { mutate: triggerSync, isPending: isSyncing } = useInventorySync()

  const { data: devicesData, isFetching: isFetchingDevices } = useDevices(
    tab === 'devices' ? {
      source: sourceFilter as 'ouihelp' | 'onela' | undefined || undefined,
      compliance: complianceFilter || undefined,
      q: search || undefined,
      limit: 200,
    } : undefined
  )

  const devices = devicesData?.devices ?? []
  const lastSync = statsData?.status?.lastSyncAt ? new Date(statsData.status.lastSyncAt) : null
  const syncRunning = statsData?.status?.status === 'running' || isSyncing

  const deviceTotal = statsData?.deviceCounts.reduce((s, r) => s + Number(r.count), 0) ?? 0
  const compliantCount = statsData?.complianceCounts.filter((r) => r.complianceState === 'compliant').reduce((s, r) => s + Number(r.count), 0) ?? 0
  const noncompliantCount = statsData?.complianceCounts.filter((r) => r.complianceState === 'noncompliant').reduce((s, r) => s + Number(r.count), 0) ?? 0

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50">
            <Monitor className="h-5 w-5 text-primary-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Inventaire matériel</h1>
            {lastSync && <p className="text-xs text-gray-400">Sync {new Date(lastSync).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>}
          </div>
        </div>
        <button
          onClick={() => triggerSync()}
          disabled={syncRunning}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', syncRunning && 'animate-spin')} />
          {syncRunning ? 'Sync en cours…' : 'Synchroniser'}
        </button>
      </div>

      {/* Cartes résumé */}
      {deviceTotal > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-2xl font-bold text-gray-900">{deviceTotal}</p>
            <p className="mt-0.5 text-xs text-gray-500">Postes total</p>
            <div className="mt-2 flex gap-1.5">
              {statsData!.deviceCounts.map((r) => (
                <span key={r.source} className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', r.source === 'ouihelp' ? 'bg-blue-50 text-blue-700' : 'bg-purple-50 text-purple-700')}>
                  {r.source} {Number(r.count)}
                </span>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4">
            <p className="text-2xl font-bold text-emerald-700">{compliantCount}</p>
            <p className="mt-0.5 text-xs text-emerald-600">Conformes</p>
            <p className="mt-1 text-[10px] text-emerald-500">{deviceTotal > 0 ? Math.round((compliantCount / deviceTotal) * 100) : 0}%</p>
          </div>
          <div className="rounded-xl border border-red-100 bg-red-50 p-4">
            <p className="text-2xl font-bold text-red-700">{noncompliantCount}</p>
            <p className="mt-0.5 text-xs text-red-600">Non conformes</p>
            <p className="mt-1 text-[10px] text-red-500">{deviceTotal > 0 ? Math.round((noncompliantCount / deviceTotal) * 100) : 0}%</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200">
        {(['devices', 'users'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setSearchParams({ tab: t })}
            className={cn(
              'pb-3 text-sm font-medium transition-colors',
              tab === t ? 'border-b-2 border-primary-600 text-primary-700' : 'text-gray-500 hover:text-gray-700'
            )}
          >
            {t === 'devices' ? 'Appareils' : 'Utilisateurs'}
          </button>
        ))}
      </div>

      {tab === 'devices' && (
        <>
          {/* Filtres */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher un appareil…"
                className="w-full rounded-lg border border-gray-200 pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">Toutes les sources</option>
              <option value="ouihelp">Ouihelp</option>
              <option value="onela">ONELA</option>
            </select>
            <select
              value={complianceFilter}
              onChange={(e) => setComplianceFilter(e.target.value)}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">Toute conformité</option>
              <option value="compliant">Conforme</option>
              <option value="noncompliant">Non conforme</option>
              <option value="inGracePeriod">Grâce</option>
              <option value="unknown">Inconnu</option>
            </select>
          </div>

          {isFetchingDevices ? (
            <div className="py-12 text-center text-sm text-gray-400">Chargement…</div>
          ) : (
            <DevicesTable devices={devices} />
          )}
        </>
      )}

      {tab === 'users' && (
        <div className="py-12 text-center text-sm text-gray-400">
          Vue détaillée des utilisateurs — bientôt disponible.
        </div>
      )}

      {!statsData?.status?.lastSyncAt && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-700">
          Aucune donnée disponible. Cliquez sur <strong>Synchroniser</strong> pour récupérer les appareils depuis Intune.
        </div>
      )}
    </div>
  )
}
