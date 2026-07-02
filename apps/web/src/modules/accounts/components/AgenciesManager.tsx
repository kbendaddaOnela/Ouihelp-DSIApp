import { useMemo, useState } from 'react'
import { Search, Pencil, Trash2, Plus, Check, X, Loader2 } from 'lucide-react'
import { ONELA_REGIONS, type Agency, type AgencyInput } from '@dsi-app/shared'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAgencies, useCreateAgency, useUpdateAgency, useDeleteAgency } from '../hooks/useAccounts'

const inputCls =
  'w-full rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500'

const EMPTY: AgencyInput = { name: '', trigramme: '', region: ONELA_REGIONS[0] ?? '', address: '', postalCode: '', city: '' }

function EditRow({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: AgencyInput
  onSave: (v: AgencyInput) => void
  onCancel: () => void
  saving: boolean
}) {
  const [v, setV] = useState<AgencyInput>(initial)
  const set = (k: keyof AgencyInput, val: string) => setV((p) => ({ ...p, [k]: val }))
  const valid = Object.values(v).every((x) => x.trim() !== '')
  return (
    <tr className="bg-primary-50/40">
      <td className="p-1"><input className={inputCls} value={v.name} onChange={(e) => set('name', e.target.value)} placeholder="Nom" /></td>
      <td className="p-1"><input className={inputCls} value={v.trigramme} onChange={(e) => set('trigramme', e.target.value.toUpperCase())} placeholder="TRI" /></td>
      <td className="p-1">
        <select className={inputCls} value={v.region} onChange={(e) => set('region', e.target.value)}>
          {ONELA_REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </td>
      <td className="p-1"><input className={inputCls} value={v.address} onChange={(e) => set('address', e.target.value)} placeholder="Adresse" /></td>
      <td className="p-1"><input className={inputCls} value={v.postalCode} onChange={(e) => set('postalCode', e.target.value)} placeholder="CP" /></td>
      <td className="p-1"><input className={inputCls} value={v.city} onChange={(e) => set('city', e.target.value)} placeholder="Ville" /></td>
      <td className="p-1 whitespace-nowrap">
        <button
          className="mr-1 inline-flex items-center rounded p-1 text-green-600 hover:bg-green-50 disabled:opacity-40"
          onClick={() => valid && onSave(v)}
          disabled={!valid || saving}
          title="Enregistrer"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        </button>
        <button className="inline-flex items-center rounded p-1 text-gray-500 hover:bg-gray-100" onClick={onCancel} title="Annuler">
          <X className="h-4 w-4" />
        </button>
      </td>
    </tr>
  )
}

export function AgenciesManager() {
  const { data, isLoading } = useAgencies()
  const createAgency = useCreateAgency()
  const updateAgency = useUpdateAgency()
  const deleteAgency = useDeleteAgency()

  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const agencies = data?.agencies ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return agencies
    return agencies.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.trigramme.toLowerCase().includes(q) ||
        a.region.toLowerCase().includes(q) ||
        a.city.toLowerCase().includes(q),
    )
  }, [agencies, search])

  const toInput = (a: Agency): AgencyInput => ({
    name: a.name, trigramme: a.trigramme, region: a.region, address: a.address, postalCode: a.postalCode, city: a.city,
  })

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
          <input
            className={inputCls + ' pl-8'}
            placeholder="Rechercher (nom, trigramme, région, ville)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => { setAdding(true); setEditingId(null) }} disabled={adding}>
          <Plus className="h-4 w-4" /> Ajouter une agence
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-md border border-gray-100">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="p-2 font-medium">Agence</th>
                <th className="p-2 font-medium">Trigramme</th>
                <th className="p-2 font-medium">Région</th>
                <th className="p-2 font-medium">Adresse</th>
                <th className="p-2 font-medium">CP</th>
                <th className="p-2 font-medium">Ville</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {adding && (
                <EditRow
                  initial={EMPTY}
                  saving={createAgency.isPending}
                  onCancel={() => setAdding(false)}
                  onSave={(v) => createAgency.mutate(v, { onSuccess: () => setAdding(false) })}
                />
              )}
              {filtered.map((a) =>
                editingId === a.id ? (
                  <EditRow
                    key={a.id}
                    initial={toInput(a)}
                    saving={updateAgency.isPending}
                    onCancel={() => setEditingId(null)}
                    onSave={(v) => updateAgency.mutate({ id: a.id, input: v }, { onSuccess: () => setEditingId(null) })}
                  />
                ) : (
                  <tr key={a.id} className="hover:bg-gray-50">
                    <td className="p-2 font-medium text-gray-800">{a.name}</td>
                    <td className="p-2 text-gray-600">{a.trigramme}</td>
                    <td className="p-2 text-gray-600">{a.region}</td>
                    <td className="p-2 text-gray-600">{a.address}</td>
                    <td className="p-2 text-gray-600">{a.postalCode}</td>
                    <td className="p-2 text-gray-600">{a.city}</td>
                    <td className="p-2 whitespace-nowrap">
                      <button className="mr-1 inline-flex rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-primary-600" onClick={() => { setEditingId(a.id); setAdding(false) }} title="Modifier">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        className="inline-flex rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        onClick={() => { if (window.confirm(`Supprimer l'agence « ${a.name} » ?`)) deleteAgency.mutate(a.id) }}
                        title="Supprimer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ),
              )}
              {filtered.length === 0 && !adding && (
                <tr><td colSpan={7} className="p-6 text-center text-gray-400">Aucune agence.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-400">
        {agencies.length} agences. Les modifications sont utilisées immédiatement par le formulaire de création.
      </p>
    </div>
  )
}
