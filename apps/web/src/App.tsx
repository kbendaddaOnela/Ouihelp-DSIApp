import { Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import {
  AuthenticatedTemplate,
  UnauthenticatedTemplate,
  useMsalAuthentication,
} from '@azure/msal-react'
import { InteractionType } from '@azure/msal-browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppShell } from '@/layouts/AppShell'
import LoginPage from '@/pages/LoginPage'
import NotFoundPage from '@/pages/NotFoundPage'
import DashboardPage from '@/pages/DashboardPage'
import { Spinner } from '@/components/ui/spinner'
import { APP_ROUTES } from '@/routes'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
    },
  },
})

const PageLoader = () => (
  <div className="flex h-full items-center justify-center">
    <Spinner />
  </div>
)

// Composant interne qui active le flux SSO au montage
const AuthRedirectHandler = () => {
  useMsalAuthentication(InteractionType.None)
  return null
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthRedirectHandler />
        <AuthenticatedTemplate>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<DashboardPage />} />
              {/* Une route par entrée du registre (src/routes.tsx), chargée à la demande */}
              {APP_ROUTES.map(({ path, component: Page }) => (
                <Route
                  key={path}
                  path={path}
                  element={
                    <Suspense fallback={<PageLoader />}>
                      <Page />
                    </Suspense>
                  }
                />
              ))}
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </AuthenticatedTemplate>
        <UnauthenticatedTemplate>
          <LoginPage />
        </UnauthenticatedTemplate>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
