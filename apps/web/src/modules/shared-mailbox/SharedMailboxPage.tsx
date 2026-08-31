import { useState, useMemo } from 'react'
import { Search, Mail, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { SharedMailbox } from '@dsi-app/shared'
import {
  useSharedMailboxSearch,
  useSharedMigrationHistory,
  useCreateSharedMigration,
} from './hooks/useSharedMailbox'
import { SharedMailboxCard } from './components/SharedMailboxCard'

/** Domaine de transition utilisé pour l'adresse primaire du compte Google. */
const TRANSITION_PREFIX = 'mig'

/** `compta@onela.com` → `compta@mig.onela.com` (adresse primaire du compte cible). */
function buildTargetPrimary(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return ''
  return `${local}@${TRANSITION_PREFIX}.${domain}`
}

export default function SharedMailboxPage() {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SharedMailbox | null>(null)
  const [targetUserEmail, setTargetUserEmail] = useState('')
  const [targetUserAlias, setTargetUserAlias] = useState('')
  const [targetDisplayName, setTargetDisplayName] = useState('')
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
    // Convention identique aux comptes nominatifs : l'adresse PRIMAIRE Google est
    // sur le domaine de transition (mig.onela.com), l'adresse historique de la BAL
    // devient l'alias — et l'adresse d'envoi par défaut.
    setTargetUserEmail(buildTargetPrimary(mb.email))
    setTargetUserAlias(mb.email)
    setTargetDisplayName(mb.displayName)
    setSubmitError(null)
  }

  const reset = () => {
    setSelected(null)
    setTargetUserEmail('')
    setTargetUserAlias('')
    setTargetDisplayName('')
    setSubmitError(null)
  }

  const onSubmit = () => {
    if (!selected) return
    const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)
    if (!isEmail(targetUserEmail)) {
      setSubmitError('Adresse primaire du compte Google invalide')
      return
    }
    if (!isEmail(targetUserAlias)) {
      setSubmitError('Alias invalide')
      return
    }
    if (targetUserEmail.toLowerCase() === targetUserAlias.toLowerCase()) {
      setSubmitError(
        'L’adresse primaire doit être sur le domaine de transition (mig.onela.com) et différer de l’alias.',
      )
      return
    }
    if (!targetDisplayName.trim()) {
      setSubmitError('Nom d’affichage requis')
      return
    }
    createMigration(
      {
        onelaUserId: selected.id,
        onelaUpn: selected.upn,
        onelaEmail: selected.email,
        onelaDisplayName: selected.displayName,
        targetUserEmail: targetUserEmail.trim().toLowerCase(),
        targetUserAlias: targetUserAlias.trim().toLowerCase(),
        targetDisplayName: targetDisplayName.trim(),
      },
      {
        onSuccess: () => {
          reset()
          setQuery('')
        },
        onError: (err: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const apiErr = (err as any)?.response?.data?.error
          setSubmitError(apiErr || (err instanceof Error ? err.message : 'Échec de la création'))
        },
      },
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-gray-900">Migration Shared Mailbox</h1>
        <p className="text-sm text-gray-600">
          Migre une boîte aux lettres partagée Exchange vers un <strong>compte Google classique</strong>{' '}
          (licence Business Plus), avec délégation Gmail pour les personnes du service.
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
          <h2 className="mb-3 text-sm font-semibold text-gray-800">2. Compte Google cible</h2>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Adresse primaire (domaine de transition)
              </label>
              <input
                value={targetUserEmail}
                onChange={(e) => setTargetUserEmail(e.target.value)}
                placeholder="compta@mig.onela.com"
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Alias définitif (= adresse actuelle de la BAL, et adresse d’envoi par défaut)
              </label>
              <input
                value={targetUserAlias}
                onChange={(e) => setTargetUserAlias(e.target.value)}
                placeholder="compta@onela.com"
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Nom d’affichage du compte</label>
              <input
                value={targetDisplayName}
                onChange={(e) => setTargetDisplayName(e.target.value)}
                placeholder="Comptabilité"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            {submitError && (
              <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{submitError}</div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={reset}
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
            <div className="rounded bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <p className="font-medium">Enchaînement après création :</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                <li>L’app crée le compte Google (mot de passe aléatoire — personne ne s’y connecte).</li>
                <li>
                  <strong>Tu attribues la licence Business Plus</strong> dans la console Google, puis tu
                  cliques « Licence attribuée » sur la carte.
                </li>
                <li>L’app pose l’alias + « Envoyer en tant que », importe les mails, puis les délégations.</li>
                <li>
                  Les délégués se choisissent sur la carte : pré-remplis depuis les accès FullAccess
                  Exchange, complétables par recherche dans l’annuaire Google.
                </li>
              </ol>
            </div>
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
