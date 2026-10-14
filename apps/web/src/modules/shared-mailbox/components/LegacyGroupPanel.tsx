import type { SharedMigrationRecord } from '@dsi-app/shared'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import {
  useSharedDualDeliveryStatus,
  useAllowExternalGroupPosts,
  useEnableCollaborativeInbox,
  useSilenceMembers,
  useAddMigAlias,
  useSetupLabel,
  useSetupFilter,
  useSetupSendAs,
} from '../hooks/useSharedMailbox'
import { useAlertOnError } from './cardShared'

// ── Réglages spécifiques aux anciennes migrations « Google Group » ──────────

export function LegacyGroupPanel({ migration }: { migration: SharedMigrationRecord }) {
  const alertOnError = useAlertOnError()
  const { confirm, alert } = useConfirm()
  const groupReady = migration.stepCreateGroup === 'success' && !!migration.targetGroupEmail
  const { data } = useSharedDualDeliveryStatus(migration.id, groupReady)
  const { mutate: allowExternalRaw, isPending: opening } = useAllowExternalGroupPosts()
  const { mutate: enableCollabRaw, isPending: enablingCollab } = useEnableCollaborativeInbox()
  const { mutate: silenceRaw, isPending: silencing } = useSilenceMembers()
  const { mutate: addAliasRaw, isPending: addingAlias } = useAddMigAlias()
  const { mutate: setupLabelRaw, isPending: settingUpLabel } = useSetupLabel()
  const { mutate: setupFilterRaw, isPending: settingUpFilter } = useSetupFilter()
  const { mutate: setupSendAsRaw, isPending: settingUpSendAs } = useSetupSendAs()

  if (!groupReady) return null

  const groupEmail = migration.targetGroupEmail!
  const groupName = migration.targetGroupName ?? migration.onelaDisplayName
  const allowsExternal = data?.groupAllowsExternalPosts ?? false
  const collaborativeInboxOn = data?.groupCollaborativeInbox ?? false

  const bulkResultAlert =
    (action: string) =>
    (d: { total: number; created: number; alreadyOk: number; failed: number; failedMembers: string[] }) =>
      void alert({
        title: action,
        tone: d.failed > 0 ? 'danger' : 'default',
        message:
          `Membres traités : ${d.total}\n• Créés : ${d.created}\n• Déjà OK : ${d.alreadyOk}\n• Échecs : ${d.failed}` +
          (d.failedMembers.length ? `\n\nÉchecs sur :\n- ${d.failedMembers.slice(0, 10).join('\n- ')}` : ''),
      })

  return (
    <div className="mt-4 rounded border border-amber-100 bg-amber-50 p-2.5">
      <div className="mb-2 text-[11px] font-semibold text-amber-900">
        Réglages « Google Group » (ancien mode — conservés pour cette migration)
      </div>
      <div className="flex flex-wrap gap-2">
        {!allowsExternal && (
          <button
            onClick={async () => {
              const res = await confirm({
                title: 'Ouvrir le groupe aux externes',
                confirmLabel: 'Ouvrir',
                message:
                  "Autoriser TOUS les expéditeurs externes à poster (ANYONE_CAN_POST) ?\n\n" +
                  "Nécessaire pour que les mails BCC arrivent dans l'archive.",
              })
              if (res.confirmed)
                allowExternalRaw(migration.id, { onError: alertOnError('Ouvrir le groupe aux externes') })
            }}
            disabled={opening}
            className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {opening ? 'Ouverture…' : 'Ouvrir le groupe aux externes'}
          </button>
        )}
        {!collaborativeInboxOn && (
          <button
            onClick={async () => {
              const res = await confirm({
                title: 'Boîte de réception collaborative',
                confirmLabel: 'Activer',
                message: 'Activer la boîte de réception collaborative sur ce groupe ?',
              })
              if (res.confirmed)
                enableCollabRaw(migration.id, { onError: alertOnError('Activer la boîte collaborative') })
            }}
            disabled={enablingCollab}
            className="rounded bg-purple-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {enablingCollab ? 'Activation…' : 'Activer boîte collaborative'}
          </button>
        )}
        <button
          onClick={() =>
            addAliasRaw(migration.id, {
              onError: alertOnError("Ajouter l'alias @mig.onela.com"),
              onSuccess: (d) =>
                void alert({
                  title: d.added ? 'Alias ajouté' : 'Alias déjà présent',
                  message: d.alias,
                }),
            })
          }
          disabled={addingAlias}
          className="rounded bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {addingAlias ? 'Ajout…' : 'Ajouter alias @mig.onela.com'}
        </button>
        <button
          onClick={async () => {
            const res = await confirm({
              title: "Pas d'email aux membres",
              confirmLabel: 'Appliquer',
              message: "Passer TOUS les membres en mode silencieux (delivery_settings='NONE') ?",
            })
            if (res.confirmed)
              silenceRaw(migration.id, {
                onError: alertOnError('Désactiver le fan-out membres'),
                onSuccess: (d) =>
                  void alert({
                    title: 'Membres passés en silencieux',
                    tone: d.failed > 0 ? 'danger' : 'default',
                    message: `Membres traités : ${d.total}\n• Mis en silencieux : ${d.updated}\n• Déjà silencieux : ${d.alreadySilent}\n• Échecs : ${d.failed}`,
                  }),
              })
          }}
          disabled={silencing}
          className="rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {silencing ? 'Application…' : "Pas d'email aux membres"}
        </button>
        <button
          onClick={async () => {
            const res = await confirm({
              title: 'Créer le libellé chez les membres',
              confirmLabel: 'Créer',
              message: `Créer le libellé « ${groupName} » dans le Gmail de tous les membres ?`,
            })
            if (res.confirmed)
              setupLabelRaw(migration.id, {
                onError: alertOnError('Créer le libellé aux membres'),
                onSuccess: bulkResultAlert('Libellé Gmail créé'),
              })
          }}
          disabled={settingUpLabel}
          className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {settingUpLabel ? 'Création…' : `Créer libellé "${groupName}"`}
        </button>
        <button
          onClick={async () => {
            const res = await confirm({
              title: 'Créer la règle de tri',
              confirmLabel: 'Créer',
              message: `Créer un filtre Gmail chez tous les membres ?\n\nCritère : to:${groupEmail}`,
            })
            if (res.confirmed)
              setupFilterRaw(migration.id, {
                onError: alertOnError('Créer le filtre aux membres'),
                onSuccess: (d) =>
                  void alert({
                    title: 'Filtre Gmail créé',
                    tone: d.failed > 0 ? 'danger' : 'default',
                    message: `Membres traités : ${d.total}\n• Créés : ${d.created}\n• Déjà OK : ${d.alreadyOk}\n• Échecs : ${d.failed}\n\nMails existants reclassés : ${d.backfilledMessages}`,
                  }),
              })
          }}
          disabled={settingUpFilter}
          className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {settingUpFilter ? 'Création…' : 'Créer règle de tri'}
        </button>
        <button
          onClick={async () => {
            const res = await confirm({
              title: '« Envoyer en tant que » chez les membres',
              confirmLabel: 'Ajouter',
              message: `Ajouter l'identité d'envoi « ${groupEmail} » dans le Gmail de tous les membres ?`,
            })
            if (res.confirmed)
              setupSendAsRaw(migration.id, {
                onError: alertOnError('Ajouter "Envoyer en tant que"'),
                onSuccess: bulkResultAlert('"Envoyer en tant que" ajouté'),
              })
          }}
          disabled={settingUpSendAs}
          className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {settingUpSendAs ? 'Ajout…' : 'Ajouter "Envoyer en tant que"'}
        </button>
      </div>
    </div>
  )
}
