import { useState, useEffect } from 'react'
import {
  Link2,
  Library,
  Folder,
  FolderOpen,
  File as FileIcon,
  ChevronRight,
  ChevronDown,
  Loader2,
  ArrowLeft,
  Search,
  HardDrive,
  Check,
  BarChart3,
} from 'lucide-react'
import type {
  ResolveSiteResponse,
  SharepointDrive,
  SharepointItem,
  GoogleSharedDrive,
} from '@dsi-app/shared'
import {
  useSharepointHistory,
  useResolveSite,
  useBrowse,
  useSearchSharedDrives,
  useCreateSharepointMigration,
  useArchivedSharepointMigrations,
} from './hooks/useSharepointMigration'
import { SharepointMigrationCard } from './components/SharepointMigrationCard'

interface FolderCrumb {
  id: string | null
  name: string
}

// Site SharePoint source par défaut (toujours le même chez ONELA).
const DEFAULT_SITE_URL = 'https://onelaservices.sharepoint.com/sites/ALL-ONELA/'

export default function SharepointMigrationPage() {
  const [url, setUrl] = useState(DEFAULT_SITE_URL)
  const [resolved, setResolved] = useState<ResolveSiteResponse | null>(null)
  const [drive, setDrive] = useState<SharepointDrive | null>(null)
  const [crumbs, setCrumbs] = useState<FolderCrumb[]>([])
  const [items, setItems] = useState<SharepointItem[]>([])
  // Dossiers cochés pour migration (chacun recréé à la racine). Vide = bibliothèque entière.
  const [selectedRoots, setSelectedRoots] = useState<Array<{ id: string; name: string }>>([])
  const [gdQuery, setGdQuery] = useState('')
  const [selectedGd, setSelectedGd] = useState<GoogleSharedDrive | null>(null)
  const [migrateVersions, setMigrateVersions] = useState(true)
  const [label, setLabel] = useState('')
  const [maxVersions, setMaxVersions] = useState(5)
  const [historyExpanded, setHistoryExpanded] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Debounce de la recherche Shared Drive (évite un appel par frappe)
  const [debouncedGdQuery, setDebouncedGdQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedGdQuery(gdQuery), 400)
    return () => clearTimeout(t)
  }, [gdQuery])

  const resolveSite = useResolveSite()
  const browse = useBrowse()
  const { data: gdResults, isFetching: gdSearching } = useSearchSharedDrives(
    debouncedGdQuery,
    !!drive && !selectedGd,
  )
  const createMigration = useCreateSharepointMigration()
  const { data: historyData } = useSharepointHistory()
  const migrations = historyData?.migrations ?? []
  // Les archivées ne sont chargées qu'à l'ouverture de la section.
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const { data: archivedData, isFetching: isFetchingArchived } =
    useArchivedSharepointMigrations(archivedExpanded)
  const archivedMigrations = archivedData?.migrations ?? []

  const currentFolder = crumbs.length > 0 ? crumbs[crumbs.length - 1]! : null
  const currentFolderId = currentFolder?.id ?? null

  const onResolve = () => {
    setError(null)
    resolveSite.mutate(url.trim(), {
      onSuccess: (data) => {
        setResolved(data)
        setDrive(null)
        setItems([])
        setCrumbs([])
      },
      onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Résolution échouée'),
    })
  }

  const toggleRoot = (folder: SharepointItem) => {
    setSelectedRoots((prev) =>
      prev.some((r) => r.id === folder.id)
        ? prev.filter((r) => r.id !== folder.id)
        : [...prev, { id: folder.id, name: folder.name }],
    )
  }

  const openDrive = (d: SharepointDrive) => {
    setError(null)
    setDrive(d)
    setSelectedRoots([])
    setCrumbs([{ id: null, name: d.name }])
    browse.mutate(
      { driveId: d.id, itemId: null },
      {
        onSuccess: (data) => setItems(data.items),
        onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Navigation échouée'),
      },
    )
  }

  const openFolder = (folder: SharepointItem) => {
    if (!drive) return
    setError(null)
    const newCrumbs = [...crumbs, { id: folder.id, name: folder.name }]
    setCrumbs(newCrumbs)
    browse.mutate(
      { driveId: drive.id, itemId: folder.id },
      {
        onSuccess: (data) => setItems(data.items),
        onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Navigation échouée'),
      },
    )
  }

  const goToCrumb = (index: number) => {
    if (!drive) return
    const target = crumbs[index]!
    setCrumbs(crumbs.slice(0, index + 1))
    browse.mutate(
      { driveId: drive.id, itemId: target.id },
      { onSuccess: (data) => setItems(data.items) },
    )
  }

  const reset = () => {
    setResolved(null)
    setDrive(null)
    setItems([])
    setCrumbs([])
    setUrl(DEFAULT_SITE_URL)
    setSelectedRoots([])
    setGdQuery('')
    setSelectedGd(null)
    setMigrateVersions(true)
    setMaxVersions(5)
    setLabel('')
    setError(null)
  }

  /** Lance une analyse (dry run) : compte le contenu courant, ne transfère rien. */
  const onAnalyze = () => {
    if (!resolved || !drive) return
    setError(null)
    createMigration.mutate(
      {
        siteUrl: url.trim(),
        siteId: resolved.site.id,
        siteName: resolved.site.displayName ?? resolved.site.name,
        driveId: drive.id,
        driveName: drive.name,
        selectedRoots,
        gdSharedDriveId: '',
        gdSharedDriveName: '',
        label: label.trim() || undefined,
        migrateVersions: false,
        analyzeOnly: true,
      },
      {
        onSuccess: () => reset(),
        onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Analyse échouée'),
      },
    )
  }

  const onSubmit = () => {
    if (!resolved || !drive) return
    if (!selectedGd) {
      setError('Sélectionne le Shared Drive Google cible')
      return
    }
    createMigration.mutate(
      {
        siteUrl: url.trim(),
        siteId: resolved.site.id,
        siteName: resolved.site.displayName ?? resolved.site.name,
        driveId: drive.id,
        driveName: drive.name,
        selectedRoots,
        gdSharedDriveId: selectedGd.id,
        gdSharedDriveName: selectedGd.name,
        label: label.trim() || undefined,
        migrateVersions,
        maxVersions,
      },
      {
        onSuccess: () => reset(),
        onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Création échouée'),
      },
    )
  }

  const folders = items.filter((i) => i.isFolder)
  const files = items.filter((i) => !i.isFolder)

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-gray-900">Migration SharePoint → Shared Drive</h1>
        <p className="text-sm text-gray-600">
          Transfère une bibliothèque (ou un sous-dossier) d'un site SharePoint ONELA vers un
          Google Shared Drive du Workspace OUIHELP.
        </p>
      </header>

      {/* Étape 1 : URL du site */}
      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-gray-800">1. Coller l'URL du site SharePoint</h2>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && url.trim() && onResolve()}
              placeholder="https://onela.sharepoint.com/sites/RH"
              className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={onResolve}
            disabled={!url.trim() || resolveSite.isPending}
            className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {resolveSite.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Résoudre
          </button>
        </div>
      </section>

      {/* Étape 2 : choix de la bibliothèque */}
      {resolved && (
        <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800">
              2. Choisir la bibliothèque — <span className="text-gray-500">{resolved.site.displayName ?? resolved.site.name}</span>
            </h2>
            <button onClick={reset} className="text-xs text-gray-400 hover:text-gray-600">
              Changer de site
            </button>
          </div>
          {resolved.drives.length === 0 && (
            <p className="text-sm text-gray-500">Aucune bibliothèque de documents sur ce site.</p>
          )}
          <ul className="grid gap-2 sm:grid-cols-2">
            {resolved.drives.map((d) => (
              <li key={d.id}>
                <button
                  onClick={() => openDrive(d)}
                  className={`flex w-full items-center gap-2 rounded border px-3 py-2 text-left text-sm transition-colors ${
                    drive?.id === d.id
                      ? 'border-blue-300 bg-blue-50 text-blue-800'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <Library className="h-4 w-4 shrink-0 text-gray-400" />
                  <span className="truncate">{d.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Étape 3 : navigation / choix du dossier */}
      {drive && (
        <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-gray-800">
            3. Sélectionner le(s) dossier(s) à migrer
          </h2>
          <p className="mb-3 text-xs text-gray-500">
            <strong>Coche</strong> un ou plusieurs dossiers (chacun sera recréé à la racine du
            Shared Drive). Clique sur un nom pour <strong>naviguer</strong> dedans. Ne coche rien
            pour migrer <strong>toute la bibliothèque</strong>.
          </p>

          {/* Dossiers sélectionnés */}
          {selectedRoots.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {selectedRoots.map((r) => (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-800"
                >
                  <Folder className="h-3 w-3" />
                  {r.name}
                  <button
                    onClick={() => setSelectedRoots((prev) => prev.filter((x) => x.id !== r.id))}
                    className="ml-0.5 text-blue-500 hover:text-blue-800"
                    aria-label={`Retirer ${r.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Fil d'Ariane */}
          <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-gray-600">
            {crumbs.map((c, idx) => (
              <span key={`${c.id ?? 'root'}-${idx}`} className="flex items-center gap-1">
                {idx > 0 && <ChevronRight className="h-3 w-3 text-gray-300" />}
                <button
                  onClick={() => goToCrumb(idx)}
                  className={`rounded px-1.5 py-0.5 hover:bg-gray-100 ${
                    idx === crumbs.length - 1 ? 'font-medium text-gray-900' : 'text-blue-600'
                  }`}
                >
                  {idx === 0 ? c.name : c.name}
                </button>
              </span>
            ))}
          </div>

          <div className="max-h-72 overflow-y-auto rounded border border-gray-200">
            {browse.isPending && (
              <div className="flex items-center justify-center py-6 text-gray-400">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
            {!browse.isPending && items.length === 0 && (
              <p className="px-3 py-4 text-sm text-gray-400">Dossier vide.</p>
            )}
            {!browse.isPending && (
              <ul className="divide-y divide-gray-100">
                {folders.map((f) => {
                  const checked = selectedRoots.some((r) => r.id === f.id)
                  return (
                    <li
                      key={f.id}
                      className={`flex items-center gap-2 px-3 py-2 text-sm ${
                        checked ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleRoot(f)}
                        className="shrink-0 cursor-pointer"
                        aria-label={`Sélectionner ${f.name}`}
                      />
                      <button
                        onClick={() => openFolder(f)}
                        className="flex flex-1 items-center gap-2 truncate text-left"
                        title="Ouvrir le dossier"
                      >
                        <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                        <span className="flex-1 truncate text-gray-800">{f.name}</span>
                        {f.childCount != null && (
                          <span className="text-xs text-gray-400">{f.childCount}</span>
                        )}
                        <ChevronRight className="h-4 w-4 text-gray-300" />
                      </button>
                    </li>
                  )
                })}
                {files.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-500">
                    <FileIcon className="h-4 w-4 shrink-0 text-gray-300" />
                    <span className="flex-1 truncate">{f.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between gap-3">
            {currentFolderId ? (
              <button
                onClick={() => goToCrumb(crumbs.length - 2)}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft className="h-3 w-3" /> Remonter
              </button>
            ) : (
              <span />
            )}
            <button
              onClick={onAnalyze}
              disabled={createMigration.isPending}
              className="inline-flex items-center gap-1.5 rounded border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
              title="Compte les fichiers et le volume du contenu courant, sans rien transférer"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Analyser sans transférer
            </button>
          </div>
        </section>
      )}

      {/* Étape 4 : sélection du Shared Drive Google cible + validation */}
      {drive && (
        <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">4. Shared Drive Google cible</h2>
          <div className="space-y-3">
            <div className="rounded bg-gray-50 px-3 py-2 text-xs text-gray-600">
              <FolderOpen className="mr-1 inline h-3.5 w-3.5 text-gray-400" />
              Source : <strong>{drive.name}</strong>
              {' — '}
              {selectedRoots.length > 0 ? (
                <span>
                  {selectedRoots.length} dossier(s) recréé(s) :{' '}
                  <strong>{selectedRoots.map((r) => r.name).join(', ')}</strong>
                </span>
              ) : (
                <span>toute la bibliothèque (contenu à la racine)</span>
              )}
            </div>

            {selectedGd ? (
              <div className="flex items-center justify-between rounded border border-green-200 bg-green-50 px-3 py-2 text-sm">
                <span className="flex items-center gap-2 text-green-800">
                  <Check className="h-4 w-4" />
                  Cible : <strong>{selectedGd.name}</strong>
                </span>
                <button
                  onClick={() => setSelectedGd(null)}
                  className="text-xs text-green-700 hover:underline"
                >
                  Changer
                </button>
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  Rechercher le Shared Drive (créé manuellement dans Google)
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <input
                    value={gdQuery}
                    onChange={(e) => setGdQuery(e.target.value)}
                    placeholder="Taper le nom du Drive partagé…"
                    className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  {gdSearching && (
                    <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400" />
                  )}
                </div>
                {gdResults && gdResults.drives.length > 0 && (
                  <ul className="mt-2 max-h-56 divide-y divide-gray-100 overflow-y-auto rounded border border-gray-200">
                    {gdResults.drives.map((d) => (
                      <li
                        key={d.id}
                        onClick={() => setSelectedGd(d)}
                        className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-blue-50"
                      >
                        <HardDrive className="h-4 w-4 shrink-0 text-gray-400" />
                        <span className="flex-1 truncate text-gray-800">{d.name}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {gdResults && gdResults.drives.length === 0 && !gdSearching && (
                  <p className="mt-2 text-xs text-gray-500">
                    Aucun Shared Drive trouvé. Crée-le d'abord dans Google Drive, puis recherche-le ici.
                  </p>
                )}
              </div>
            )}

            <label className="block text-xs text-gray-700">
              <span className="font-medium">Libellé</span>{' '}
              <span className="text-gray-400">(facultatif — pour s'y retrouver dans la liste)</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={200}
                placeholder={selectedGd?.name ?? 'ex. Finance — lot 1 (CDG + Compta + ADV)'}
                className="mt-1 w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
            </label>

            <label className="flex cursor-pointer items-start gap-2 rounded border border-gray-200 px-3 py-2 text-xs text-gray-700">
              <input
                type="checkbox"
                checked={migrateVersions}
                onChange={(e) => setMigrateVersions(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <strong>Migrer l'historique des versions</strong> — plus fidèle, mais multiplie le
                volume transféré. Décoche pour ne prendre que la version courante.
              </span>
            </label>
            {migrateVersions && (
              <label className="flex items-center gap-2 pl-6 text-xs text-gray-600">
                Conserver au maximum
                <input
                  type="number"
                  min={1}
                  value={maxVersions}
                  onChange={(e) => setMaxVersions(Math.max(1, Number(e.target.value) || 1))}
                  className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
                />
                versions (la 1<sup>re</sup> + les plus récentes)
                <span
                  className="cursor-help text-gray-400"
                  title="Microsoft Graph n'expose pas la date d'expiration des versions. Cette limite reproduit la politique SharePoint, qui ne conserve durablement que la première version et les plus récentes — les intermédiaires expirent."
                >
                  ⓘ
                </span>
              </label>
            )}
            {error && <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
            <div className="flex justify-end gap-2">
              <button
                onClick={reset}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Annuler
              </button>
              <button
                onClick={onSubmit}
                disabled={createMigration.isPending || !selectedGd}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {createMigration.isPending ? 'Création…' : 'Créer la migration'}
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Le Shared Drive doit être <strong>créé au préalable dans Google Drive</strong>. L'app
              transfère l'arborescence (dossiers + fichiers) dedans. Le transfert démarre quand tu
              cliques « Lancer » sur la carte.
            </p>
          </div>
        </section>
      )}

      {error && !drive && (
        <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {/* Historique */}
      <section>
        <button
          onClick={() => setHistoryExpanded((v) => !v)}
          className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-800 hover:text-gray-900"
        >
          {historyExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Migrations ({migrations.length})
        </button>
        {historyExpanded && (
          <div className="space-y-3">
            {migrations.length === 0 && (
              <p className="text-sm text-gray-500">Aucune migration SharePoint active.</p>
            )}
            {migrations.map((m) => (
              <SharepointMigrationCard key={m.id} migration={m} />
            ))}
          </div>
        )}
      </section>

      {/* Archives — repliées par défaut, chargées à la demande */}
      <section>
        <button
          onClick={() => setArchivedExpanded((v) => !v)}
          aria-expanded={archivedExpanded}
          className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700"
        >
          {archivedExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Historique{archivedData ? ` (${archivedData.total})` : ''}
        </button>
        {archivedExpanded && (
          <div className="space-y-3">
            {isFetchingArchived && !archivedData ? (
              <p className="text-sm text-gray-500">Chargement…</p>
            ) : archivedMigrations.length === 0 ? (
              <p className="text-sm text-gray-500">Aucune migration archivée.</p>
            ) : (
              archivedMigrations.map((m) => (
                <SharepointMigrationCard key={m.id} migration={m} />
              ))
            )}
          </div>
        )}
      </section>
    </div>
  )
}
