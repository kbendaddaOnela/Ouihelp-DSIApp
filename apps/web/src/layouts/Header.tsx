import { useLocation } from 'react-router-dom'
import { LogOut, Moon, Sun } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Libellés des routes pour le breadcrumb
const ROUTE_LABELS: Record<string, string> = {
  tickets: 'Ticketing',
  accounts: 'Création de comptes',
  inventory: 'Inventaire matériel',
  apps: 'Inventaire applicatif',
  licenses: 'Licences',
  budget: 'Budget & Facturation',
}

const ROLE_LABELS = {
  admin: 'Admin',
  it_team: 'Équipe IT',
  collaborator: 'Collaborateur',
} as const

export const Header = () => {
  const { user, role, logout } = useAuth()
  const { pathname } = useLocation()

  const segments = pathname.split('/').filter(Boolean)
  const currentLabel = segments[0] ? (ROUTE_LABELS[segments[0]] ?? segments[0]) : 'Tableau de bord'

  const initials = user?.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  return (
    <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-400">DSI App</span>
        <span className="text-gray-300">/</span>
        <span className="font-medium text-gray-900">{currentLabel}</span>
      </div>

      {/* Actions utilisateur */}
      <div className="flex items-center gap-3">
        {role && (
          <Badge variant="secondary" className="hidden sm:inline-flex">
            {ROLE_LABELS[role]}
          </Badge>
        )}

        {/* Avatar */}
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold',
              'bg-primary-100 text-primary-700'
            )}
            title={user?.name}
          >
            {initials ?? '?'}
          </div>
          <span className="hidden text-sm font-medium text-gray-700 md:block">{user?.name}</span>
        </div>

        {/* Déconnexion */}
        <button
          onClick={() => void logout()}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          aria-label="Se déconnecter"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:block">Déconnexion</span>
        </button>
      </div>
    </header>
  )
}
