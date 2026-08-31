import { useMemo, useState } from 'react'
import {
  Building2,
  Search,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  PlayCircle,
  CheckSquare,
  Square,
  BarChart3,
  Info,
} from 'lucide-react'
import type { CreateXimiMigrationRequest, XimiSourceSite } from '@dsi-app/shared'
import {
  useXimiHistory,
  useArchivedXimiMigrations,
  useXimiSourceSites,
  useCreateXimiMigrations,
  useRunAllXimiMigrations,
} from './hooks/useXimiMigration'
import { XimiMigrationCard } from './components/XimiMigrationCard'
import { XimiMappingTable } from './components/XimiMappingTable'

export default function XimiMigrationPage() {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [analyzeOnly, setAnalyzeOnly] = useState(false)
  const [mappingOpen, setMappingOpen] = useState(true)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const { data: history } = useXimiHistory()
  const migrations = history?.migrations ?? []
  const { data: archivedData, isFetching: fetchingArchived } =
    useArchivedXimiMigrations(archivedOpen)
  const { data: sitesData, isFetching: fetchingSites, refetch: refetchSites } =
    useXimiSourceSites(pickerOpen)
  const createMigrations = useCreateXimiMigrations()
  const runAll = useRunAllXimiMigrations()

  const sites = sitesData?.sites ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sites
    return sites.filter(
      (s) =>
        (s.displayName ?? s.name).toLowerCase().includes(q) ||
        (s.webUrl ?? '').toLowerCase().includes(q) ||
        (s.agencyTrigramme ?? '').toLowerCase().includes(q),
    )
  }, [sites, search])

  // Un site déjà migré ne doit pas pouvoir être resélectionné : deux migrations
  // sur la même source copieraient tout le contenu dans deux sites différents.
  const selectable = filtered.filter((s) => !s.alreadyMigrated)
  const allSelected = selectable.length > 0 && selectable.every((s) => selected.has(s.id))

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = () =>
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev)
        for (const s of selectable) next.delete(s.id)
        return next
      }
      return new Set([...prev, ...selectable.map((s) => s.id)])
    })

  const createSelected = () => {
    const chosen = sites.filter((s) => selected.has(s.id))
    if (chosen.length === 0) return
    const payload: CreateXimiMigrationRequest[] = chosen.map((s) => ({
      sourceSiteUrl: s.webUrl ?? '',
      sourceSiteId: s.id,
      sourceSiteName: s.displayName ?? s.name,
      targetSiteAlias: s.alias ?? undefined,
      analyzeOnly,
    }))
    createMigrations.mutate(payload, {
      onSuccess: (res) => {
        setSelected(new Set())
        setNotice(
          `${res.created} migration(s) créée(s)` +
            (res.skipped.length > 0
              ? ` — ${res.skipped.length} site(s) déjà suivi(s) : ${res.skipped.slice(0, 5).join(', ')}`
              : ''),
        )
      },
      onError: (e: unknown) =>
        setNotice(e instanceof Error ? e.message : 'Création échouée'),
    })
  }

  const withoutAgency = filtered.filter((s) => !s.agencyTrigramme && !s.alreadyMigrated).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Migration SharePoint Ximi</h1>
        <p className="mt-1 text-sm text-gray-500">
          Recopie les sites d'agence du tenant SharePoint ONELA vers le tenant Ouihelp, avec
          création du site cible, accès au groupe dynamique de l'agence et synchronisation delta
          (ajouts, modifications, suppressions, déplacements).
        </p>
      </div>

      {notice && (
        <div className="flex items-start gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-blue-500 hover:text-blue-700">
            ×
          </button>
        </div>
      )}

      {/* ── Sélection des sites source ──────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left"
        >
          {pickerOpen ? (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
          <Building2 className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-semibold text-gray-900">
            Sites SharePoint ONELA disponibles
          </span>
          {sitesData && (
            <span className="text-xs text-gray-500">{sitesData.scanned} site(s) sur le tenant</span>
          )}
        </button>

        {pickerOpen && (
          <div className="border-t border-gray-100 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[16rem] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filtrer par nom, URL ou trigramme d'agence…"
                  className="w-full rounded border border-gray-300 py-2 pl-8 pr-3 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <button
                onClick={() => void refetchSites()}
                disabled={fetchingSites}
                className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {fetchingSites ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Rafraîchir
              </button>
            </div>

            {fetchingSites && sites.length === 0 ? (
              <p className="mt-4 flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Énumération des sites du tenant ONELA…
              </p>
            ) : (
              <>
                <div className="mt-3 max-h-96 overflow-y-auto rounded border border-gray-100">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50 text-gray-600">
                      <tr>
                        <th className="w-8 px-3 py-2">
                          <button onClick={toggleAll} title="Tout sélectionner">
                            {allSelected ? (
                              <CheckSquare className="h-4 w-4 text-blue-600" />
                            ) : (
                              <Square className="h-4 w-4 text-gray-400" />
                            )}
                          </button>
                        </th>
                        <th className="px-3 py-2 text-left font-medium">Site</th>
                        <th className="px-3 py-2 text-left font-medium">URL</th>
                        <th className="px-3 py-2 text-left font-medium">Agence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filtered.map((s) => (
                        <SiteRow
                          key={s.id}
                          site={s}
                          checked={selected.has(s.id)}
                          onToggle={() => toggle(s.id)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Un site sans agence reconnue n'aura pas de groupe dynamique
                    proposé : le dire ici évite de découvrir des « droits :
                    sans objet » après coup. */}
                {withoutAgency > 0 && (
                  <p className="mt-2 text-xs text-amber-700">
                    {withoutAgency} site(s) sans agence reconnue — aucun groupe dynamique ne sera
                    proposé automatiquement, il faudra l'appliquer depuis la carte.
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={analyzeOnly}
                      onChange={(e) => setAnalyzeOnly(e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    <BarChart3 className="h-3.5 w-3.5" />
                    Analyse seule (compter le contenu, ne rien créer ni transférer)
                  </label>
                  <button
                    onClick={createSelected}
                    disabled={selected.size === 0 || createMigrations.isPending}
                    className="ml-auto inline-flex items-center gap-1.5 rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                  >
                    {createMigrations.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Préparer {selected.size} migration(s)
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Migrations actives ──────────────────────────────────────────────── */}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">
            Migrations en cours ({migrations.length})
          </h2>
          {/* Le jour J, relancer 40 sites un par un n'est pas tenable : le worker
              traite une migration à la fois, la file se vide toute seule. */}
          <button
            onClick={() =>
              runAll.mutate(undefined, {
                onSuccess: (res) => setNotice(`${res.queued} migration(s) mise(s) en file`),
              })
            }
            disabled={migrations.length === 0 || runAll.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40"
            title="Met toutes les migrations actives en file — chacune fera une passe delta"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            Synchroniser tous les sites
          </button>
        </div>
        {migrations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
            Aucune migration. Sélectionne des sites ci-dessus pour commencer.
          </p>
        ) : (
          <div className="space-y-3">
            {migrations.map((m) => (
              <XimiMigrationCard key={m.id} migration={m} />
            ))}
          </div>
        )}
      </div>

      {/* ── Mappage (livrable Ximi) ─────────────────────────────────────────── */}
      <div>
        <button
          onClick={() => setMappingOpen((v) => !v)}
          className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-gray-900"
        >
          {mappingOpen ? (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
          Tableau de mappage
        </button>
        <XimiMappingTable expanded={mappingOpen} />
      </div>

      {/* ── Archives ────────────────────────────────────────────────────────── */}
      <div>
        <button
          onClick={() => setArchivedOpen((v) => !v)}
          className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-gray-900"
        >
          {archivedOpen ? (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
          Archives
          {fetchingArchived && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
        </button>
        {archivedOpen && (
          <div className="space-y-3">
            {(archivedData?.migrations ?? []).length === 0 ? (
              <p className="text-sm text-gray-400">Aucune migration archivée.</p>
            ) : (
              archivedData!.migrations.map((m) => <XimiMigrationCard key={m.id} migration={m} />)
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SiteRow({
  site,
  checked,
  onToggle,
}: {
  site: XimiSourceSite
  checked: boolean
  onToggle: () => void
}) {
  return (
    <tr className={site.alreadyMigrated ? 'bg-gray-50 text-gray-400' : ''}>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={site.alreadyMigrated}
          className="rounded border-gray-300 disabled:opacity-40"
        />
      </td>
      <td className="px-3 py-2">
        <span className={site.alreadyMigrated ? '' : 'text-gray-800'}>
          {site.displayName ?? site.name}
        </span>
        {site.alreadyMigrated && (
          <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
            déjà suivi
          </span>
        )}
      </td>
      <td className="max-w-sm truncate px-3 py-2 text-gray-400">{site.webUrl}</td>
      <td className="px-3 py-2">
        {site.agencyTrigramme ? (
          <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700">
            {site.agencyTrigramme}
          </span>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
    </tr>
  )
}
