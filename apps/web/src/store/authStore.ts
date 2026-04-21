import { create } from 'zustand'
import type { AppUser, Role } from '@dsi-app/shared'

interface AuthStore {
  user: AppUser | null
  role: Role | null
  isLoadingRole: boolean
  setUser: (user: AppUser | null) => void
  setRole: (role: Role | null) => void
  setLoadingRole: (loading: boolean) => void
  reset: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  role: null,
  isLoadingRole: false,
  setUser: (user) => set({ user }),
  setRole: (role) => set({ role }),
  setLoadingRole: (isLoadingRole) => set({ isLoadingRole }),
  reset: () => set({ user: null, role: null, isLoadingRole: false }),
}))
