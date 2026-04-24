import { useCallback, useEffect } from 'react'
import { useMsal, useAccount } from '@azure/msal-react'
import { useAuthStore } from '@/store/authStore'
import { apiClient } from '@/lib/api'
import { apiLoginRequest } from '@/lib/auth'
import type { MeResponse } from '@dsi-app/shared'

// Hook principal d'authentification — encapsule MSAL + état applicatif (rôle)
export function useAuth() {
  const { instance, accounts } = useMsal()
  const account = useAccount(accounts[0])
  const {
    user,
    role,
    isLoadingRole,
    authError,
    setUser,
    setRole,
    setLoadingRole,
    setAuthError,
    reset,
  } = useAuthStore()

  // Charge le rôle applicatif depuis l'API après la connexion MSAL
  useEffect(() => {
    if (!account || role || isLoadingRole || authError) return

    setLoadingRole(true)
    apiClient
      .get<MeResponse>('/me')
      .then((res) => {
        setUser(res.data.user)
        setRole(res.data.user.role)
        setAuthError(null)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Erreur inconnue'
        console.error('[useAuth] Impossible de charger le profil utilisateur :', err)
        setAuthError(message)
      })
      .finally(() => {
        setLoadingRole(false)
      })
  }, [account, role, isLoadingRole, authError, setUser, setRole, setLoadingRole, setAuthError])

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
    authError,
    isAuthenticated: !!account,
    login,
    logout,
  }
}
