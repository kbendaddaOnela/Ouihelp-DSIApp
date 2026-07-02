import { useState } from 'react'
import { UserPlus, Plus, Info } from 'lucide-react'
import { usePermission } from '@/hooks/usePermission'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAccountsHistory } from './hooks/useAccounts'
import { AccountForm } from './components/AccountForm'
import { AccountCard } from './components/AccountCard'

export default function AccountsPage() {
  const canWrite = usePermission('accounts:write')
  const [showForm, setShowForm] = useState(false)
  const { data, isLoading } = useAccountsHistory()

  return (
    <div className="mx-auto max-w-5xl space-y-6 py-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50">
            <UserPlus className="h-5 w-5 text-primary-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Création de comptes</h1>
            <p className="text-sm text-gray-500">Onboarding d'un nouvel arrivant ONELA</p>
          </div>
        </div>
        {canWrite && (
          <Button onClick={() => setShowForm((s) => !s)} variant={showForm ? 'outline' : 'default'}>
            <Plus className="h-4 w-4" />
            {showForm ? 'Fermer' : 'Nouveau compte'}
          </Button>
        )}
      </div>

      {/* Rappel du flux */}
      <div className="flex gap-2 rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-xs text-blue-900">
        <Info className="h-4 w-4 shrink-0 text-blue-500" />
        <p>
          Le compte est créé sur Ouihelp (<code>prenom.nom@mig.onela.com</code>) puis remonte dans Google via SCIM
          (5–40 min) où il bascule automatiquement sur l'OU <code>/onela.com</code> avec l'alias
          <code> prenom.nom@onela.com</code>. Un objet de routage léger (MailUser) est créé sur Exchange ONELA pour
          que le courrier entrant <code>@onela.com</code> soit redirigé vers Google — sans licence M365 ni mailbox.
        </p>
      </div>

      {showForm && canWrite && <AccountForm onCreated={() => setShowForm(false)} />}

      {/* Historique */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">Comptes récents</h2>
        {isLoading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : !data || data.accounts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-200 py-10 text-center text-sm text-gray-400">
            Aucun compte créé pour l'instant.
          </p>
        ) : (
          data.accounts.map((a) => <AccountCard key={a.id} account={a} />)
        )}
      </div>
    </div>
  )
}
