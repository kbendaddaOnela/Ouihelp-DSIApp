import { useEffect, useMemo, useState } from 'react'
import { UserPlus, Loader2, X, Search, Mail } from 'lucide-react'
import {
  ONELA_SERVICES,
  AGENCY_JOB_TITLES,
  HEAD_OFFICE,
  mailboxesForService,
  type AssignmentType,
  type CreateAccountRequest,
} from '@dsi-app/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  useCreateAccount,
  useSearchManagers,
  useAgencies,
  useMigratedSharedMailboxes,
  useLicenseSkus,
} from '../hooks/useAccounts'

function normalizePart(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacritiques
    .replace(/[\s_]+/g, '-') // espaces → tiret (prénoms/noms composés)
    .replace(/[^a-z-]/g, '') // ne garde que lettres et tiret
    .replace(/-+/g, '-') // tirets multiples → un seul
    .replace(/^-|-$/g, '') // pas de tiret en début/fin
}
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''
}

const labelCls = 'mb-1 block text-sm font-medium text-gray-700'
const inputCls =
  'w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500'
const roCls = inputCls + ' bg-gray-50 text-gray-500'

// ── Autocomplétion manager ────────────────────────────────────────────────────
function ManagerPicker({
  value,
  onChange,
}: {
  value: { upn: string; display: string } | null
  onChange: (v: { upn: string; display: string } | null) => void
}) {
  const [input, setInput] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 300)
    return () => clearTimeout(t)
  }, [input])

  const { data, isFetching } = useSearchManagers(debounced, debounced.length >= 2 && !value)

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-gray-300 px-3 py-2 text-sm">
        <span className="text-gray-800">
          {value.display} <span className="text-gray-400">({value.upn})</span>
        </span>
        <button type="button" onClick={() => onChange(null)} className="text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        className={inputCls}
        placeholder="Tapez le nom du manager…"
        value={input}
        onChange={(e) => {
          setInput(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        autoComplete="off"
      />
      {isFetching && <Loader2 className="absolute right-2 top-2.5 h-4 w-4 animate-spin text-gray-400" />}
      {open && debounced.length >= 2 && data && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg">
          {data.managers.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400">Aucun résultat dans Ouihelp</div>
          ) : (
            data.managers.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange({ upn: m.upn, display: m.displayName })
                  setOpen(false)
                  setInput('')
                }}
                className="block w-full px-3 py-2 text-left hover:bg-primary-50"
              >
                <div className="text-sm font-medium text-gray-800">{m.displayName}</div>
                <div className="text-xs text-gray-400">{m.upn}{m.jobTitle ? ` · ${m.jobTitle}` : ''}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function AccountForm({ onCreated }: { onCreated: () => void }) {
  const create = useCreateAccount()
  const { data: agenciesData } = useAgencies()
  const agencyList = agenciesData?.agencies ?? []
  const { data: mailboxesData } = useMigratedSharedMailboxes()
  const sharedMailboxes = useMemo(() => mailboxesData?.mailboxes ?? [], [mailboxesData])
  const { data: licenseData } = useLicenseSkus()
  const licenseSkus = useMemo(() => licenseData ?? [], [licenseData])

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [emailPrefix, setEmailPrefix] = useState('')
  const [prefixTouched, setPrefixTouched] = useState(false)
  const [assignmentType, setAssignmentType] = useState<AssignmentType | ''>('')
  const [service, setService] = useState('') // Siège
  const [agency, setAgency] = useState('') // Agence
  const [jobTitle, setJobTitle] = useState('')
  const [manager, setManager] = useState<{ upn: string; display: string } | null>(null)
  const [password, setPassword] = useState('')
  const [forceChange, setForceChange] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Délégations : adresses PRIMAIRES Google (delegateEmail) des boîtes à déléguer
  const [delegateMailboxes, setDelegateMailboxes] = useState<string[]>([])
  const [mailboxSearch, setMailboxSearch] = useState('')
  // Licence Google à attribuer (skuId ; '' = ne pas attribuer)
  const [licenseSkuId, setLicenseSkuId] = useState('')

  // Dérivés
  const displayName = useMemo(
    () => (firstName && lastName ? `${capitalize(firstName)} ${lastName.toUpperCase()}` : ''),
    [firstName, lastName],
  )
  const suggestedPrefix = useMemo(
    () => (firstName && lastName ? `${normalizePart(firstName)}.${normalizePart(lastName)}` : ''),
    [firstName, lastName],
  )
  useEffect(() => {
    if (!prefixTouched) setEmailPrefix(suggestedPrefix)
  }, [suggestedPrefix, prefixTouched])

  const agencyInfo = agency ? agencyList.find((a) => a.name === agency) : undefined
  const email = emailPrefix ? `${emailPrefix}@onela.com` : ''

  // Adresses de boîtes à pré-cocher selon l'affectation :
  //  - Agence : la boîte de l'agence (agencies.mailbox)
  //  - Siège  : les boîtes du service (SERVICE_SHARED_MAILBOXES via mailboxesForService)
  const autoMailboxAddrs = useMemo<string[]>(() => {
    if (assignmentType === 'Agence') {
      const a = agencyInfo?.mailbox?.trim().toLowerCase()
      return a ? [a] : []
    }
    if (assignmentType === 'Siège') return mailboxesForService(service).map((a) => a.toLowerCase())
    return []
  }, [assignmentType, agencyInfo, service])

  // Rapproche chaque adresse attendue des boîtes réellement migrées (donc délégables)
  const autoResolved = useMemo(
    () =>
      autoMailboxAddrs.map((addr) => ({
        addr,
        mb:
          sharedMailboxes.find(
            (m) => m.onelaEmail.toLowerCase() === addr || m.alias?.toLowerCase() === addr,
          ) ?? null,
      })),
    [autoMailboxAddrs, sharedMailboxes],
  )

  // Pré-cocher automatiquement les boîtes résolues (union — l'opérateur peut décocher)
  useEffect(() => {
    const toAdd = autoResolved.filter((x) => x.mb).map((x) => x.mb!.delegateEmail)
    if (toAdd.length > 0) {
      setDelegateMailboxes((prev) => Array.from(new Set([...prev, ...toAdd])))
    }
  }, [autoResolved])

  const toggleMailbox = (email: string) =>
    setDelegateMailboxes((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email],
    )

  const filteredMailboxes = useMemo(() => {
    const q = mailboxSearch.trim().toLowerCase()
    if (!q) return sharedMailboxes
    return sharedMailboxes.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.onelaEmail.toLowerCase().includes(q) ||
        (m.alias?.toLowerCase().includes(q) ?? false),
    )
  }, [sharedMailboxes, mailboxSearch])

  const reset = () => {
    setFirstName(''); setLastName(''); setEmailPrefix(''); setPrefixTouched(false)
    setAssignmentType(''); setService(''); setAgency(''); setJobTitle('')
    setManager(null); setPassword(''); setForceChange(true); setError(null)
    setDelegateMailboxes([]); setMailboxSearch(''); setLicenseSkuId('')
  }

  const submit = () => {
    setError(null)
    if (!firstName || !lastName) return setError('Prénom et nom requis')
    if (!emailPrefix) return setError('Préfixe email requis')
    if (!assignmentType) return setError('Type d\'affectation requis')
    if (assignmentType === 'Siège' && !service) return setError('Service requis')
    if (assignmentType === 'Agence' && !agency) return setError('Agence requise')
    if (!jobTitle) return setError('Poste requis')
    if (password.length < 8) return setError('Mot de passe : 8 caractères minimum')

    const isAgence = assignmentType === 'Agence'
    const req: CreateAccountRequest = {
      firstName,
      lastName,
      displayName,
      emailPrefix,
      emailDomain: '@onela.com',
      assignmentType,
      department: isAgence ? (agencyInfo?.trigramme ?? '') : service,
      jobTitle,
      managerUpn: manager?.upn ?? null,
      officeLocation: isAgence ? agency : HEAD_OFFICE.officeLocation,
      state: isAgence ? (agencyInfo?.region ?? null) : null,
      streetAddress: isAgence ? (agencyInfo?.address ?? null) : HEAD_OFFICE.streetAddress,
      postalCode: isAgence ? (agencyInfo?.postalCode ?? null) : HEAD_OFFICE.postalCode,
      city: isAgence ? (agencyInfo?.city ?? null) : HEAD_OFFICE.city,
      password,
      forceChangePassword: forceChange,
      delegateMailboxes,
      licenseProductId: licenseSkuId ? 'Google-Apps' : null,
      licenseSkuId: licenseSkuId || null,
    }
    create.mutate(req, {
      onSuccess: () => { reset(); onCreated() },
      onError: (e) => setError(e instanceof Error ? e.message : 'Erreur lors de la création'),
    })
  }

  const agencyNames = useMemo(() => agencyList.map((a) => a.name), [agencyList])

  return (
    <div className="space-y-6 rounded-lg border border-gray-200 bg-white p-6">
      {/* Identité */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gray-900">Identité</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Prénom *</label>
            <input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Nom *</label>
            <input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Nom d'affichage</label>
            <input className={roCls} value={displayName} readOnly />
          </div>
          <div>
            <label className={labelCls}>Email *</label>
            <div className="flex items-center gap-1">
              <input
                className={inputCls}
                value={emailPrefix}
                onChange={(e) => { setEmailPrefix(e.target.value.toLowerCase()); setPrefixTouched(true) }}
              />
              <span className="text-sm text-gray-500">@onela.com</span>
            </div>
            {email && <p className="mt-1 text-xs text-gray-400">{email}</p>}
          </div>
        </div>
      </section>

      {/* Affectation */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gray-900">Affectation</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Type *</label>
            <select
              className={inputCls}
              value={assignmentType}
              onChange={(e) => {
                setAssignmentType(e.target.value as AssignmentType | '')
                setService(''); setAgency(''); setJobTitle('')
              }}
            >
              <option value="">— Choisir —</option>
              <option value="Siège">Siège</option>
              <option value="Agence">Agence</option>
            </select>
          </div>

          {assignmentType === 'Siège' && (
            <>
              <div>
                <label className={labelCls}>Service *</label>
                <select className={inputCls} value={service} onChange={(e) => setService(e.target.value)}>
                  <option value="">— Choisir —</option>
                  {ONELA_SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Poste *</label>
                <input className={inputCls} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
              </div>
            </>
          )}

          {assignmentType === 'Agence' && (
            <>
              <div>
                <label className={labelCls}>Agence *</label>
                <select className={inputCls} value={agency} onChange={(e) => setAgency(e.target.value)}>
                  <option value="">— Choisir une agence —</option>
                  {agencyNames.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Poste *</label>
                <select className={inputCls} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)}>
                  <option value="">— Choisir —</option>
                  {AGENCY_JOB_TITLES.map((j) => <option key={j} value={j}>{j}</option>)}
                </select>
              </div>
              {agencyInfo && (
                <div className="sm:col-span-2 grid grid-cols-2 gap-4 rounded-md bg-gray-50 p-3 text-xs text-gray-600 sm:grid-cols-4">
                  <div><span className="text-gray-400">Trigramme</span><br /><span className="font-medium text-gray-800">{agencyInfo.trigramme}</span></div>
                  <div><span className="text-gray-400">Région</span><br /><span className="font-medium text-gray-800">{agencyInfo.region}</span></div>
                  <div className="col-span-2"><span className="text-gray-400">Adresse</span><br /><span className="font-medium text-gray-800">{agencyInfo.address}</span></div>
                  <div><span className="text-gray-400">CP</span><br /><span className="font-medium text-gray-800">{agencyInfo.postalCode}</span></div>
                  <div><span className="text-gray-400">Ville</span><br /><span className="font-medium text-gray-800">{agencyInfo.city}</span></div>
                </div>
              )}
            </>
          )}

          <div className="sm:col-span-2">
            <label className={labelCls}>Manager (optionnel)</label>
            <ManagerPicker value={manager} onChange={setManager} />
          </div>
        </div>
      </section>

      {/* Délégations boîtes partagées */}
      <section>
        <h3 className="mb-1 text-sm font-semibold text-gray-900">Boîtes partagées à déléguer</h3>
        <p className="mb-3 text-xs text-gray-500">
          Le nouvel arrivant recevra la délégation Gmail sur les boîtes sélectionnées, une fois son
          compte Google créé. Seules les boîtes déjà migrées (mode compte) sont proposées.
        </p>

        {/* Notes de pré-sélection (boîte agence ou boîtes du service) */}
        {autoResolved.filter((x) => x.mb).length > 0 && (
          <p className="mb-2 flex items-start gap-1.5 rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
            <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Pré-cochée{autoResolved.filter((x) => x.mb).length > 1 ? 's' : ''} ({assignmentType === 'Agence' ? "boîte de l'agence" : 'boîtes du service'}) :{' '}
              <span className="font-medium">{autoResolved.filter((x) => x.mb).map((x) => x.mb!.onelaEmail).join(', ')}</span>
            </span>
          </p>
        )}
        {autoResolved.filter((x) => !x.mb).length > 0 && (
          <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Non encore migrée{autoResolved.filter((x) => !x.mb).length > 1 ? 's' : ''} (délégation impossible pour le moment) :{' '}
            <span className="font-medium">{autoResolved.filter((x) => !x.mb).map((x) => x.addr).join(', ')}</span>
          </p>
        )}
        {assignmentType === 'Agence' && agencyInfo && !agencyInfo.mailbox && (
          <p className="mb-2 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
            Aucune boîte partagée renseignée pour cette agence (à définir dans « Gérer les agences »).
          </p>
        )}

        {/* Chips des boîtes sélectionnées */}
        {delegateMailboxes.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {delegateMailboxes.map((email) => {
              const mb = sharedMailboxes.find((m) => m.delegateEmail === email)
              return (
                <span
                  key={email}
                  className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2.5 py-1 text-xs text-primary-700"
                >
                  {mb ? mb.onelaEmail : email}
                  <button type="button" onClick={() => toggleMailbox(email)} className="text-primary-400 hover:text-primary-700">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )
            })}
          </div>
        )}

        {sharedMailboxes.length === 0 ? (
          <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
            Aucune boîte partagée migrée disponible.
          </p>
        ) : (
          <div className="rounded-md border border-gray-200">
            <div className="relative border-b border-gray-100">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
              <input
                className="w-full rounded-t-md border-0 py-2 pl-8 pr-3 text-sm focus:outline-none focus:ring-0"
                placeholder="Rechercher une boîte partagée…"
                value={mailboxSearch}
                onChange={(e) => setMailboxSearch(e.target.value)}
              />
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filteredMailboxes.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-400">Aucun résultat.</p>
              ) : (
                filteredMailboxes.map((m) => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={delegateMailboxes.includes(m.delegateEmail)}
                      onChange={() => toggleMailbox(m.delegateEmail)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-gray-800">{m.displayName}</span>{' '}
                      <span className="text-gray-400">· {m.onelaEmail}</span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
      </section>

      {/* Licence Google */}
      <section>
        <h3 className="mb-1 text-sm font-semibold text-gray-900">Licence Google</h3>
        <p className="mb-3 text-xs text-gray-500">
          L'attribution automatique via l'OU n'étant plus active, choisis la licence à attribuer au
          compte dès sa remontée dans Google (nécessaire pour activer Gmail). Laisse « Aucune » pour
          l'attribuer plus tard.
        </p>
        <div className="sm:w-1/2">
          <select className={inputCls} value={licenseSkuId} onChange={(e) => setLicenseSkuId(e.target.value)}>
            <option value="">— Aucune (ne pas attribuer) —</option>
            {licenseSkus.map((s) => (
              <option key={s.skuId} value={s.skuId}>
                {s.name}
                {s.remaining != null ? ` — ${s.remaining} dispo` : s.total != null ? ` — ${s.total - s.used} dispo` : ''}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Sécurité */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gray-900">Sécurité</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Mot de passe initial *</label>
            <input type="text" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 8 caractères" />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-gray-700">
            <input type="checkbox" checked={forceChange} onChange={(e) => setForceChange(e.target.checked)} />
            Forcer le changement au premier login
          </label>
        </div>
      </section>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex gap-2">
        <Button onClick={submit} disabled={create.isPending}>
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          Créer le compte
        </Button>
        <Button variant="outline" onClick={reset} disabled={create.isPending}>Réinitialiser</Button>
      </div>
    </div>
  )
}
