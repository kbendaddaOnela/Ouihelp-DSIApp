import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <p className="text-6xl font-bold text-gray-200">404</p>
      <h1 className="text-xl font-semibold text-gray-900">Page introuvable</h1>
      <p className="text-sm text-gray-500">La page que vous cherchez n&apos;existe pas.</p>
      <Button asChild variant="outline" size="sm">
        <Link to="/">Retour à l&apos;accueil</Link>
      </Button>
    </div>
  )
}
