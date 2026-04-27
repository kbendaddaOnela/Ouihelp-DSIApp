import type { OnelaUser } from '@dsi-app/shared'
import { cn } from '@/lib/utils'

interface Props {
  user: OnelaUser
  selected: boolean
  onToggle: () => void
  alreadyMigrated: boolean
}

export function UserRow({ user, selected, onToggle, alreadyMigrated }: Props) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors',
        alreadyMigrated
          ? 'cursor-not-allowed border-gray-100 bg-gray-50 opacity-60'
          : 'border-gray-200 bg-white hover:border-primary-300',
        selected && !alreadyMigrated && 'border-primary-400 bg-primary-50'
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        disabled={alreadyMigrated}
        className="h-4 w-4 rounded border-gray-300 text-primary-600"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{user.displayName}</p>
        <p className="truncate text-xs text-gray-500">{user.upn}</p>
      </div>
      <div className="shrink-0 text-right">
        {user.jobTitle && <p className="text-xs text-gray-500">{user.jobTitle}</p>}
        {user.department && <p className="text-xs text-gray-400">{user.department}</p>}
        {alreadyMigrated && <span className="text-xs font-medium text-green-600">Déjà migré</span>}
      </div>
    </label>
  )
}
