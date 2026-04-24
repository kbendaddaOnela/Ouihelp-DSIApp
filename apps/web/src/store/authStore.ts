import { create } from 'zustand'
import type { AppUser, Role } from '@dsi-app/shared'

interface AuthStore {
  user: AppUser | null
  role: Role | null
  isLoadingRole: boolean
  authError: string | null
  setUser: (user: AppUser | null) => void
  setRole: (role: Role | null) => void
  setLoadingRole: (loading: boolean) => void
  setAuthError: (error: string | null) => void
  reset: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  role: null,
  isLoadingRole: false,
  authError: null,
  setUser: (user) => set({ user }),
  setRole: (role) => set({ role }),
  setLoadingRole: (isLoadingRole) => set({ isLoadingRole }),
  setAuthError: (authError) => set({ authError }),
  reset: () => set({ user: null, role: null, isLoadingRole: false, authError: null }),
}))
