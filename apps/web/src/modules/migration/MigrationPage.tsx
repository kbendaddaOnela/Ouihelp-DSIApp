import { useState, useEffect, useMemo, useRef } from 'react'
import { Search, UserPlus, X, ChevronDown, ChevronRight, ArrowRightLeft, Filter } from 'lucide-react'
import type { MigrationRecord, MigrateUsersRequest, OnelaUser } from '@dsi-app/shared'
import {
  useMigrationSearch,
  useMigrationHistory,
  useArchivedMigrations,
  useMigratedUpns,
  useRunMigration,
  useRunMigrationExisting,
} from './hooks/useMigration'
import { MigrationCard } from './components/MigrationCard'
import { UserRow } from './components/UserRow'
import { MigrationDashboard } from './components/MigrationDashboard'

export default function MigrationPage() {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedUsers, setSelectedUsers] = useState<OnelaUser[]>([])
  const [lastResults, setLastResults] = useState<MigrationRecord[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mode "compte existant"
  const [existingMode, setExistingMode] = useState(false)
  const [targetGoogleEmail, setTargetGoogleEmail] = useState('')
  const [existingError, setExistingError] = useState<string | null>(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 400)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  const onMigrationSuccess = (migrations: MigrationRecord[]) => {
    setLastResults(migrations)
    setSelectedUsers([])
    setTargetGoogleEmail('')
    setExistingError(null)
  }

  const { data: searchData, isFetching, error: searchError } = useMigrationSearch(debouncedQuery)
  const { data: historyData } = useMigrationHistory()
  const { mutate: runMigration, isPending } = useRunMigration(onMigrationSuccess)
  const { mutate: runExisting, isPending: isPendingExisting } = useRunMigrationExisting(onMigrationSuccess)

  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const [archivedPage, setArchivedPage] = useState(1)
  const { data: archivedData, isFetching: isFetchingArchived } = useArchivedMigrations(
    archivedPage,
    archivedExpanded
  )
  const { data: migratedUpnsData } = useMigratedUpns()

  // Filtre local sur les migrations actives — un lot fait 15 personnes, la liste
  // dépasse vite la hauteur de l'écran.
  const [activeFilter, setActiveFilter] = useState('')

  const foundUsers = searchData?.users ?? []
  const activeMigrations = historyData?.migrations ?? []
  const archivedMigrations = archivedData?.migrations ?? []
  const migratedUpns = useMemo(
    () => new Set(migratedUpnsData?.upns ?? []),
    [migratedUpnsData]
  )
  const selectedIds = new Set(selectedUsers.map((u) => u.id))

  const filteredActive = useMemo(() => {
    const needle = activeFilter.trim().toLowerCase()
    if (!needle) return activeMigrations
    return activeMigrations.filter((m) =>
      [m.onelaDisplayName, m.onelaUpn, m.gohUpn, m.onelaDepartment]
        .some((f) => f?.toLowerCase().includes(needle))
    )
  }, [activeMigrations, activeFilter])

  // Les migrations tout juste lancées réapparaissent dans « actives » dès le
  // refetch : sans ce filtre, la même carte s'affichait deux fois à l'écran.
  const activeIds = useMemo(() => new Set(activeMigrations.map((m) => m.id)), [activeMigrations])
  const lastResultIds = useMemo(() => new Set(lastResults.map((m) => m.id)), [lastResults])
  const pendingResults = lastResults.filter((m) => !activeIds.has(m.id))

  const toggleUser = (u: OnelaUser) => {
    if (existingMode) {
      // En mode compte existant : 1 seul utilisateur à la fois
      setSelectedUsers([u])
    } else {
      setSelectedUsers((prev) =>
        prev.some((x) => x.id === u.id) ? prev.filter((x) => x.id !== u.id) : [...prev, u]
      )
    }
  }

  const removeUser = (id: string) => {
    setSelectedUsers((prev) => prev.filter((u) => u.id !== id))
  }

  const toggleExistingMode = () => {
    setExistingMode((v) => !v)
    setSelectedUsers([])
    setTargetGoogleEmail('')
    setExistingError(null)
  }

  const handleMigrate = () => {
    if (existingMode) {
      const u = selectedUsers[0]
      if (!u) return
      if (!targetGoogleEmail.includes('@')) {
        setExistingError('Saisis un email Google valide (ex: prenom.nom@ouihelp.fr)')
        return
      }
      setExistingError(null)
      runExisting({
        onelaUserId: u.id,
        onelaUpn: u.upn,
        onelaDisplayName: u.displayName,
        onelaEmail: u.email,
        onelaDepartment: u.department,
        onelaJobTitle: u.jobTitle,
        targetGoogleEmail,
      })
    } else {
      if (!selectedUsers.length) return
      const req: MigrateUsersRequest = {
        users: selectedUsers.map((u) => ({
          onelaUserId: u.id,
          onelaUpn: u.upn,
          onelaDisplayName: u.displayName,
          onelaEmail: u.email,
          onelaDepartment: u.department,
          onelaJobTitle: u.jobTitle,
          givenName: u.givenName,
          surname: u.surname,
        })),
      }
      runMigration(req)
    }
  }

  const isRunning = isPending || isPendingExisting

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      {/* ── Colonne principale ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-6">
        <MigrationDashboard />
        <header>
          <h1 className="text-2xl font-semibold text-gray-900">Migration ONELA → Ouihelp</h1>
          <p className="mt-1 text-sm text-gray-500">
            Recherchez un utilisateur ONELA, sélectionnez-le et lancez la migration. Le compte Entra GOH
            est créé avec <code className="rounded bg-gray-100 px-1">companyName=ONELA</code> — le groupe
            dynamique <strong>ONELA - Migration</strong> se déclenche automatiquement (→ SCIM Google + Slack).
          </p>
        </header>

        {/* Recherche + sélection */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          {/* Toggle mode compte existant */}
          <div className="mb-4 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-gray-500" />
              <span className="text-sm font-medium text-gray-700">Compte Google existant</span>
              <span className="text-xs text-gray-400">(skip création Entra GOH)</span>
            </div>
            <button
              onClick={toggleExistingMode}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                existingMode ? 'bg-primary-600' : 'bg-gray-300'
              }`}
              aria-pressed={existingMode}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  existingMode ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder={existingMode
                ? 'Rechercher le compte ONELA source…'
                : 'Rechercher par nom, email ou UPN ONELA…'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            {isFetching && (
              <div className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-gray-300 border-t-primary-600" />
            )}
          </div>

          {foundUsers.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {foundUsers.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  selected={selectedIds.has(u.id)}
                  alreadyMigrated={!existingMode && migratedUpns.has(u.upn)}
                  onToggle={() => toggleUser(u)}
                />
              ))}
            </div>
          )}

          {searchError && (
            <p className="mt-3 text-sm text-red-600">Erreur : {(searchError as Error).message}</p>
          )}
          {debouncedQuery.length >= 2 && !isFetching && !searchError && foundUsers.length === 0 && (
            <p className="mt-3 text-sm text-gray-500">Aucun résultat pour « {debouncedQuery} ».</p>
          )}
        </div>

        {/* Migrations tout juste lancées, avant que le refetch de la liste arrive */}
        {pendingResults.length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Résultats</h2>
            <div className="flex flex-col gap-3">
              {pendingResults.map((m) => <MigrationCard key={m.id} m={m} defaultExpanded />)}
            </div>
          </section>
        )}

        {/* Migrations actives (cartes repliées par défaut) */}
        {activeMigrations.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Migrations actives ({activeFilter ? `${filteredActive.length}/` : ''}
                {activeMigrations.length})
              </h2>
              <div className="relative w-56">
                <Filter className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <input
                  type="search"
                  value={activeFilter}
                  onChange={(e) => setActiveFilter(e.target.value)}
                  placeholder="Filtrer (nom, UPN, service)…"
                  aria-label="Filtrer les migrations actives"
                  className="w-full rounded-lg border border-gray-300 py-1.5 pl-8 pr-2 text-xs focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
                />
              </div>
            </div>
            <div className="flex flex-col gap-3">
              {filteredActive.map((m) => (
                <MigrationCard key={m.id} m={m} defaultExpanded={lastResultIds.has(m.id)} />
              ))}
            </div>
            {activeFilter && filteredActive.length === 0 && (
              <p className="text-sm text-gray-500">Aucune migration active pour « {activeFilter} ».</p>
            )}
          </section>
        )}

        {/* Historique (collapsable, paginé) */}
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
            <>
              {isFetchingArchived && !archivedData ? (
                <p className="text-sm text-gray-500">Chargement…</p>
              ) : archivedMigrations.length === 0 ? (
                <p className="text-sm text-gray-500">Aucune migration archivée.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {archivedMigrations.map((m) => <MigrationCard key={m.id} m={m} />)}
                </div>
              )}
              {archivedData && (archivedData.hasMore || archivedPage > 1) && (
                <div className="mt-3 flex items-center justify-center gap-3 text-xs text-gray-600">
                  <button
                    onClick={() => setArchivedPage((p) => Math.max(1, p - 1))}
                    disabled={archivedPage === 1 || isFetchingArchived}
                    className="rounded-lg border border-gray-300 px-2.5 py-1.5 hover:bg-gray-50 disabled:opacity-40"
                  >
                    Précédent
                  </button>
                  <span>
                    Page {archivedPage} / {Math.max(1, Math.ceil(archivedData.total / archivedData.limit))}
                  </span>
                  <button
                    onClick={() => setArchivedPage((p) => p + 1)}
                    disabled={!archivedData.hasMore || isFetchingArchived}
                    className="rounded-lg border border-gray-300 px-2.5 py-1.5 hover:bg-gray-50 disabled:opacity-40"
                  >
                    Suivant
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* ── Panel latéral : utilisateurs sélectionnés ──────────────────── */}
      <aside className="lg:sticky lg:top-6 lg:h-fit">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              {existingMode ? 'Compte source' : `Sélection (${selectedUsers.length})`}
            </h3>
            {selectedUsers.length > 0 && (
              <button
                onClick={() => setSelectedUsers([])}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Effacer
              </button>
            )}
          </div>

          {selectedUsers.length === 0 ? (
            <p className="mt-3 text-xs text-gray-400">
              {existingMode
                ? 'Recherche et sélectionne le compte ONELA source (1 seul).'
                : "Aucun utilisateur sélectionné. Recherche puis coche un utilisateur pour l'ajouter ici."}
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-1.5">
              {selectedUsers.map((u) => (
                <li
                  key={u.id}
                  className="group flex items-center justify-between gap-2 rounded-lg border border-gray-100 bg-gray-50 px-2.5 py-1.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-gray-900">{u.displayName}</p>
                    <p className="truncate text-gray-500">{u.upn}</p>
                  </div>
                  <button
                    onClick={() => removeUser(u.id)}
                    aria-label={`Retirer ${u.displayName}`}
                    className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Champ email cible (mode compte existant uniquement) */}
          {existingMode && (
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Email Google cible <span className="text-red-500">*</span>
              </label>
              <input
                type="email"
                placeholder="prenom.nom@ouihelp.fr"
                value={targetGoogleEmail}
                onChange={(e) => { setTargetGoogleEmail(e.target.value); setExistingError(null) }}
                className={`w-full rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-1 ${
                  existingError
                    ? 'border-red-400 focus:border-red-500 focus:ring-red-500'
                    : 'border-gray-300 focus:border-primary-500 focus:ring-primary-500'
                }`}
              />
              {existingError && (
                <p className="mt-1 text-xs text-red-600">{existingError}</p>
              )}
              {targetGoogleEmail && !existingError && (
                <p className="mt-1 text-xs text-gray-400">
                  Les étapes Entra (création, attributs, groupe) seront passées. Seules les données (mail, calendrier, contacts) seront migrées.
                </p>
              )}
            </div>
          )}

          <button
            onClick={handleMigrate}
            disabled={isRunning || selectedUsers.length === 0 || (existingMode && !targetGoogleEmail)}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            <UserPlus className="h-4 w-4" />
            {isRunning
              ? 'Migration en cours…'
              : existingMode
              ? 'Lancer la migration (compte existant)'
              : 'Lancer la migration'}
          </button>
        </div>
      </aside>
    </div>
  )
}
