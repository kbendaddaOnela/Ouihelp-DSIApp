import { useRef, useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Upload, CheckCircle2, Clock, Users, RefreshCw, RotateCcw, ArrowUp, ArrowDown, BookUser, KeyRound, Cloud } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMigrationStats, useImportTargets, useResetDone } from '../hooks/useMigration'
import { onelaContactsApi, migrationApi } from '../api'
import type { MigrationStats } from '../api'

// ── Override local (groupes terminés non encore reflétés dans la base) ────────
const DONE_OVERRIDES: Record<string, number> = {
  dsi: 5,
  formation: 3,
}

type SortKey = 'label' | 'total' | 'done' | 'in_progress'
type SortDir = 'asc' | 'desc'

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
type NormalizedRow = { label: string; total: number; done: number; in_progress: number }

function applyOverrides(rows: NormalizedRow[]): NormalizedRow[] {
  return rows.map((r) => {
    const key = r.label.trim().toLowerCase()
    const override = DONE_OVERRIDES[key]
    if (override != null) {
      const done = Math.min(override, r.total)
      return { ...r, done, in_progress: Math.max(0, r.in_progress - Math.max(0, done - r.done)) }
    }
    return r
  })
}

function SortHeader({
  label,
  active,
  dir,
  align = 'left',
  onClick,
}: {
  label: string
  active: boolean
  dir: SortDir
  align?: 'left' | 'right'
  onClick: () => void
}) {
  return (
    <th
      className={cn('px-3 py-2', align === 'right' && 'text-right')}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 select-none transition-colors',
          align === 'right' && 'flex-row-reverse',
          active ? 'text-gray-800' : 'text-gray-500 hover:text-gray-700'
        )}
      >
        <span>{label}</span>
        {active &&
          (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  )
}

function GroupTable({ rows }: { rows: MigrationStats['byDept'] | MigrationStats['byOffice'] }) {
  const [sortKey, setSortKey] = useState<SortKey>('done')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const normalized: NormalizedRow[] = useMemo(
    () =>
      applyOverrides(
        rows.map((r) => ({
          label: 'department' in r ? r.department : r.office,
          total: r.total,
          done: r.done,
          in_progress: r.in_progress,
        }))
      ),
    [rows]
  )

  const sorted = useMemo(() => {
    const arr = [...normalized]
    arr.sort((a, b) => {
      let diff: number
      if (sortKey === 'label') diff = a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' })
      else diff = (a[sortKey] as number) - (b[sortKey] as number)
      return sortDir === 'asc' ? diff : -diff
    })
    return arr
  }, [normalized, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'label' ? 'asc' : 'desc')
    }
  }

  if (!rows.length) return <p className="text-xs text-gray-400">Aucune donnée.</p>
  return (
    <div className="overflow-hidden rounded-lg border border-gray-100">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 text-left text-[11px] font-medium uppercase tracking-wide">
            <SortHeader label="Groupe" active={sortKey === 'label'} dir={sortDir} onClick={() => toggleSort('label')} />
            <SortHeader label="Total" active={sortKey === 'total'} dir={sortDir} align="right" onClick={() => toggleSort('total')} />
            <SortHeader label="Terminés" active={sortKey === 'done'} dir={sortDir} align="right" onClick={() => toggleSort('done')} />
            <SortHeader label="En cours" active={sortKey === 'in_progress'} dir={sortDir} align="right" onClick={() => toggleSort('in_progress')} />
            <th className="px-3 py-2 text-gray-500">Progression</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0
            return (
              <tr key={r.label} className="border-b border-gray-50 last:border-b-0 hover:bg-gray-50">
                <td className="max-w-[160px] truncate px-3 py-2 font-medium text-gray-800">{r.label}</td>
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
  const { data: live, isFetching: liveFetching, refetch: refetchLive } = useQuery({
    queryKey: ['live-stats'],
    queryFn: migrationApi.liveStats,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const { mutate: importCSV, isPending: isImporting, data: importResult, reset: resetImport } = useImportTargets()
  const { mutate: resetDone, isPending: isResetting } = useResetDone()
  const fileRef = useRef<HTMLInputElement>(null)
  const onelaFileRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<'dept' | 'office'>('dept')
  const [onelaImportMsg, setOnelaImportMsg] = useState<string | null>(null)
  const [isImportingOnela, setIsImportingOnela] = useState(false)

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

  function handleOnelaFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const csv = ev.target?.result as string
      setIsImportingOnela(true)
      setOnelaImportMsg(null)
      try {
        const res = await onelaContactsApi.importCSV(csv)
        setOnelaImportMsg(
          `Annuaire ONELA importé — ${res.imported} contacts (${res.inserted} ajoutés, ${res.updated} mis à jour, ${res.excluded} comptes techniques exclus).`
        )
      } catch (err: unknown) {
        const apiErr = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        setOnelaImportMsg(`Erreur : ${apiErr || (err instanceof Error ? err.message : String(err))}`)
      } finally {
        setIsImportingOnela(false)
      }
    }
    reader.readAsText(file, 'UTF-8')
    e.target.value = ''
  }

  // Bonus "done" à ajouter aux totaux globaux pour refléter les overrides de département
  const overrideDelta = useMemo(() => {
    if (!stats) return 0
    let delta = 0
    for (const r of stats.byDept) {
      const key = r.department.trim().toLowerCase()
      const ov = DONE_OVERRIDES[key]
      if (ov != null) delta += Math.max(0, Math.min(ov, r.total) - r.done)
    }
    return delta
  }, [stats])

  const t = stats?.totals
  const csvDone = t ? Math.min(t.total, t.done + overrideDelta) : 0
  const csvInProgress = t ? t.in_progress : 0

  // Source de vérité : les tenants (live) quand disponibles, sinon repli sur le CSV.
  const total = live?.onelaTotal ?? (t?.total ?? 0)
  const done = live?.googleMigrated ?? csvDone
  const inProgress = live?.activeMigrations ?? csvInProgress
  const donePct = total > 0 ? Math.round((done / total) * 100) : 0
  const remaining = Math.max(0, total - done)

  // Cartes affichées (compatibilité avec le rendu existant)
  const adjustedDone = done
  const adjustedInProgress = inProgress
  const totalLabel = total

  const totalIsLive = live?.onelaTotal != null
  const doneIsLive = live?.googleMigrated != null
  const activeIsLive = live?.activeMigrations != null

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
            onClick={() => { refetch(); refetchLive() }}
            disabled={isFetching || liveFetching}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', (isFetching || liveFetching) && 'animate-spin')} />
            Actualiser
          </button>
          <button
            onClick={() => {
              if (window.confirm('Remettre tous les compteurs à zéro (done + in_progress → pending) ?'))
                resetDone()
            }}
            disabled={isResetting}
            className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-60"
          >
            <RotateCcw className={cn('h-3 w-3', isResetting && 'animate-spin')} />
            {isResetting ? 'Réinitialisation…' : 'Réinitialiser compteurs'}
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
          <button
            onClick={() => { setOnelaImportMsg(null); onelaFileRef.current?.click() }}
            disabled={isImportingOnela}
            className="flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-60"
            title="Importer le CSV de l'annuaire ONELA (contacts partagés poussés ensuite à chaque user)"
          >
            <BookUser className="h-3 w-3" />
            {isImportingOnela ? 'Import…' : 'Importer annuaire ONELA'}
          </button>
          <input ref={onelaFileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleOnelaFile} />
        </div>
      </div>

      {/* Message après import */}
      {importResult && (
        <p className="mt-2 text-xs text-emerald-600">
          Import OK — {importResult.imported} lignes ({importResult.inserted} ajoutées, {importResult.updated} mises à jour)
        </p>
      )}
      {onelaImportMsg && (
        <p className={cn('mt-2 text-xs', onelaImportMsg.startsWith('Erreur') ? 'text-red-600' : 'text-sky-600')}>
          {onelaImportMsg}
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
          {/* Résumé licences Google disponibles */}
          {live?.licenses && (
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs">
              <span className="flex items-center gap-1 font-medium text-indigo-700">
                <KeyRound className="h-3.5 w-3.5" /> Licences dispo :
              </span>
              <span className={cn('font-semibold', live.licenses.totalRemaining <= 0 ? 'text-red-600' : 'text-indigo-700')}>
                {live.licenses.totalRemaining} restantes
              </span>
              <span className="text-indigo-400">·</span>
              <span className="text-gray-500">{live.licenses.totalUsed}/{live.licenses.totalSeats} utilisées</span>
              {live.licenses.perSku.length > 0 && (
                <span className="ml-auto flex flex-wrap gap-x-3 gap-y-0.5 text-gray-500">
                  {live.licenses.perSku.map((s) => (
                    <span key={s.skuId} title={`${s.used}/${s.total} utilisées`}>
                      {s.name} : <span className={cn('font-medium', s.remaining <= 0 ? 'text-red-600' : 'text-indigo-600')}>{s.remaining}</span>
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}

          {/* Chiffres globaux */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-gray-50 p-3 text-center">
              <p className="text-2xl font-bold text-gray-900">{totalLabel}</p>
              <p className="mt-0.5 flex items-center justify-center gap-1 text-xs text-gray-500">
                Total cibles {totalIsLive && <Cloud className="h-3 w-3 text-sky-500" aria-label="live ONELA" />}
              </p>
            </div>
            <div className="rounded-lg bg-emerald-50 p-3 text-center">
              <p className="text-2xl font-bold text-emerald-600">{adjustedDone}</p>
              <p className="mt-0.5 flex items-center justify-center gap-1 text-xs text-gray-500">
                {doneIsLive ? 'Déjà migrés' : 'Terminés'} {doneIsLive && <Cloud className="h-3 w-3 text-sky-500" aria-label="live Google" />}
              </p>
            </div>
            <div className="rounded-lg bg-blue-50 p-3 text-center">
              <p className="text-2xl font-bold text-blue-600">{adjustedInProgress}</p>
              <p className="mt-0.5 flex items-center justify-center gap-1 text-xs text-gray-500">
                En cours {activeIsLive && <Cloud className="h-3 w-3 text-sky-500" aria-label="migrations actives réelles" />}
              </p>
            </div>
            <div className="rounded-lg bg-amber-50 p-3 text-center">
              <p className="text-2xl font-bold text-amber-600">{remaining}</p>
              <p className="mt-0.5 text-xs text-gray-500">Restants</p>
            </div>
          </div>

          {live && live.errors.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-600">
              Certaines valeurs viennent du CSV (live indisponible) — {live.errors.join(' · ')}
            </p>
          )}

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
            <ProgressBar done={adjustedDone} in_progress={adjustedInProgress} total={totalLabel} />
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
