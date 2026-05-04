import { Link } from 'react-router-dom'
import {
  ArrowRightLeft,
  UserPlus,
  Monitor,
  AppWindow,
  KeyRound,
  Wallet,
  Users,
  Laptop,
  FileCheck,
  Euro,
  RefreshCw,
} from 'lucide-react'
import type { Permission } from '@dsi-app/shared'
import { useAnyPermission } from '@/hooks/usePermission'
import { useAuthStore } from '@/store/authStore'
import { cn } from '@/lib/utils'
import { useInventoryStats, useInventorySync } from '@/modules/inventory/hooks'

interface ModuleCard {
  path: string
  label: string
  description: string
  icon: React.ElementType
  requiredPermissions: Permission[]
}

const MODULES: ModuleCard[] = [
  {
    path: '/migration',
    label: 'Migration ONELA',
    description: 'Migrer les comptes Exchange / Google Workspace ONELA vers GOH.',
    icon: ArrowRightLeft,
    requiredPermissions: ['migration:read'],
  },
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
      <div className="rounded-xl border border-gray-200 bg-white p-5 opacity-50" title="Vous n'avez pas accès à ce module">
        {content}
        <p className="mt-3 text-xs font-medium text-gray-400">Accès restreint</p>
      </div>
    )
  }

  return (
    <Link to={module.path} className={cn('group block rounded-xl border border-gray-200 bg-white p-5 transition-all', 'hover:border-primary-300 hover:shadow-md')}>
      {content}
    </Link>
  )
}

// ── Cartes stats ──────────────────────────────────────────────────────────────
function StatCards() {
  const { data: stats, isFetching } = useInventoryStats()
  const { mutate: triggerSync, isPending: isSyncing } = useInventorySync()

  const userTotal = stats?.userCounts.reduce((s, r) => s + Number(r.count), 0) ?? null
  const deviceTotal = stats?.deviceCounts.reduce((s, r) => s + Number(r.count), 0) ?? null
  const lastSync = stats?.status?.lastSyncAt ? new Date(stats.status.lastSyncAt) : null
  const syncRunning = stats?.status?.status === 'running' || isSyncing

  const formatLastSync = (d: Date) => {
    const diff = Math.round((Date.now() - d.getTime()) / 60000)
    if (diff < 1) return 'à l\'instant'
    if (diff < 60) return `il y a ${diff} min`
    if (diff < 1440) return `il y a ${Math.round(diff / 60)}h`
    return `il y a ${Math.round(diff / 1440)}j`
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Vue d'ensemble</h2>
        <div className="flex items-center gap-2">
          {lastSync && <span className="text-[10px] text-gray-400">Sync {formatLastSync(lastSync)}</span>}
          <button
            onClick={() => triggerSync()}
            disabled={syncRunning || isFetching}
            title="Synchroniser les données"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-40"
          >
            <RefreshCw className={cn('h-3 w-3', syncRunning && 'animate-spin')} />
            {syncRunning ? 'Sync…' : 'Synchroniser'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {/* Utilisateurs actifs — clique → /inventory */}
        <Link to="/inventory?tab=users" className="group rounded-xl border border-gray-200 bg-white p-4 transition-all hover:border-primary-300 hover:shadow-sm">
          <div className="flex items-center justify-between">
            <Users className="h-4 w-4 text-gray-400 group-hover:text-primary-500" />
            {userTotal === null && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Sync requis</span>}
          </div>
          {userTotal !== null ? (
            <>
              <p className="mt-3 text-2xl font-semibold text-gray-900">{userTotal.toLocaleString()}</p>
              <p className="mt-1 text-xs text-gray-500">Utilisateurs actifs</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {stats!.userCounts.map((r) => (
                  <span key={r.source} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                    {r.source} {Number(r.count)}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-2xl font-semibold text-gray-300">—</p>
              <p className="mt-1 text-xs text-gray-500">Utilisateurs actifs</p>
            </>
          )}
        </Link>

        {/* Postes actifs — clique → /inventory */}
        <Link to="/inventory?tab=devices" className="group rounded-xl border border-gray-200 bg-white p-4 transition-all hover:border-primary-300 hover:shadow-sm">
          <div className="flex items-center justify-between">
            <Laptop className="h-4 w-4 text-gray-400 group-hover:text-primary-500" />
            {deviceTotal === null && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Sync requis</span>}
          </div>
          {deviceTotal !== null ? (
            <>
              <p className="mt-3 text-2xl font-semibold text-gray-900">{deviceTotal.toLocaleString()}</p>
              <p className="mt-1 text-xs text-gray-500">Postes actifs</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {stats!.deviceCounts.map((r) => (
                  <span key={r.source} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                    {r.source} {Number(r.count)}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-2xl font-semibold text-gray-300">—</p>
              <p className="mt-1 text-xs text-gray-500">Postes actifs</p>
            </>
          )}
        </Link>

        {/* Licences — bientôt */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <FileCheck className="h-4 w-4 text-gray-400" />
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Bientôt</span>
          </div>
          <p className="mt-3 text-2xl font-semibold text-gray-300">—</p>
          <p className="mt-1 text-xs text-gray-500">Licences en cours</p>
        </div>

        {/* Budget — bientôt */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <Euro className="h-4 w-4 text-gray-400" />
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Bientôt</span>
          </div>
          <p className="mt-3 text-2xl font-semibold text-gray-300">—</p>
          <p className="mt-1 text-xs text-gray-500">Dépenses IT (mois)</p>
        </div>
      </div>
    </div>
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
        <StatCards />
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Modules</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <ModuleTile key={m.path} module={m} />
          ))}
        </div>
      </section>
    </div>
  )
}
