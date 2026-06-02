import { useState, useMemo } from 'react'
import { Search, Mail, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { SharedMailbox } from '@dsi-app/shared'
import {
  useSharedMailboxSearch,
  useSharedMigrationHistory,
  useCreateSharedMigration,
} from './hooks/useSharedMailbox'
import { SharedMailboxCard } from './components/SharedMailboxCard'

export default function SharedMailboxPage() {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SharedMailbox | null>(null)
  const [targetGroupEmail, setTargetGroupEmail] = useState('')
  const [targetGroupName, setTargetGroupName] = useState('')
  const [historyExpanded, setHistoryExpanded] = useState(true)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const { data: searchData, isFetching, error: searchError } = useSharedMailboxSearch(query)
  const { data: historyData } = useSharedMigrationHistory()
  const { mutate: createMigration, isPending: isCreating } = useCreateSharedMigration()

  const migrations = historyData?.migrations ?? []
  const existingByEmail = useMemo(
    () => new Set(migrations.map((m) => m.onelaEmail.toLowerCase())),
    [migrations],
  )

  const mailboxes = searchData?.mailboxes ?? []

  const onSelect = (mb: SharedMailbox) => {
    setSelected(mb)
    // Convention : le groupe Google a la MÊME adresse que la BAL Exchange
    // (ex. dsi@onela.com sur Exchange ET sur Google Workspace).
    // Le dual delivery utilise une adresse de routage Google (test-google-a.com)
    // pour éviter la boucle, géré automatiquement côté API.
    if (!targetGroupEmail) setTargetGroupEmail(mb.email)
    if (!targetGroupName) setTargetGroupName(mb.displayName)
    setSubmitError(null)
  }

  const onSubmit = () => {
    if (!selected) return
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(targetGroupEmail)) {
      setSubmitError('Adresse du groupe Google invalide')
      return
    }
    if (!targetGroupName.trim()) {
      setSubmitError('Nom du groupe requis')
      return
    }
    createMigration(
      {
        onelaUserId: selected.id,
        onelaUpn: selected.upn,
        onelaEmail: selected.email,
        onelaDisplayName: selected.displayName,
        targetGroupEmail: targetGroupEmail.trim().toLowerCase(),
        targetGroupName: targetGroupName.trim(),
      },
      {
        onSuccess: () => {
          setSelected(null)
          setTargetGroupEmail('')
          setTargetGroupName('')
          setQuery('')
        },
        onError: (err: unknown) => {
          setSubmitError(err instanceof Error ? err.message : 'Échec de la création')
        },
      },
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-gray-900">Migration Shared Mailbox</h1>
        <p className="text-sm text-gray-600">
          Migre une boîte aux lettres partagée Exchange vers l'archive d'un Google Group
          — sans consommer de licence Workspace.
        </p>
      </header>

      {/* Recherche */}
      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-gray-800">1. Choisir une boîte partagée Exchange</h2>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrer par nom ou email…"
            className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {isFetching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-gray-400" />}
        </div>

        {searchError && (
          <div className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
            Échec : {searchError instanceof Error ? searchError.message : String(searchError)}
          </div>
        )}

        {mailboxes.length > 0 && (
          <ul className="mt-3 max-h-64 divide-y divide-gray-100 overflow-y-auto rounded border border-gray-200">
            {mailboxes.map((mb) => {
              const alreadyMigrated = existingByEmail.has(mb.email.toLowerCase())
              const isSelected = selected?.id === mb.id
              return (
                <li
                  key={mb.id}
                  className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm hover:bg-blue-50 ${
                    isSelected ? 'bg-blue-100' : ''
                  } ${alreadyMigrated ? 'opacity-60' : ''}`}
                  onClick={() => !alreadyMigrated && onSelect(mb)}
                >
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-gray-400" />
                    <div>
                      <div className="font-medium text-gray-900">{mb.displayName}</div>
                      <div className="text-xs text-gray-500">{mb.email}</div>
                    </div>
                  </div>
                  {alreadyMigrated && <span className="text-xs text-gray-500">déjà migrée</span>}
                </li>
              )
            })}
          </ul>
        )}
        {!isFetching && mailboxes.length === 0 && query && (
          <p className="mt-3 text-sm text-gray-500">Aucune boîte partagée trouvée.</p>
        )}
        {!query && mailboxes.length === 0 && (
          <p className="mt-3 text-sm text-gray-500">Tape un mot-clé pour filtrer, ou laisse vide pour tout lister.</p>
        )}
      </section>

      {/* Formulaire cible */}
      {selected && (
        <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">2. Cible Google Group</h2>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Adresse email du groupe</label>
              <input
                value={targetGroupEmail}
                onChange={(e) => setTargetGroupEmail(e.target.value)}
                placeholder="compta@ouihelp.com"
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Nom d'affichage du groupe</label>
              <input
                value={targetGroupName}
                onChange={(e) => setTargetGroupName(e.target.value)}
                placeholder="Compta"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            {submitError && (
              <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{submitError}</div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => {
                  setSelected(null)
                  setTargetGroupEmail('')
                  setTargetGroupName('')
                  setSubmitError(null)
                }}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Annuler
              </button>
              <button
                onClick={onSubmit}
                disabled={isCreating}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isCreating ? 'Création…' : 'Créer la migration'}
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Convention : <strong>même adresse</strong> sur Exchange et Google. Si le groupe
              n'existe pas, l'app le crée automatiquement (Admin SDK). Le dual delivery
              utilise l'adresse de routage Google <code>&lt;localpart&gt;@&lt;domaine&gt;.test-google-a.com</code>
              pour éviter la boucle. Active ensuite la « Collaborative Inbox » côté Google
              Groups si tu veux que les membres puissent répondre depuis l'archive.
            </p>
          </div>
        </section>
      )}

      {/* Historique */}
      <section>
        <button
          onClick={() => setHistoryExpanded((v) => !v)}
          className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-800 hover:text-gray-900"
        >
          {historyExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Historique ({migrations.length})
        </button>
        {historyExpanded && (
          <div className="space-y-3">
            {migrations.length === 0 && (
              <p className="text-sm text-gray-500">Aucune migration shared mailbox encore.</p>
            )}
            {migrations.map((m) => (
              <SharedMailboxCard key={m.id} migration={m} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
