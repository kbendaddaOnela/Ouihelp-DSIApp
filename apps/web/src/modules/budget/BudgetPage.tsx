import { Wallet } from 'lucide-react'
import { usePermission } from '@/hooks/usePermission'

// Module Budget & Facturation — Phase 4 — admin uniquement
export default function BudgetPage() {
  const canAccess = usePermission('budget:read')

  if (!canAccess) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
        <p className="text-4xl">🔒</p>
        <h1 className="text-xl font-semibold text-gray-900">Accès restreint</h1>
        <p className="max-w-sm text-sm text-gray-500">
          Ce module est réservé aux administrateurs DSI.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">
        <Wallet className="h-7 w-7 text-primary-600" />
      </div>
      <h1 className="text-xl font-semibold text-gray-900">Budget & Facturation</h1>
      <p className="max-w-sm text-sm text-gray-500">
        Module en cours de développement — Phase 4 du plan de développement.
      </p>
    </div>
  )
}
