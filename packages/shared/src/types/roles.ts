// Rôles applicatifs — stockés en base, indépendants du tenant Microsoft
export type Role = 'admin' | 'it_team' | 'collaborator'

// Permissions granulaires par fonctionnalité
export type Permission =
  | 'tickets:create'
  | 'tickets:read:own'
  | 'tickets:read:all'
  | 'tickets:write:all'
  | 'tickets:assign'
  | 'accounts:read'
  | 'accounts:write'
  | 'inventory:read'
  | 'inventory:write'
  | 'apps-inventory:read'
  | 'apps-inventory:write'
  | 'licenses:read'
  | 'licenses:write'
  | 'budget:read'
  | 'budget:write'
  | 'users:manage'

// Matrice des permissions par rôle
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  collaborator: ['tickets:create', 'tickets:read:own'],
  it_team: [
    'tickets:create',
    'tickets:read:own',
    'tickets:read:all',
    'tickets:write:all',
    'tickets:assign',
    'accounts:read',
    'accounts:write',
    'inventory:read',
    'inventory:write',
    'apps-inventory:read',
    'apps-inventory:write',
    'licenses:read',
    'licenses:write',
  ],
  admin: [
    'tickets:create',
    'tickets:read:own',
    'tickets:read:all',
    'tickets:write:all',
    'tickets:assign',
    'accounts:read',
    'accounts:write',
    'inventory:read',
    'inventory:write',
    'apps-inventory:read',
    'apps-inventory:write',
    'licenses:read',
    'licenses:write',
    'budget:read',
    'budget:write',
    'users:manage',
  ],
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission)
}
