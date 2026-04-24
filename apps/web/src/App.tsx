import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthenticatedTemplate, UnauthenticatedTemplate, useMsalAuthentication } from '@azure/msal-react'
import { InteractionType } from '@azure/msal-browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppShell } from '@/layouts/AppShell'
import LoginPage from '@/pages/LoginPage'
import NotFoundPage from '@/pages/NotFoundPage'
import DashboardPage from '@/pages/DashboardPage'
import { Spinner } from '@/components/ui/spinner'
import { apiLoginRequest } from '@/lib/auth'

// Chargement différé des pages pour optimiser le bundle initial
const TicketingPage = lazy(() => import('@/modules/ticketing/TicketingPage'))
const AccountsPage = lazy(() => import('@/modules/accounts/AccountsPage'))
const InventoryPage = lazy(() => import('@/modules/inventory/InventoryPage'))
const AppsInventoryPage = lazy(() => import('@/modules/apps-inventory/AppsInventoryPage'))
const LicensesPage = lazy(() => import('@/modules/licenses/LicensesPage'))
const BudgetPage = lazy(() => import('@/modules/budget/BudgetPage'))

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
              <Route
                path="tickets"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <TicketingPage />
                  </Suspense>
                }
              />
              <Route
                path="accounts"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <AccountsPage />
                  </Suspense>
                }
              />
              <Route
                path="inventory"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <InventoryPage />
                  </Suspense>
                }
              />
              <Route
                path="apps"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <AppsInventoryPage />
                  </Suspense>
                }
              />
              <Route
                path="licenses"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <LicensesPage />
                  </Suspense>
                }
              />
              <Route
                path="budget"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <BudgetPage />
                  </Suspense>
                }
              />
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
