import { useState } from 'react'
import { Search, UserPlus, CheckCircle, XCircle, Clock, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react'
import { apiClient } from '@/lib/api'
import type {
  OnelaUser,
  MigrationRecord,
  StepStatus,
  SearchOnelaUsersResponse,
  MigrateUsersRequest,
  MigrateUsersResponse,
  MigrationHistoryResponse,
} from '@dsi-app/shared'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'

// ── Helpers ────────────────────────────────────────────────────────────────────

function StepBadge({ status, label }: { status: StepStatus; label: string }) {
  const config: Record<StepStatus, { icon: React.ReactNode; color: string }> = {
    pending: { icon: <Clock className="h-3 w-3" />, color: 'text-gray-400 bg-gray-100' },
    running: { icon: <Clock className="h-3 w-3 animate-spin" />, color: 'text-blue-600 bg-blue-50' },
    success: { icon: <CheckCircle className="h-3 w-3" />, color: 'text-green-700 bg-green-50' },
    error: { icon: <XCircle className="h-3 w-3" />, color: 'text-red-700 bg-red-50' },
    skipped: { icon: null, color: 'text-gray-300 bg-gray-50' },
  }
  const { icon, color } = config[status]
  if (status === 'skipped') return null
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', color)}>
      {icon}
      {label}
    </span>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={copy} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900">
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copié' : 'Copier'}
    </button>
  )
}

// ── Migration result card ──────────────────────────────────────────────────────

function MigrationCard({ m }: { m: MigrationRecord }) {
  const [expanded, setExpanded] = useState(false)
  const hasError = m.stepCreateAccount === 'error'

  return (
    <div className={cn('rounded-xl border bg-white p-4', hasError ? 'border-red-200' : 'border-gray-200')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-gray-900">{m.onelaDisplayName}</p>
          <p className="text-xs text-gray-500">{m.onelaUpn}</p>
          {m.gohUpn && <p className="mt-0.5 text-xs text-blue-600">→ {m.gohUpn}</p>}
        </div>
        <div className="flex flex-wrap gap-1">
          <StepBadge status={m.stepCreateAccount} label="Compte GOH" />
          <StepBadge status={m.stepSetAttributes} label="Attributs" />
          <StepBadge status={m.stepGroupMembership} label="Groupe SCIM" />
        </div>
      </div>

      {hasError && m.errorDetails && (
        <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{m.errorDetails}</p>
      )}

      {m.tempPassword && (
        <div className="mt-3 flex items-center justify-between rounded bg-amber-50 px-3 py-2">
          <div>
            <p className="text-xs font-medium text-amber-800">Mot de passe temporaire</p>
            <code className="text-sm font-mono text-amber-900">{m.tempPassword}</code>
          </div>
          <CopyButton text={m.tempPassword} />
        </div>
      )}

      {m.exchangePsScript && (
        <div className="mt-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Script PowerShell Exchange (ForwardingSMTPAddress)
          </button>
          {expanded && (
            <div className="mt-2 rounded border border-gray-200 bg-gray-50">
              <div className="flex justify-end border-b border-gray-200 px-3 py-1">
                <CopyButton text={m.exchangePsScript} />
              </div>
              <pre className="overflow-x-auto p-3 text-xs text-gray-700">{m.exchangePsScript}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Search result row ─────────────────────────────────────────────────────────

function UserRow({
  user,
  selected,
  onToggle,
  alreadyMigrated,
}: {
  user: OnelaUser
  selected: boolean
  onToggle: () => void
  alreadyMigrated: boolean
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors',
        alreadyMigrated ? 'cursor-not-allowed border-gray-100 bg-gray-50 opacity-60' : 'border-gray-200 bg-white hover:border-primary-300',
        selected && !alreadyMigrated && 'border-primary-400 bg-primary-50'
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        disabled={alreadyMigrated}
        className="h-4 w-4 rounded border-gray-300 text-primary-600"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{user.displayName}</p>
        <p className="truncate text-xs text-gray-500">{user.upn}</p>
      </div>
      <div className="shrink-0 text-right">
        {user.jobTitle && <p className="text-xs text-gray-500">{user.jobTitle}</p>}
        {user.department && <p className="text-xs text-gray-400">{user.department}</p>}
        {alreadyMigrated && (
          <span className="text-xs font-medium text-green-600">Déjà migré</span>
        )}
      </div>
    </label>
  )
}

// ── Page principale ───────────────────────────────────────────────────────────

export default function MigrationPage() {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<MigrationRecord[]>([])
  const queryClient = useQueryClient()

  // Debounce search
  const handleQueryChange = (v: string) => {
    setQuery(v)
    clearTimeout((window as unknown as { _searchTimeout?: ReturnType<typeof setTimeout> })._searchTimeout)
    ;(window as unknown as { _searchTimeout?: ReturnType<typeof setTimeout> })._searchTimeout = setTimeout(
      () => setDebouncedQuery(v),
      400
    )
  }

  // Search ONELA users
  const { data: searchData, isFetching } = useQuery({
    queryKey: ['migration-search', debouncedQuery],
    queryFn: () =>
      apiClient.get<SearchOnelaUsersResponse>(`/migration/search?q=${encodeURIComponent(debouncedQuery)}`).then((r) => r.data),
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  })

  // Migration history (to detect already migrated)
  const { data: historyData } = useQuery({
    queryKey: ['migration-history'],
    queryFn: () => apiClient.get<MigrationHistoryResponse>('/migration/history').then((r) => r.data),
    staleTime: 30_000,
  })

  const migratedUpns = new Set(historyData?.migrations.filter((m) => m.stepCreateAccount === 'success').map((m) => m.onelaUpn) ?? [])

  // Run migration
  const { mutate: runMigration, isPending } = useMutation({
    mutationFn: (req: MigrateUsersRequest) =>
      apiClient.post<MigrateUsersResponse>('/migration/run', req).then((r) => r.data),
    onSuccess: (data) => {
      setResults(data.migrations)
      setSelected(new Set())
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })

  const onlaUsers = searchData?.users ?? []
  const selectedUsers = onlaUsers.filter((u) => selected.has(u.id))

  const handleMigrate = () => {
    if (!selectedUsers.length) return
    runMigration({
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
    })
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Migration ONELA → Ouihelp</h1>
        <p className="mt-1 text-sm text-gray-500">
          Recherchez un ou plusieurs utilisateurs ONELA, sélectionnez-les et lancez la migration.
          Le compte Entra GOH est créé, les attributs SCIM posés, et le compte rejoint automatiquement
          le groupe <strong>ONELA - Migration</strong> (→ SCIM Google + Slack).
        </p>
      </header>

      {/* Search */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Rechercher un utilisateur ONELA (nom, email, UPN)…"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
          {isFetching && (
            <div className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-gray-300 border-t-primary-600" />
          )}
        </div>

        {onlaUsers.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {onlaUsers.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                selected={selected.has(u.id)}
                alreadyMigrated={migratedUpns.has(u.upn)}
                onToggle={() => {
                  setSelected((prev) => {
                    const next = new Set(prev)
                    next.has(u.id) ? next.delete(u.id) : next.add(u.id)
                    return next
                  })
                }}
              />
            ))}
          </div>
        )}

        {debouncedQuery.length >= 2 && !isFetching && onlaUsers.length === 0 && (
          <p className="mt-3 text-sm text-gray-500">Aucun utilisateur trouvé pour « {debouncedQuery} ».</p>
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
      {results.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Résultats
          </h2>
          <div className="flex flex-col gap-3">
            {results.map((m) => <MigrationCard key={m.id} m={m} />)}
          </div>
        </section>
      )}

      {/* Historique */}
      {(historyData?.migrations.length ?? 0) > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Historique des migrations
          </h2>
          <div className="flex flex-col gap-3">
            {historyData!.migrations.map((m) => <MigrationCard key={m.id} m={m} />)}
          </div>
        </section>
      )}
    </div>
  )
}
