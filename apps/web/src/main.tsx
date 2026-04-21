import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MsalProvider } from '@azure/msal-react'
import { msalInstance } from './lib/auth'
import { App } from './App'
import './index.css'

// Initialisation MSAL avant le rendu React (requis pour la gestion du redirect)
async function bootstrap() {
  await msalInstance.initialize()

  // Traitement de la réponse redirect MSAL (retour depuis login.microsoftonline.com)
  await msalInstance.handleRedirectPromise()

  const root = document.getElementById('root')
  if (!root) throw new Error('Root element introuvable')

  createRoot(root).render(
    <StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </StrictMode>
  )
}

bootstrap().catch(console.error)
