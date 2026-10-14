import { useState } from 'react'
import {
  Loader2,
  Mailbox,
  ShieldOff,
} from 'lucide-react'
import type { SharedMigrationRecord } from '@dsi-app/shared'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  useSharedDualDeliveryStatus,
  useEnableSharedDualDelivery,
  useDisableSharedDualDelivery,
} from '../hooks/useSharedMailbox'
import { useAlertOnError } from './cardShared'

// ── Dual delivery (commun aux deux modes) ───────────────────────────────────

export function DualDeliveryPanel({ migration }: { migration: SharedMigrationRecord }) {
  const alertOnError = useAlertOnError()
  const { confirm } = useConfirm()
  const targetReady =
    migration.mode === 'account'
      ? migration.stepCreateAccount === 'success'
      : migration.stepCreateGroup === 'success'
  const { data, isLoading } = useSharedDualDeliveryStatus(migration.id, targetReady)
  const { mutate: enableRaw, isPending: enabling } = useEnableSharedDualDelivery()
  const { mutate: disableRaw, isPending: disabling } = useDisableSharedDualDelivery()
  const [bccInput, setBccInput] = useState<string>('')

  if (!targetReady) return null

  const forwarding = data?.forwarding
  const isActive = !!forwarding?.active
  const expectedRouting = data?.expectedRoutingAddress ?? undefined
  const wrongTarget =
    isActive && expectedRouting && forwarding?.forwardTo?.toLowerCase() !== expectedRouting.toLowerCase()

  const enable = (bccAddress?: string) =>
    enableRaw({ id: migration.id, bccAddress }, { onError: alertOnError('Activer dual delivery') })
  const disable = (id: string) => disableRaw(id, { onError: alertOnError('Désactiver dual delivery') })

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-700">
          <Mailbox className="h-3.5 w-3.5" />
          Dual delivery
        </div>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>

      <div className="space-y-1.5 text-xs text-gray-600">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
          Transport rule (BCC routage Google)&nbsp;:{' '}
          {forwarding?.forwardTo ? (
            <span className={`font-mono ${isActive ? 'text-gray-800' : 'text-orange-600'}`}>
              → {forwarding.forwardTo}
              {wrongTarget && (
                <span className="ml-1 text-orange-600">(⚠ doit être {expectedRouting} ; cliquer pour mettre à jour)</span>
              )}
            </span>
          ) : (
            <span className="text-gray-500">aucune</span>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {(!isActive || wrongTarget) && (
          <div>
            <label className="mb-1 block text-xs text-gray-600">
              Adresse de routage BCC&nbsp;:
              <span className="ml-1 text-gray-400">
                (défaut&nbsp;: {migration.mode === 'account' ? 'adresse primaire du compte' : 'alias mig.<domaine> du groupe'})
              </span>
            </label>
            <input
              type="email"
              value={bccInput}
              onChange={(e) => setBccInput(e.target.value)}
              placeholder={expectedRouting ?? ''}
              className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Le BCC vise le domaine de transition <code>mig.onela.com</code> : l’adresse historique de la
              BAL reste autoritative côté Exchange, donc router dessus créerait une boucle.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {(!isActive || wrongTarget) && (
            <button
              onClick={() => enable(bccInput.trim() || undefined)}
              disabled={enabling}
              className="inline-flex items-center gap-1 rounded bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              <Mailbox className="h-3 w-3" />
              {enabling ? 'Activation…' : isActive ? 'Mettre à jour' : 'Activer dual delivery'}
            </button>
          )}
          {isActive && !wrongTarget && (
            <button
              onClick={async () => {
                const res = await confirm({
                  title: 'Désactiver le dual delivery',
                  tone: 'danger',
                  confirmLabel: 'Désactiver',
                  message:
                    'Supprimer la transport rule ? La boîte Google cessera de recevoir une copie ' +
                    'des messages arrivant sur la BAL Exchange.',
                })
                if (res.confirmed) disable(migration.id)
              }}
              disabled={disabling}
              className="inline-flex items-center gap-1 rounded bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
            >
              <ShieldOff className="h-3 w-3" />
              {disabling ? 'Désactivation…' : 'Désactiver dual delivery'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
