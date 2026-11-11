import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import {
  UserPlus,
  UserMinus,
  Monitor,
  AppWindow,
  KeyRound,
  Wallet,
  ArrowRightLeft,
  Mail,
  HardDriveDownload,
  Network,
  Laptop,
  Ticket,
  type LucideIcon,
} from 'lucide-react'
import type { Permission } from '@dsi-app/shared'

/**
 * Registre unique des pages de l'application. Le routeur (App), le menu
 * (Sidebar) et le fil d'Ariane (Header) en dérivent tous les trois : ajouter une
 * page = ajouter UNE entrée ici. Auparavant chaque fichier tenait sa propre
 * liste, et une page ajoutée au menu pouvait rester sans libellé dans l'en-tête.
 */
export interface AppRoute {
  /** Segment d'URL, sans « / » initial (ex. `shared-mailbox`). */
  path: string
  /** Libellé du menu et du fil d'Ariane. */
  label: string
  icon: LucideIcon
  /** Le menu affiche l'entrée si l'utilisateur possède au moins une de ces permissions. */
  requiredPermissions: Permission[]
  /** false = page accessible par URL mais absente du menu. */
  inNav: boolean
  /** Page chargée à la demande (un fichier JS par page). */
  component: LazyExoticComponent<ComponentType>
}

// L'ordre du tableau est l'ordre du menu.
export const APP_ROUTES: AppRoute[] = [
  {
    path: 'migration',
    label: 'Migration ONELA',
    icon: ArrowRightLeft,
    requiredPermissions: ['migration:read'],
    inNav: true,
    component: lazy(() => import('@/modules/migration/MigrationPage')),
  },
  {
    path: 'shared-mailbox',
    label: 'Migration Shared Mailbox',
    icon: Mail,
    requiredPermissions: ['migration:read'],
    inNav: true,
    component: lazy(() => import('@/modules/shared-mailbox/SharedMailboxPage')),
  },
  {
    path: 'sharepoint-migration',
    label: 'Migration SharePoint',
    icon: HardDriveDownload,
    requiredPermissions: ['migration:read'],
    inNav: true,
    component: lazy(() => import('@/modules/sharepoint-migration/SharepointMigrationPage')),
  },
  {
    path: 'sharepoint-ximi',
    label: 'Migration SharePoint Ximi',
    icon: Network,
    requiredPermissions: ['migration:read'],
    inNav: true,
    component: lazy(() => import('@/modules/sharepoint-ximi/XimiMigrationPage')),
  },
  {
    path: 'device-migration',
    label: 'Migration des postes',
    icon: Laptop,
    requiredPermissions: ['migration:read'],
    inNav: true,
    component: lazy(() => import('@/modules/device-migration/DeviceMigrationPage')),
  },
  {
    path: 'accounts',
    label: 'Création de comptes',
    icon: UserPlus,
    requiredPermissions: ['accounts:read'],
    inNav: true,
    component: lazy(() => import('@/modules/accounts/AccountsPage')),
  },
  {
    path: 'offboarding',
    label: 'Offboarding',
    icon: UserMinus,
    requiredPermissions: ['offboarding:read'],
    inNav: true,
    component: lazy(() => import('@/modules/offboarding/OffboardingPage')),
  },
  {
    path: 'inventory',
    label: 'Inventaire matériel',
    icon: Monitor,
    requiredPermissions: ['inventory:read'],
    inNav: true,
    component: lazy(() => import('@/modules/inventory/InventoryPage')),
  },
  {
    path: 'apps',
    label: 'Inventaire applicatif',
    icon: AppWindow,
    requiredPermissions: ['apps-inventory:read'],
    inNav: true,
    component: lazy(() => import('@/modules/apps-inventory/AppsInventoryPage')),
  },
  {
    path: 'licenses',
    label: 'Licences',
    icon: KeyRound,
    requiredPermissions: ['licenses:read'],
    inNav: true,
    component: lazy(() => import('@/modules/licenses/LicensesPage')),
  },
  {
    path: 'budget',
    label: 'Budget & Facturation',
    icon: Wallet,
    requiredPermissions: ['budget:read'],
    inNav: true,
    component: lazy(() => import('@/modules/budget/BudgetPage')),
  },
  // Page d'attente, accessible par URL seulement (comme avant).
  {
    path: 'tickets',
    label: 'Ticketing',
    icon: Ticket,
    requiredPermissions: ['tickets:read:own', 'tickets:read:all'],
    inNav: false,
    component: lazy(() => import('@/modules/ticketing/TicketingPage')),
  },
]

/** Libellé du fil d'Ariane pour le premier segment d'URL (undefined si inconnu). */
export function routeLabel(segment: string): string | undefined {
  return APP_ROUTES.find((r) => r.path === segment)?.label
}
