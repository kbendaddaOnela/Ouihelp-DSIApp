import { useCallback, useEffect } from 'react'
import { useMsal, useAccount } from '@azure/msal-react'
import { useAuthStore } from '@/store/authStore'
import { apiClient } from '@/lib/api'
import { apiLoginRequest } from '@/lib/auth'
import type { MeResponse } from '@dsi-app/shared'

// Hook principal d'authentification — encapsule MSAL + état applicatif (rôle)
export function useAuth() {
  const { instance, accounts } = useMsal()
  const account = useAccount(accounts[0] ?? null)
  const { user, role, isLoadingRole, setUser, setRole, setLoadingRole, reset } = useAuthStore()

  // Charge le rôle applicatif depuis l'API après la connexion MSAL
  useEffect(() => {
    if (!account || role || isLoadingRole) return

    setLoadingRole(true)
    apiClient
      .get<MeResponse>('/me')
      .then((res) => {
        setUser(res.data.user)
        setRole(res.data.user.role)
      })
      .catch((err: unknown) => {
        console.error('[useAuth] Impossible de charger le profil utilisateur :', err)
      })
      .finally(() => {
        setLoadingRole(false)
      })
  }, [account, role, isLoadingRole, setUser, setRole, setLoadingRole])

  const login = useCallback(async () => {
    await instance.loginRedirect(apiLoginRequest)
  }, [instance])

  const logout = useCallback(async () => {
    reset()
    await instance.logoutRedirect({
      postLogoutRedirectUri: import.meta.env.VITE_APP_URL ?? window.location.origin,
    })
  }, [instance, reset])

  return {
    account,
    user,
    role,
    isLoadingRole,
    isAuthenticated: !!account,
    login,
    logout,
  }
}
