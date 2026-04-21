import { KeyRound } from 'lucide-react'

// Module Gestion des licences — Phase 2
export default function LicensesPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">
        <KeyRound className="h-7 w-7 text-primary-600" />
      </div>
      <h1 className="text-xl font-semibold text-gray-900">Gestion des licences</h1>
      <p className="max-w-sm text-sm text-gray-500">
        Module en cours de développement — Phase 2 du plan de développement.
      </p>
    </div>
  )
}
