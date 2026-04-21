import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/hooks/useAuth'

// Shell applicatif principal — wraps toutes les pages authentifiées
export const AppShell = () => {
  const { isLoadingRole } = useAuth()

  // Attend que le rôle soit chargé avant d'afficher le contenu
  if (isLoadingRole) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p className="text-sm text-gray-500">Chargement du profil...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
