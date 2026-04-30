import { useRef, useState } from 'react'
import { Upload, CheckCircle2, Clock, Users, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMigrationStats, useImportTargets } from '../hooks/useMigration'
import type { MigrationStats } from '../api'

// ── Barre de progression ──────────────────────────────────────────────────────
function ProgressBar({ done, in_progress, total }: { done: number; in_progress: number; total: number }) {
  if (total === 0) return <div className="h-2 w-full rounded-full bg-gray-100" />
  const donePct = Math.round((done / total) * 100)
  const inProgressPct = Math.round((in_progress / total) * 100)
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
      <div className="flex h-full">
        <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${donePct}%` }} />
        <div className="h-full bg-blue-400 transition-all duration-500" style={{ width: `${inProgressPct}%` }} />
      </div>
    </div>
  )
}

// ── Tableau dept / office ─────────────────────────────────────────────────────
function GroupTable({ rows }: { rows: MigrationStats['byDept'] | MigrationStats['byOffice'] }) {
  if (!rows.length) return <p className="text-xs text-gray-400">Aucune donnée.</p>
  return (
    <div className="overflow-hidden rounded-lg border border-gray-100">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 text-left text-[11px] font-medium uppercase tracking-wide text-gray-500">
            <th className="px-3 py-2">Groupe</th>
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2 text-right">Terminés</th>
            <th className="px-3 py-2 text-right">En cours</th>
            <th className="px-3 py-2">Progression</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const label = 'department' in r ? r.department : r.office
            const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0
            return (
              <tr key={label} className="border-b border-gray-50 last:border-b-0 hover:bg-gray-50">
                <td className="max-w-[160px] truncate px-3 py-2 font-medium text-gray-800">{label}</td>
                <td className="px-3 py-2 text-right text-gray-600">{r.total}</td>
                <td className="px-3 py-2 text-right text-emerald-600">{r.done}</td>
                <td className="px-3 py-2 text-right text-blue-500">{r.in_progress}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-100">
                      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[10px] text-gray-400">{pct}%</span>
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

// ── Composant principal ───────────────────────────────────────────────────────
export function MigrationDashboard() {
  const { data: stats, isFetching, refetch } = useMigrationStats()
  const { mutate: importCSV, isPending: isImporting, data: importResult, reset: resetImport } = useImportTargets()
  const fileRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<'dept' | 'office'>('dept')

  const hasData = stats && stats.totals.total > 0

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const csv = ev.target?.result as string
      importCSV(csv, {
        onError: (err) => alert(`Erreur import : ${err instanceof Error ? err.message : String(err)}`),
      })
    }
    reader.readAsText(file, 'UTF-8')
    e.target.value = ''
  }

  const t = stats?.totals
  const donePct = t && t.total > 0 ? Math.round((t.done / t.total) * 100) : 0
  const remaining = t ? t.total - t.done : 0

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary-600" />
          <h2 className="text-sm font-semibold text-gray-900">Suivi de la migration</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
            Actualiser
          </button>
          <button
            onClick={() => { resetImport(); fileRef.current?.click() }}
            disabled={isImporting}
            className="flex items-center gap-1.5 rounded-lg border border-primary-200 bg-primary-50 px-3 py-1.5 text-xs font-medium text-primary-700 hover:bg-primary-100 disabled:opacity-60"
          >
            <Upload className="h-3 w-3" />
            {isImporting ? 'Import…' : 'Importer CSV'}
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFile} />
        </div>
      </div>

      {/* Message après import */}
      {importResult && (
        <p className="mt-2 text-xs text-emerald-600">
          Import OK — {importResult.imported} lignes ({importResult.inserted} ajoutées, {importResult.updated} mises à jour)
        </p>
      )}

      {!hasData ? (
        <div className="mt-6 flex flex-col items-center gap-2 py-4 text-center text-sm text-gray-400">
          <Upload className="h-8 w-8 text-gray-200" />
          <p>Importez un CSV pour commencer le suivi.</p>
          <p className="text-xs">Colonnes attendues : <code className="rounded bg-gray-100 px-1">upn, displayName, department, office</code></p>
        </div>
      ) : (
        <>
          {/* Chiffres globaux */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-gray-50 p-3 text-center">
              <p className="text-2xl font-bold text-gray-900">{t!.total}</p>
              <p className="mt-0.5 text-xs text-gray-500">Total cibles</p>
            </div>
            <div className="rounded-lg bg-emerald-50 p-3 text-center">
              <p className="text-2xl font-bold text-emerald-600">{t!.done}</p>
              <p className="mt-0.5 text-xs text-gray-500">Terminés</p>
            </div>
            <div className="rounded-lg bg-blue-50 p-3 text-center">
              <p className="text-2xl font-bold text-blue-600">{t!.in_progress}</p>
              <p className="mt-0.5 text-xs text-gray-500">En cours</p>
            </div>
            <div className="rounded-lg bg-amber-50 p-3 text-center">
              <p className="text-2xl font-bold text-amber-600">{remaining}</p>
              <p className="mt-0.5 text-xs text-gray-500">Restants</p>
            </div>
          </div>

          {/* Barre globale */}
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                {donePct}% terminé
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3 text-gray-400" />
                {remaining} restants
              </span>
            </div>
            <ProgressBar done={t!.done} in_progress={t!.in_progress} total={t!.total} />
            <div className="mt-1 flex gap-3 text-[10px] text-gray-400">
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />Terminés</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-blue-400" />En cours</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-gray-200" />En attente</span>
            </div>
          </div>

          {/* Tabs dept / office */}
          <div className="mt-5">
            <div className="mb-3 flex gap-2 border-b border-gray-100">
              {(['dept', 'office'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'pb-2 text-xs font-medium transition-colors',
                    tab === t
                      ? 'border-b-2 border-primary-600 text-primary-700'
                      : 'text-gray-500 hover:text-gray-700'
                  )}
                >
                  {t === 'dept' ? 'Par département' : 'Par bureau / site'}
                </button>
              ))}
            </div>
            {tab === 'dept'
              ? <GroupTable rows={stats.byDept} />
              : <GroupTable rows={stats.byOffice} />
            }
          </div>
        </>
      )}
    </section>
  )
}
