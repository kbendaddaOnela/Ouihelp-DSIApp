import { useState, useEffect, useRef } from 'react'
import { Search, UserPlus, X, ChevronDown, ChevronRight } from 'lucide-react'
import type { MigrationRecord, MigrateUsersRequest, OnelaUser } from '@dsi-app/shared'
import { useMigrationSearch, useMigrationHistory, useRunMigration } from './hooks/useMigration'
import { MigrationCard } from './components/MigrationCard'
import { UserRow } from './components/UserRow'

export default function MigrationPage() {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedUsers, setSelectedUsers] = useState<OnelaUser[]>([])
  const [lastResults, setLastResults] = useState<MigrationRecord[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 400)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  const { data: searchData, isFetching, error: searchError } = useMigrationSearch(debouncedQuery)
  const { data: historyData } = useMigrationHistory()
  const { mutate: runMigration, isPending } = useRunMigration((migrations) => {
    setLastResults(migrations)
    setSelectedUsers([])
  })

  const [archivedExpanded, setArchivedExpanded] = useState(false)

  const foundUsers = searchData?.users ?? []
  const allMigrations = historyData?.migrations ?? []
  const activeMigrations = allMigrations.filter((m) => !m.archived)
  const archivedMigrations = allMigrations.filter((m) => m.archived)
  const migratedUpns = new Set(
    allMigrations.filter((m) => m.stepCreateAccount === 'success').map((m) => m.onelaUpn)
  )
  const selectedIds = new Set(selectedUsers.map((u) => u.id))

  const toggleUser = (u: OnelaUser) => {
    setSelectedUsers((prev) =>
      prev.some((x) => x.id === u.id) ? prev.filter((x) => x.id !== u.id) : [...prev, u]
    )
  }

  const removeUser = (id: string) => {
    setSelectedUsers((prev) => prev.filter((u) => u.id !== id))
  }

  const handleMigrate = () => {
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

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      {/* ── Colonne principale ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-6">
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
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Rechercher par nom, email ou UPN ONELA…"
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
                  alreadyMigrated={migratedUpns.has(u.upn)}
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

        {/* Résultats de la dernière migration (juste après le clic, indépendant de l'archivage) */}
        {lastResults.length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Résultats</h2>
            <div className="flex flex-col gap-3">
              {lastResults.map((m) => <MigrationCard key={m.id} m={m} />)}
            </div>
          </section>
        )}

        {/* Migrations actives */}
        {activeMigrations.length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Migrations actives ({activeMigrations.length})
            </h2>
            <div className="flex flex-col gap-3">
              {activeMigrations.map((m) => <MigrationCard key={m.id} m={m} />)}
            </div>
          </section>
        )}

        {/* Historique (collapsable) */}
        {archivedMigrations.length > 0 && (
          <section>
            <button
              onClick={() => setArchivedExpanded((v) => !v)}
              className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700"
            >
              {archivedExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Historique ({archivedMigrations.length})
            </button>
            {archivedExpanded && (
              <div className="flex flex-col gap-3">
                {archivedMigrations.map((m) => <MigrationCard key={m.id} m={m} />)}
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── Panel latéral : utilisateurs sélectionnés ──────────────────── */}
      <aside className="lg:sticky lg:top-6 lg:h-fit">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              Sélection ({selectedUsers.length})
            </h3>
            {selectedUsers.length > 0 && (
              <button
                onClick={() => setSelectedUsers([])}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Tout effacer
              </button>
            )}
          </div>

          {selectedUsers.length === 0 ? (
            <p className="mt-3 text-xs text-gray-400">
              Aucun utilisateur sélectionné. Recherche puis coche un utilisateur pour l'ajouter ici.
            </p>
          ) : (
            <ul className="mt-3 flex max-h-96 flex-col gap-1.5 overflow-y-auto">
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

          <button
            onClick={handleMigrate}
            disabled={isPending || selectedUsers.length === 0}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            <UserPlus className="h-4 w-4" />
            {isPending ? 'Migration en cours…' : 'Lancer la migration'}
          </button>
        </div>
      </aside>
    </div>
  )
}
