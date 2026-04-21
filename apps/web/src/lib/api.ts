import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { msalInstance, apiLoginRequest } from './auth'
import type { ApiError } from '@dsi-app/shared'

// Client API centralisé — tous les appels API passent par ici
// Ne jamais faire de fetch direct dans les composants
export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '/api',
  headers: {
    'Content-Type': 'application/json',
  },
})

// Intercepteur de requête — injecte le token Bearer automatiquement
apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const accounts = msalInstance.getAllAccounts()

  if (accounts.length === 0) {
    return config
  }

  const account = accounts[0]
  if (!account) return config

  try {
    // Acquisition silencieuse du token (refresh automatique si expiré)
    const response = await msalInstance.acquireTokenSilent({
      ...apiLoginRequest,
      account,
    })
    config.headers.Authorization = `Bearer ${response.accessToken}`
  } catch {
    // Si l'acquisition silencieuse échoue, rediriger vers login
    await msalInstance.acquireTokenRedirect(apiLoginRequest)
  }

  return config
})

// Intercepteur de réponse — normalise les erreurs API
apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiError>) => {
    const message = error.response?.data?.message ?? error.message ?? 'Une erreur est survenue'
    const statusCode = error.response?.status ?? 0

    // Erreur 401 : token invalide ou expiré → rediriger vers login
    if (statusCode === 401) {
      msalInstance.acquireTokenRedirect(apiLoginRequest)
    }

    return Promise.reject(new Error(message))
  }
)
