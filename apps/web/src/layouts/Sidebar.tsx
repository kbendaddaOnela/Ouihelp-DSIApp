import { NavLink, Link } from 'react-router-dom'
import {
  UserPlus,
  Monitor,
  AppWindow,
  KeyRound,
  Wallet,
  ChevronLeft,
  ChevronRight,
  Building2,
  ArrowRightLeft,
  Mail,
  HardDriveDownload,
  Network,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAnyPermission } from '@/hooks/usePermission'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import type { Permission } from '@dsi-app/shared'

interface NavItem {
  path: string
  label: string
  icon: React.ElementType
  requiredPermissions: Permission[]
}

const NAV_ITEMS: NavItem[] = [
  {
    path: '/migration',
    label: 'Migration ONELA',
    icon: ArrowRightLeft,
    requiredPermissions: ['migration:read'],
  },
  {
    path: '/shared-mailbox',
    label: 'Migration Shared Mailbox',
    icon: Mail,
    requiredPermissions: ['migration:read'],
  },
  {
    path: '/sharepoint-migration',
    label: 'Migration SharePoint',
    icon: HardDriveDownload,
    requiredPermissions: ['migration:read'],
  },
  {
    path: '/sharepoint-ximi',
    label: 'Migration SharePoint Ximi',
    icon: Network,
    requiredPermissions: ['migration:read'],
  },
  {
    path: '/accounts',
    label: 'Création de comptes',
    icon: UserPlus,
    requiredPermissions: ['accounts:read'],
  },
  {
    path: '/inventory',
    label: 'Inventaire matériel',
    icon: Monitor,
    requiredPermissions: ['inventory:read'],
  },
  {
    path: '/apps',
    label: 'Inventaire applicatif',
    icon: AppWindow,
    requiredPermissions: ['apps-inventory:read'],
  },
  {
    path: '/licenses',
    label: 'Licences',
    icon: KeyRound,
    requiredPermissions: ['licenses:read'],
  },
  {
    path: '/budget',
    label: 'Budget & Facturation',
    icon: Wallet,
    requiredPermissions: ['budget:read'],
  },
]

interface NavItemProps extends NavItem {
  collapsed: boolean
  onNavigate: () => void
}

const SidebarNavItem = ({ path, label, icon: Icon, requiredPermissions, collapsed, onNavigate }: NavItemProps) => {
  const hasAccess = useAnyPermission(requiredPermissions)
  if (!hasAccess) return null

  return (
    <NavLink
      to={path}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all',
          'hover:bg-primary-50 hover:text-primary-700',
          isActive ? 'bg-primary-50 text-primary-700' : 'text-gray-700',
          collapsed && 'justify-center px-2'
        )
      }
      title={collapsed ? label : undefined}
    >
      <Icon className="h-5 w-5 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  )
}

export const Sidebar = ({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) => {
  // Replié/déplié persisté : le réglage se perdait à chaque rechargement.
  const [collapsed, setCollapsed] = useLocalStorage('dsi-app.sidebar-collapsed', false)

  return (
    <>
      {/* Voile mobile — la sidebar est un tiroir hors écran sous lg */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-gray-900/40 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          'z-40 flex h-screen shrink-0 flex-col border-r border-gray-200 bg-white transition-all duration-300',
          'fixed inset-y-0 left-0 lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          collapsed ? 'w-16' : 'w-64'
        )}
      >
      {/* Logo / App name */}
      <Link to="/" onClick={onClose} className={cn('flex items-center gap-3 border-b border-gray-200 px-4 py-5 hover:bg-gray-50 transition-colors', collapsed && 'justify-center px-2')}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-600">
          <Building2 className="h-5 w-5 text-white" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-gray-900">DSI App</p>
            <p className="truncate text-xs text-gray-500">ONELA</p>
          </div>
        )}
      </Link>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => (
          <SidebarNavItem key={item.path} {...item} collapsed={collapsed} onNavigate={onClose} />
        ))}
      </nav>

      {/* Bouton collapse — sans objet sur mobile où la sidebar est un tiroir */}
      <div className="hidden border-t border-gray-200 p-3 lg:block">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors',
            collapsed && 'justify-center px-2'
          )}
          aria-label={collapsed ? 'Déplier la sidebar' : 'Replier la sidebar'}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!collapsed && <span>Réduire</span>}
        </button>
      </div>
      </aside>
    </>
  )
}
