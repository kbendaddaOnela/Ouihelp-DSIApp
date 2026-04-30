import { Link } from 'react-router-dom'
import {
  UserPlus,
  Monitor,
  AppWindow,
  KeyRound,
  Wallet,
  Users,
  Laptop,
  FileCheck,
  Euro,
} from 'lucide-react'
import type { Permission } from '@dsi-app/shared'
import { useAnyPermission } from '@/hooks/usePermission'
import { useAuthStore } from '@/store/authStore'
import { cn } from '@/lib/utils'

interface ModuleCard {
  path: string
  label: string
  description: string
  icon: React.ElementType
  requiredPermissions: Permission[]
}

const MODULES: ModuleCard[] = [
  {
    path: '/accounts',
    label: 'Création de comptes',
    description: 'Provisionner un nouveau collaborateur sur Entra ID (SCIM vers Google & Slack).',
    icon: UserPlus,
    requiredPermissions: ['accounts:read'],
  },
  {
    path: '/inventory',
    label: 'Inventaire matériel',
    description: 'Parc de postes de travail, téléphones et périphériques.',
    icon: Monitor,
    requiredPermissions: ['inventory:read'],
  },
  {
    path: '/apps',
    label: 'Inventaire applicatif',
    description: 'Applications SaaS en usage et leurs propriétaires.',
    icon: AppWindow,
    requiredPermissions: ['apps-inventory:read'],
  },
  {
    path: '/licenses',
    label: 'Licences',
    description: 'Suivi des licences logicielles et renouvellements.',
    icon: KeyRound,
    requiredPermissions: ['licenses:read'],
  },
  {
    path: '/budget',
    label: 'Budget & Facturation',
    description: 'Dépenses IT consolidées et prévisionnel annuel.',
    icon: Wallet,
    requiredPermissions: ['budget:read'],
  },
]

interface StatCard {
  label: string
  icon: React.ElementType
}

const STATS: StatCard[] = [
  { label: 'Utilisateurs actifs', icon: Users },
  { label: 'Postes actifs', icon: Laptop },
  { label: 'Licences en cours', icon: FileCheck },
  { label: 'Dépenses IT (mois)', icon: Euro },
]

const ModuleTile = ({ module }: { module: ModuleCard }) => {
  const hasAccess = useAnyPermission(module.requiredPermissions)
  const Icon = module.icon

  const content = (
    <>
      <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-50">
        <Icon className="h-5 w-5 text-primary-600" />
      </div>
      <div className="mt-4">
        <h3 className="text-sm font-semibold text-gray-900">{module.label}</h3>
        <p className="mt-1 text-xs text-gray-500">{module.description}</p>
      </div>
    </>
  )

  if (!hasAccess) {
    return (
      <div
        className="rounded-xl border border-gray-200 bg-white p-5 opacity-50"
        title="Vous n'avez pas accès à ce module"
      >
        {content}
        <p className="mt-3 text-xs font-medium text-gray-400">Accès restreint</p>
      </div>
    )
  }

  return (
    <Link
      to={module.path}
      className={cn(
        'group block rounded-xl border border-gray-200 bg-white p-5 transition-all',
        'hover:border-primary-300 hover:shadow-md'
      )}
    >
      {content}
    </Link>
  )
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user)
  const firstName = user?.name?.split(' ')[0] ?? ''

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">
          Bonjour{firstName ? ` ${firstName}` : ''} 👋
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Aperçu de votre portail IT. Choisissez un module pour commencer.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Vue d'ensemble
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {STATS.map((stat) => {
            const Icon = stat.icon
            return (
              <div
                key={stat.label}
                className="rounded-xl border border-gray-200 bg-white p-4"
              >
                <div className="flex items-center justify-between">
                  <Icon className="h-4 w-4 text-gray-400" />
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                    Bientôt
                  </span>
                </div>
                <p className="mt-3 text-2xl font-semibold text-gray-300">—</p>
                <p className="mt-1 text-xs text-gray-500">{stat.label}</p>
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Modules
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <ModuleTile key={m.path} module={m} />
          ))}
        </div>
      </section>
    </div>
  )
}
