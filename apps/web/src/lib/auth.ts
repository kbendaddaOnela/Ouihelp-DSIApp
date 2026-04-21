import { PublicClientApplication, type Configuration, type RedirectRequest } from '@azure/msal-browser'

// Configuration MSAL — toutes les valeurs viennent des variables d'environnement
// Ne jamais hardcoder le tenant ID (tenant-agnostic by design)
const msalConfig: Configuration = {
  auth: {
    clientId: import.meta.env.VITE_AZURE_CLIENT_ID,
    authority: import.meta.env.VITE_AZURE_AUTHORITY,
    redirectUri: import.meta.env.VITE_APP_URL ?? window.location.origin,
    postLogoutRedirectUri: import.meta.env.VITE_APP_URL ?? window.location.origin,
    navigateToLoginRequestUrl: false,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return
        if (import.meta.env.DEV) {
          console.debug(`[MSAL] ${message}`)
        }
      },
    },
  },
}

// Scopes pour l'API interne DSI App
export const apiLoginRequest: RedirectRequest = {
  scopes: [import.meta.env.VITE_API_SCOPE ?? `api://${import.meta.env.VITE_AZURE_CLIENT_ID}/access_as_user`],
}

// Scopes pour Microsoft Graph (profil utilisateur)
export const graphLoginRequest: RedirectRequest = {
  scopes: ['openid', 'profile', 'email', 'User.Read'],
}

export const msalInstance = new PublicClientApplication(msalConfig)
