import { useState, useEffect, useRef } from 'react'
import { Search, UserPlus } from 'lucide-react'
import type { MigrationRecord, MigrateUsersRequest } from '@dsi-app/shared'
import { useMigrationSearch, useMigrationHistory, useRunMigration } from './hooks/useMigration'
import { MigrationCard } from './components/MigrationCard'
import { UserRow } from './components/UserRow'

export default function MigrationPage() {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastResults, setLastResults] = useState<MigrationRecord[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 400)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  const { data: searchData, isFetching } = useMigrationSearch(debouncedQuery)
  const { data: historyData } = useMigrationHistory()
  const { mutate: runMigration, isPending } = useRunMigration((migrations) => {
    setLastResults(migrations)
    setSelected(new Set())
  })

  const foundUsers = searchData?.users ?? []
  const migratedUpns = new Set(
    historyData?.migrations.filter((m) => m.stepCreateAccount === 'success').map((m) => m.onelaUpn) ?? []
  )

  const selectedUsers = foundUsers.filter((u) => selected.has(u.id))

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
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
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
                selected={selected.has(u.id)}
                alreadyMigrated={migratedUpns.has(u.upn)}
                onToggle={() =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    next.has(u.id) ? next.delete(u.id) : next.add(u.id)
                    return next
                  })
                }
              />
            ))}
          </div>
        )}

        {debouncedQuery.length >= 2 && !isFetching && foundUsers.length === 0 && (
          <p className="mt-3 text-sm text-gray-500">Aucun résultat pour « {debouncedQuery} ».</p>
        )}

        {selected.size > 0 && (
          <div className="mt-4 flex items-center justify-between rounded-lg bg-primary-50 px-4 py-3">
            <p className="text-sm font-medium text-primary-800">
              {selected.size} utilisateur{selected.size > 1 ? 's' : ''} sélectionné{selected.size > 1 ? 's' : ''}
            </p>
            <button
              onClick={handleMigrate}
              disabled={isPending}
              className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-60"
            >
              <UserPlus className="h-4 w-4" />
              {isPending ? 'Migration en cours…' : 'Lancer la migration'}
            </button>
          </div>
        )}
      </div>

      {/* Résultats de la dernière migration */}
      {lastResults.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Résultats</h2>
          <div className="flex flex-col gap-3">
            {lastResults.map((m) => <MigrationCard key={m.id} m={m} />)}
          </div>
        </section>
      )}

      {/* Historique */}
      {(historyData?.migrations.length ?? 0) > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Historique ({historyData!.migrations.length})
          </h2>
          <div className="flex flex-col gap-3">
            {historyData!.migrations.map((m) => <MigrationCard key={m.id} m={m} />)}
          </div>
        </section>
      )}
    </div>
  )
}
