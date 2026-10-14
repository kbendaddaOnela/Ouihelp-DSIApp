import {
  Loader2,
  BadgeCheck,
  RefreshCw,
} from 'lucide-react'
import type { SharedMigrationRecord } from '@dsi-app/shared'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  useSharedAccountStatus,
  useLicenseAck,
  useSharedLicenseSkus,
  useAssignSharedLicense,
  useAliasSendAs,
} from '../hooks/useSharedMailbox'
import { useAlertOnError } from './cardShared'

// ── Compte Google + licence ─────────────────────────────────────────────────

/**
 * Attribution d'une licence Workspace au compte partagé, directement depuis l'app.
 *
 * Les sièges affichés viennent du même endpoint que le module migration : une BAL
 * partagée consomme un siège comme un utilisateur nominatif, le compteur est donc
 * le même. Les totaux de sièges achetés restent en lecture seule ici — ils se
 * saisissent une seule fois dans le panneau licences du dashboard.
 */
function LicenseAssignBlock({ migration }: { migration: SharedMigrationRecord }) {
  const alertOnError = useAlertOnError()
  const { alert } = useConfirm()
  const { data: skus, isLoading, isError, error, refetch } = useSharedLicenseSkus(true)
  const { mutate: assign, isPending: assigning } = useAssignSharedLicense()

  return (
    <div className="mt-3 rounded border border-gray-200 bg-gray-50/70 p-2.5">
      <div className="mb-1.5 text-[11px] font-semibold text-gray-700">
        Attribuer une licence à <span className="font-mono">{migration.targetUserEmail}</span>
      </div>

      {isLoading && (
        <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Chargement des licences…
        </p>
      )}

      {isError && (
        <div className="space-y-1">
          <p className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
            {error instanceof Error ? error.message : 'Erreur de récupération des licences'}
          </p>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700"
          >
            <RefreshCw className="h-3 w-3" /> Réessayer
          </button>
        </div>
      )}

      {skus && skus.length > 0 && (
        <div className="space-y-1.5">
          {skus.map((sku) => {
            const isAssigned = migration.licenseSkuId === sku.skuId
            const noneLeft = sku.remaining != null && sku.remaining <= 0
            return (
              <div
                key={`${sku.productId}|${sku.skuId}`}
                className="flex items-center gap-2 rounded-lg border border-gray-100 bg-white px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-gray-800">{sku.name}</div>
                  <div className="text-[11px] text-gray-500">
                    {sku.total != null ? (
                      <>
                        <span className={noneLeft ? 'font-medium text-red-600' : 'font-medium text-emerald-600'}>
                          {sku.remaining} restante{Math.abs(sku.remaining ?? 0) > 1 ? 's' : ''}
                        </span>
                        {' · '}
                        {sku.used}/{sku.total} utilisées
                      </>
                    ) : (
                      <>{sku.used} utilisées</>
                    )}
                  </div>
                </div>
                <button
                  onClick={() =>
                    assign(
                      { id: migration.id, productId: sku.productId, skuId: sku.skuId },
                      {
                        onError: alertOnError(`Attribuer « ${sku.name} »`),
                        onSuccess: (d) =>
                          void alert({
                            title: `Licence « ${sku.name} » attribuée`,
                            message: d.mailboxReady
                              ? `La boîte Gmail est prête : clique « Lancer » quand tu veux démarrer l’import.`
                              : `Gmail met quelques minutes à se provisionner. Rafraîchis l’état, puis ` +
                                `clique « Lancer » quand la boîte est prête.`,
                          }),
                      },
                    )
                  }
                  disabled={assigning || isAssigned}
                  title={isAssigned ? 'Déjà attribuée à ce compte' : undefined}
                  className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  {isAssigned ? '✓' : assigning ? '…' : 'Attribuer'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {skus && skus.length === 0 && !isError && (
        <p className="text-[11px] text-amber-600">
          Aucune licence détectée. Vérifie le scope DwD « apps.licensing » côté console Google.
        </p>
      )}
    </div>
  )
}

export function AccountPanel({ migration }: { migration: SharedMigrationRecord }) {
  const alertOnError = useAlertOnError()
  const accountCreated = migration.stepCreateAccount === 'success'
  const { data, isLoading, refetch } = useSharedAccountStatus(migration.id, accountCreated)
  const { mutate: ackLicense, isPending: acking } = useLicenseAck()
  const { mutate: fixAlias, isPending: fixingAlias } = useAliasSendAs()

  if (!accountCreated) {
    return (
      <div className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-500">
        Le compte Google sera créé au lancement de la migration.
      </div>
    )
  }

  const licenseDone = migration.stepLicense === 'success'

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-700">
          <BadgeCheck className="h-3.5 w-3.5" />
          Compte Google &amp; licence
        </div>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
      </div>

      <div className="space-y-1.5 text-xs text-gray-600">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${data?.exists ? 'bg-green-500' : 'bg-gray-300'}`} />
          Compte&nbsp;: <span className="font-mono">{migration.targetUserEmail}</span>
          {data?.orgUnitPath && <span className="text-gray-400">— OU {data.orgUnitPath}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${data?.aliasPresent ? 'bg-green-500' : 'bg-gray-300'}`} />
          Alias&nbsp;: <span className="font-mono">{migration.targetUserAlias}</span>
          <span className="text-gray-400">{data?.aliasPresent ? '(posé)' : '(absent)'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${data?.mailboxReady ? 'bg-green-500' : 'bg-orange-400'}`} />
          Boîte Gmail provisionnée&nbsp;:{' '}
          <span className={data?.mailboxReady ? 'text-gray-800' : 'text-orange-600'}>
            {data?.mailboxReady ? 'oui' : 'non — licence Business Plus à attribuer'}
          </span>
        </div>
        {migration.licenseSkuName && (
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
            Licence&nbsp;: <span className="font-medium text-gray-800">{migration.licenseSkuName}</span>
            <span className="text-gray-400">(attribuée depuis l’app)</span>
          </div>
        )}
        {migration.licenseAckAt && (
          <div className="text-gray-500">
            Licence {migration.licenseSkuName ? 'attribuée' : 'acquittée'} le{' '}
            {new Date(migration.licenseAckAt).toLocaleString('fr-FR')}
            {migration.licenseAckBy ? ` par ${migration.licenseAckBy}` : ''}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {!licenseDone && (
          <button
            onClick={() =>
              ackLicense(migration.id, {
                onError: alertOnError('Acquitter la licence'),
              })
            }
            disabled={acking}
            className="inline-flex items-center gap-1 rounded bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            title="À cliquer si la licence a été posée dans la console Google ou par l’OU. Ne démarre pas l’import."
          >
            <BadgeCheck className="h-3 w-3" />
            {acking ? 'Vérification…' : 'Licence déjà attribuée (hors app)'}
          </button>
        )}
        <button
          onClick={() => refetch()}
          className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Rafraîchir l’état
        </button>
        <button
          onClick={() => fixAlias(migration.id, { onError: alertOnError('Réappliquer nom / alias / send-as') })}
          disabled={fixingAlias}
          title="Réaligne le nom du compte, l’alias et l’identité d’envoi par défaut"
          className="rounded bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {fixingAlias ? 'Application…' : 'Réappliquer nom + alias + « Envoyer en tant que »'}
        </button>
      </div>

      {!licenseDone && <LicenseAssignBlock migration={migration} />}

      {!licenseDone && (
        <p className="mt-2 text-[11px] text-gray-500">
          Deux voies&nbsp;: <strong>attribuer</strong> une licence ci-dessus (elle est posée
          immédiatement via l’API Google), ou la poser hors app (OU / console Admin) puis cliquer
          « Licence déjà attribuée », qui vérifie que la boîte Gmail est bien provisionnée. Dans
          les deux cas l’import <strong>ne démarre pas tout seul</strong>&nbsp;: c’est le bouton
          « Lancer » qui le déclenche, au moment que tu choisis.
        </p>
      )}
    </div>
  )
}
