import { Fragment, useMemo, useState } from 'react'
import { Laptop, Info, RefreshCw, Search, Download, AlertTriangle, ChevronDown, ChevronRight, Lock, LockOpen } from 'lucide-react'
import type { DeviceJoinType, DeviceMigrationRecord, DeviceMigrationState } from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import { usePermission } from '@/hooks/usePermission'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useDeviceMigrations, useDeviceSyncState, useStartDeviceSync, useUpdateDeviceMigration } from './hooks'

const inputCls =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500'

const STATE_CFG: Record<DeviceMigrationState, { label: string; cls: string }> = {
  to_migrate: { label: 'À migrer', cls: 'bg-blue-50 text-blue-700' },
  migrated: { label: 'Chez Ouihelp', cls: 'bg-emerald-50 text-emerald-700' },
  stale: { label: 'Inactif > 90 j', cls: 'bg-amber-50 text-amber-700' },
  excluded: { label: 'Exclu', cls: 'bg-gray-100 text-gray-500' },
  gone: { label: 'Disparu d’ONELA', cls: 'bg-purple-50 text-purple-700' },
}

const JOIN_CFG: Record<DeviceJoinType, { label: string; hint: string }> = {
  entra_joined: { label: 'Entra Joined', hint: 'Joint à Entra ONELA (Intune / Autopilot)' },
  hybrid: { label: 'Hybride', hint: 'Joint à l’AD local ONELA + synchronisé dans Entra' },
  registered: { label: 'Registered', hint: 'Entra registered seul (AD local ou workgroup)' },
  unknown: { label: 'Inconnu', hint: 'Vu par Intune / Autopilot sans objet Entra' },
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function fmtDateTime(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

// ── Export CSV (séparateur « ; » pour Excel FR) ──────────────────────────────
function exportCsv(devices: DeviceMigrationRecord[]) {
  const cols: Array<[string, (d: DeviceMigrationRecord) => string | number | null]> = [
    ['Nom', (d) => d.displayName],
    ['N° de série', (d) => d.serialNumber],
    ['Fabricant', (d) => d.manufacturer],
    ['Modèle', (d) => d.model],
    ['Version OS', (d) => d.osVersion],
    ['Jonction', (d) => JOIN_CFG[d.joinType].label],
    ['État', (d) => STATE_CFG[d.state].label],
    ['Utilisateur ONELA', (d) => d.onelaUserUpn],
    ['Agence', (d) => d.onelaOfficeLocation],
    ['Région', (d) => d.region],
    ['Dernière activité', (d) => fmtDate(d.lastActivityAt)],
    ['Intune ONELA', (d) => (d.onelaIntuneId ? 'oui' : 'non')],
    ['Autopilot ONELA', (d) => (d.onelaAutopilotId ? 'oui' : 'non')],
    ['Chiffré', (d) => (d.isEncrypted == null ? '' : d.isEncrypted ? 'oui' : 'non')],
    ['Clés BitLocker ONELA', (d) => d.bitlockerKeysOnela],
    ['Disque libre (Go)', (d) => d.freeStorageGb],
    ['Intune Ouihelp', (d) => (d.ouihelpIntuneId ? 'oui' : 'non')],
    ['Motif exclusion', (d) => d.excludeReason],
  ]
  const esc = (v: string | number | null) => {
    const s = v == null ? '' : String(v)
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [cols.map(([h]) => h).join(';'), ...devices.map((d) => cols.map(([, f]) => esc(f(d))).join(';'))]
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `postes-onela-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

// ── Synthèse ─────────────────────────────────────────────────────────────────
function Tile({ label, value, sub, onClick, active }: { label: string; value: number; sub?: string; onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border bg-white p-3 text-left transition-colors hover:border-primary-300',
        active ? 'border-primary-500 ring-1 ring-primary-500' : 'border-gray-200',
      )}
    >
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-semibold tabular-nums text-gray-900">{value}</div>
      {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
    </button>
  )
}

// ── Détail d'un poste ────────────────────────────────────────────────────────
function DeviceDetail({ d, canWrite }: { d: DeviceMigrationRecord; canWrite: boolean }) {
  const update = useUpdateDeviceMigration()
  const [reason, setReason] = useState(d.excludeReason ?? '')

  return (
    <div className="grid gap-4 bg-gray-50 px-4 py-3 text-xs lg:grid-cols-3">
      <div className="space-y-1">
        <div className="font-semibold text-gray-700">ONELA</div>
        <div><span className="text-gray-400">Intune :</span> {d.onelaIntuneId ? `${d.onelaManagementAgent ?? '?'} · synchro ${fmtDateTime(d.onelaIntuneLastSync)}` : 'non inscrit'}</div>
        <div><span className="text-gray-400">Autopilot :</span> {d.onelaAutopilotId ? `oui${d.onelaAutopilotGroupTag ? ` (tag ${d.onelaAutopilotGroupTag})` : ''}` : 'non'}</div>
        <div><span className="text-gray-400">Service :</span> {d.onelaDepartment ?? '—'}</div>
        <div><span className="text-gray-400">Disque :</span> {d.freeStorageGb != null ? `${d.freeStorageGb} Go libres / ${d.totalStorageGb ?? '?'} Go` : '—'}</div>
        <div><span className="text-gray-400">Clés BitLocker séquestrées :</span> {d.bitlockerKeysOnela ?? 'non lu'}</div>
      </div>
      <div className="space-y-1">
        <div className="font-semibold text-gray-700">Objets Entra ONELA ({d.onelaEntraObjects.length})</div>
        {d.onelaEntraObjects.length === 0 ? (
          <div className="text-gray-400">Aucun</div>
        ) : (
          d.onelaEntraObjects.map((o) => (
            <div key={o.objectId} className="font-mono text-[11px] text-gray-600">
              {o.trustType ?? '?'} · {o.deviceId.slice(0, 8)}… · {o.accountEnabled ? 'actif' : 'désactivé'} · vu {fmtDate(o.approximateLastSignInDateTime)}
            </div>
          ))
        )}
        <div className="pt-2 font-semibold text-gray-700">Ouihelp</div>
        <div><span className="text-gray-400">Intune :</span> {d.ouihelpIntuneId ? `oui · ${d.ouihelpUserUpn ?? 'sans utilisateur'} · synchro ${fmtDateTime(d.ouihelpLastSync)}` : 'non'}</div>
        <div><span className="text-gray-400">Autopilot :</span> {d.ouihelpAutopilotId ? 'oui' : 'non'}</div>
      </div>
      <div className="space-y-2">
        <div className="font-semibold text-gray-700">Périmètre</div>
        <div className="text-gray-400">Vu pour la 1ʳᵉ fois le {fmtDate(d.firstSeenAt)}, dernière fois le {fmtDate(d.lastSeenAt)}.</div>
        {canWrite && (
          d.excluded ? (
            <div className="space-y-1">
              <div className="text-gray-600">Exclu : {d.excludeReason ?? 'sans motif'}</div>
              <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: d.id, excluded: false })}>
                Réintégrer dans le périmètre
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                className={cn(inputCls, 'min-w-0 flex-1 text-xs')}
                placeholder="Motif (rebut, prêt, hors périmètre…)"
                value={reason}
                maxLength={255}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: d.id, excluded: true, excludeReason: reason })}>
                Exclure
              </Button>
            </div>
          )
        )}
        {update.error && <p className="text-red-600">{(update.error as Error).message}</p>}
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function DeviceMigrationPage() {
  const canWrite = usePermission('migration:write')
  const { data, isLoading, error } = useDeviceMigrations()
  const { data: syncData } = useDeviceSyncState()
  const startSync = useStartDeviceSync()

  const [q, setQ] = useState('')
  const [state, setState] = useState<DeviceMigrationState | ''>('')
  const [join, setJoin] = useState<DeviceJoinType | ''>('')
  const [region, setRegion] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const sync = syncData?.sync ?? data?.sync
  const lastSyncAt = syncData?.lastSyncAt ?? data?.lastSyncAt ?? null
  const devices = data?.devices ?? []

  const regions = useMemo(
    () => [...new Set(devices.map((d) => d.region).filter((r): r is string => !!r))].sort(),
    [devices],
  )

  const counts = useMemo(() => {
    const byState: Record<DeviceMigrationState, number> = { to_migrate: 0, migrated: 0, stale: 0, excluded: 0, gone: 0 }
    const byJoin: Record<DeviceJoinType, number> = { entra_joined: 0, hybrid: 0, registered: 0, unknown: 0 }
    for (const d of devices) {
      byState[d.state]++
      if (d.state === 'to_migrate') byJoin[d.joinType]++
    }
    return { byState, byJoin }
  }, [devices])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return devices.filter(
      (d) =>
        (!state || d.state === state) &&
        (!join || d.joinType === join) &&
        (!region || d.region === region) &&
        (!needle ||
          [d.displayName, d.serialNumber, d.onelaUserUpn, d.onelaUserName, d.onelaOfficeLocation, d.model]
            .some((v) => v?.toLowerCase().includes(needle))),
    )
  }, [devices, q, state, join, region])

  return (
    <div className="mx-auto max-w-7xl space-y-5 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50">
            <Laptop className="h-5 w-5 text-primary-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Migration des postes</h1>
            <p className="text-sm text-gray-500">PC ONELA → tenant Ouihelp (Entra + Intune) avant l’arrêt du tenant ONELA au 31/12</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">
            {sync?.running ? `Synchro : ${sync.step ?? '…'}` : `Dernière synchro : ${fmtDateTime(lastSyncAt)}`}
          </span>
          {canWrite && (
            <Button size="sm" onClick={() => startSync.mutate()} disabled={sync?.running || startSync.isPending}>
              <RefreshCw className={cn('mr-1.5 h-4 w-4', sync?.running && 'animate-spin')} />
              Synchroniser
            </Button>
          )}
        </div>
      </div>

      <div className="flex gap-2 rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-xs text-blue-900">
        <Info className="h-4 w-4 shrink-0 text-blue-500" />
        <p>
          Lot 1 — inventaire en lecture seule : objets Entra, Intune et Autopilot ONELA, rapprochés par n° de série avec
          Intune / Autopilot Ouihelp. Les PC <strong>uniquement dans l’AD local</strong> (sans objet Entra) n’apparaissent
          pas ici : ils remonteront avec l’agent de migration (lot 2).
        </p>
      </div>

      {(sync?.error || (sync?.warnings.length ?? 0) > 0) && (
        <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            {sync?.error ? `Dernière synchro en échec : ${sync.error}` : 'Synchro partielle — sources non lues :'}
          </div>
          {sync?.warnings.map((w) => <div key={w} className="break-all pl-6">{w}</div>)}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{(error as Error).message}</div>
      ) : devices.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
          Aucun poste en base. Lancez une première synchronisation.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Tile
              label="À migrer"
              value={counts.byState.to_migrate}
              sub={`${counts.byJoin.entra_joined} joined · ${counts.byJoin.hybrid} hybrides · ${counts.byJoin.registered + counts.byJoin.unknown} autres`}
              active={state === 'to_migrate'}
              onClick={() => setState(state === 'to_migrate' ? '' : 'to_migrate')}
            />
            <Tile label="Chez Ouihelp" value={counts.byState.migrated} active={state === 'migrated'} onClick={() => setState(state === 'migrated' ? '' : 'migrated')} />
            <Tile label="Inactifs > 90 j" value={counts.byState.stale} sub="à nettoyer plutôt qu’à migrer" active={state === 'stale'} onClick={() => setState(state === 'stale' ? '' : 'stale')} />
            <Tile label="Exclus" value={counts.byState.excluded} active={state === 'excluded'} onClick={() => setState(state === 'excluded' ? '' : 'excluded')} />
            <Tile label="Disparus d’ONELA" value={counts.byState.gone} sub="absents de la dernière synchro" active={state === 'gone'} onClick={() => setState(state === 'gone' ? '' : 'gone')} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[16rem] flex-1">
              <Search className="absolute left-2.5 top-2 h-4 w-4 text-gray-400" />
              <input className={cn(inputCls, 'w-full pl-8')} placeholder="Nom, n° de série, utilisateur, agence, modèle…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select className={inputCls} value={join} onChange={(e) => setJoin(e.target.value as DeviceJoinType | '')}>
              <option value="">Toutes jonctions</option>
              {(Object.keys(JOIN_CFG) as DeviceJoinType[]).map((k) => <option key={k} value={k}>{JOIN_CFG[k].label}</option>)}
            </select>
            <select className={inputCls} value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">Toutes régions</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Button size="sm" variant="outline" onClick={() => exportCsv(filtered)}>
              <Download className="mr-1.5 h-4 w-4" /> CSV ({filtered.length})
            </Button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="w-6 px-2 py-2" />
                  <th className="px-3 py-2 font-medium">Poste</th>
                  <th className="px-3 py-2 font-medium">Jonction</th>
                  <th className="px-3 py-2 font-medium">Utilisateur ONELA</th>
                  <th className="px-3 py-2 font-medium">Agence</th>
                  <th className="px-3 py-2 font-medium">Activité</th>
                  <th className="px-3 py-2 font-medium" title="Chiffrement BitLocker / clés séquestrées dans Entra ONELA">BitLocker</th>
                  <th className="px-3 py-2 font-medium">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((d) => (
                  <Fragment key={d.id}>
                    <tr className="cursor-pointer align-top hover:bg-gray-50" onClick={() => setOpen(open === d.id ? null : d.id)}>
                      <td className="px-2 py-2 text-gray-400">
                        {open === d.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900">{d.displayName ?? '—'}</div>
                        <div className="text-[11px] text-gray-400">
                          {[d.manufacturer, d.model].filter(Boolean).join(' ') || '—'}
                          {d.serialNumber && <span className="ml-1 font-mono">· {d.serialNumber}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2" title={JOIN_CFG[d.joinType].hint}>
                        <div className="text-gray-700">{JOIN_CFG[d.joinType].label}</div>
                        <div className="text-[11px] text-gray-400">{d.onelaIntuneId ? 'Intune' : 'hors Intune'}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-gray-700">{d.onelaUserName ?? '—'}</div>
                        {d.onelaUserUpn && <div className="font-mono text-[11px] text-gray-400">{d.onelaUserUpn}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-gray-700">{d.onelaOfficeLocation ?? '—'}</div>
                        {d.region && <div className="text-[11px] text-gray-400">{d.region}</div>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-500">{fmtDate(d.lastActivityAt)}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {d.isEncrypted == null ? (
                          <span className="text-gray-300">—</span>
                        ) : d.isEncrypted ? (
                          <span className="inline-flex items-center gap-1 text-gray-700"><Lock className="h-3.5 w-3.5" />{d.bitlockerKeysOnela ?? '?'} clé(s)</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-gray-400"><LockOpen className="h-3.5 w-3.5" />non chiffré</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={cn('whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium', STATE_CFG[d.state].cls)}>
                          {STATE_CFG[d.state].label}
                        </span>
                      </td>
                    </tr>
                    {open === d.id && (
                      <tr>
                        <td colSpan={8} className="p-0">
                          <DeviceDetail key={d.id} d={d} canWrite={canWrite} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && <p className="py-8 text-center text-sm text-gray-400">Aucun poste ne correspond aux filtres.</p>}
          </div>
        </>
      )}
    </div>
  )
}
