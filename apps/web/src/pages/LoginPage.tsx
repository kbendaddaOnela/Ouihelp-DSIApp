import { useIsAuthenticated } from '@azure/msal-react'
import { Building2, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/hooks/useAuth'

// Page de connexion — affichée aux utilisateurs non authentifiés
export default function LoginPage() {
  const isAuthenticated = useIsAuthenticated()
  const { login } = useAuth()

  if (isAuthenticated) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md space-y-8 px-4">
        {/* Logo */}
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-600 shadow-lg">
            <Building2 className="h-9 w-9 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-900">DSI App</h1>
            <p className="mt-1 text-sm text-gray-500">Portail IT — ONELA</p>
          </div>
        </div>

        {/* Card de connexion */}
        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <div className="space-y-6">
            <div className="space-y-2 text-center">
              <h2 className="text-lg font-semibold text-gray-900">Connexion</h2>
              <p className="text-sm text-gray-500">
                Connectez-vous avec votre compte Microsoft ONELA
              </p>
            </div>

            <Button
              onClick={() => void login()}
              className="w-full"
              size="lg"
            >
              <svg className="h-5 w-5" viewBox="0 0 21 21" fill="none" aria-hidden="true">
                <path d="M10 0H0v10h10V0z" fill="#f25022" />
                <path d="M21 0H11v10h10V0z" fill="#7fba00" />
                <path d="M10 11H0v10h10V11z" fill="#00a4ef" />
                <path d="M21 11H11v10h10V11z" fill="#ffb900" />
              </svg>
              Se connecter avec Microsoft
            </Button>

            <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
              <Shield className="h-3.5 w-3.5" />
              <span>Authentification sécurisée via Microsoft Entra ID</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
