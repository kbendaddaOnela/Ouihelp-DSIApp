import { useAuthStore } from '@/store/authStore'
import { hasPermission, type Permission } from '@dsi-app/shared'

// Vérifie si l'utilisateur courant possède une permission donnée
// Toujours coupler avec la vérification côté API (middleware RBAC)
export function usePermission(permission: Permission): boolean {
  const role = useAuthStore((state) => state.role)
  if (!role) return false
  return hasPermission(role, permission)
}

// Vérifie plusieurs permissions à la fois (toutes requises)
export function usePermissions(permissions: Permission[]): boolean {
  const role = useAuthStore((state) => state.role)
  if (!role) return false
  return permissions.every((p) => hasPermission(role, p))
}

// Vérifie si l'utilisateur a au moins une des permissions
export function useAnyPermission(permissions: Permission[]): boolean {
  const role = useAuthStore((state) => state.role)
  if (!role) return false
  return permissions.some((p) => hasPermission(role, p))
}
