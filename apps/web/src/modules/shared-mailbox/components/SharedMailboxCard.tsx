import { useState } from 'react'
import { Play, Square, Trash2, AlertCircle, CheckCircle2, Loader2, Mailbox, ShieldOff } from 'lucide-react'
import type { SharedMigrationRecord } from '@dsi-app/shared'
import {
  useRunSharedMigration,
  useStopSharedMigration,
  useDeleteSharedMigration,
  useSharedDualDeliveryStatus,
  useEnableSharedDualDelivery,
  useDisableSharedDualDelivery,
  useAllowExternalGroupPosts,
  useEnableCollaborativeInbox,
  useSilenceMembers,
  useAddMigAlias,
  useSetupLabel,
  useSetupFilter,
  useSetupSendAs,
} from '../hooks/useSharedMailbox'

interface Props {
  migration: SharedMigrationRecord
}

function StepBadge({ status, label }: { status: SharedMigrationRecord['stepMailImport']; label: string }) {
  const map: Record<SharedMigrationRecord['stepMailImport'], { cls: string; icon: React.ReactNode }> = {
    pending: { cls: 'bg-gray-100 text-gray-700', icon: <Loader2 className="h-3.5 w-3.5 animate-pulse" /> },
    running: { cls: 'bg-blue-100 text-blue-700', icon: <Loader2 className="h-3.5 w-3.5 animate-spin" /> },
    success: { cls: 'bg-green-100 text-green-700', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    error: { cls: 'bg-red-100 text-red-700', icon: <AlertCircle className="h-3.5 w-3.5" /> },
    skipped: { cls: 'bg-gray-100 text-gray-500', icon: null },
  }
  const m = map[status]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>
      {m.icon}
      {label}
    </span>
  )
}

export function SharedMailboxCard({ migration }: Props) {
  const { mutate: runMigration, isPending: isRunning } = useRunSharedMigration()
  const { mutate: stopMigration, isPending: isStopping } = useStopSharedMigration()
  const { mutate: deleteMigration, isPending: isDeleting } = useDeleteSharedMigration()

  const isInFlight = migration.stepMailImport === 'running' || migration.stepMailImport === 'pending'

  const pct = migration.mailTotal > 0
    ? Math.min(100, Math.round((migration.mailMigrated / migration.mailTotal) * 100))
    : 0

  const canRun =
    migration.stepMailImport !== 'running' && migration.stepMailImport !== 'pending'
  const canDelete = migration.stepMailImport !== 'running'

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900">{migration.onelaDisplayName}</span>
            <span className="text-xs text-gray-500">{migration.onelaEmail}</span>
          </div>
          <div className="mt-1 text-sm text-gray-600">
            → <span className="font-mono text-xs">{migration.targetGroupEmail}</span>{' '}
            <span className="text-gray-400">({migration.targetGroupName})</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canRun && (
            <button
              onClick={() => runMigration(migration.id)}
              disabled={isRunning}
              className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              {migration.stepMailImport === 'success' ? 'Resynchroniser' : 'Lancer'}
            </button>
          )}
          {isInFlight && (
            <button
              onClick={() => {
                if (window.confirm("Arrêter la migration en cours ? Les messages déjà importés sont conservés ; tu pourras la relancer (reprise idempotente).")) {
                  stopMigration(migration.id)
                }
              }}
              disabled={isStopping}
              className="inline-flex items-center gap-1 rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
            >
              <Square className="h-3.5 w-3.5" />
              {isStopping ? 'Arrêt…' : 'Arrêter'}
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => {
                if (window.confirm('Supprimer cette migration (pas le groupe Google) ?')) deleteMigration(migration.id)
              }}
              disabled={isDeleting}
              className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              title="Supprimer"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <StepBadge status={migration.stepCreateGroup} label={`Groupe : ${migration.stepCreateGroup}`} />
        <StepBadge status={migration.stepMailImport} label={`Import mail : ${migration.stepMailImport}`} />
      </div>

      {migration.mailTotal > 0 && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-gray-600">
            <span>
              {migration.mailMigrated.toLocaleString()} / {migration.mailTotal.toLocaleString()} mails
              {migration.mailFailed > 0 && (
                <span className="ml-2 text-red-600">({migration.mailFailed} erreurs)</span>
              )}
            </span>
            <span>{pct}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {(migration.createGroupError || migration.mailError) && (
        <div className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          {migration.createGroupError && <div>Groupe : {migration.createGroupError}</div>}
          {migration.mailError && <div>Mail : {migration.mailError}</div>}
        </div>
      )}

      <DualDeliveryPanel migration={migration} />
    </div>
  )
}

function DualDeliveryPanel({ migration }: { migration: SharedMigrationRecord }) {
  const groupReady = migration.stepCreateGroup === 'success'
  const { data, isLoading } = useSharedDualDeliveryStatus(migration.id, groupReady)
  const { mutate: enableRaw, isPending: enabling } = useEnableSharedDualDelivery()
  const { mutate: disableRaw, isPending: disabling } = useDisableSharedDualDelivery()
  const { mutate: allowExternalRaw, isPending: opening } = useAllowExternalGroupPosts()
  const { mutate: enableCollabRaw, isPending: enablingCollab } = useEnableCollaborativeInbox()
  const { mutate: silenceRaw, isPending: silencing } = useSilenceMembers()
  const { mutate: addAliasRaw, isPending: addingAlias } = useAddMigAlias()
  const { mutate: setupLabelRaw, isPending: settingUpLabel } = useSetupLabel()
  const { mutate: setupFilterRaw, isPending: settingUpFilter } = useSetupFilter()
  const { mutate: setupSendAsRaw, isPending: settingUpSendAs } = useSetupSendAs()

  const onError = (action: string) => (err: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any
    const status = e?.response?.status
    const apiErr = e?.response?.data?.error
    if (status === 404 && !apiErr) {
      window.alert(
        `${action} a échoué :\n\n` +
          `Endpoint API introuvable (404). Le backend est probablement encore en cours de déploiement.\n` +
          `Réessaye dans 1-2 minutes.`,
      )
      return
    }
    const msg = apiErr || (err instanceof Error ? err.message : String(err))
    window.alert(`${action} a échoué :\n\n${msg}`)
  }
  const enable = (bccAddress?: string) =>
    enableRaw({ id: migration.id, bccAddress }, { onError: onError('Activer dual delivery') })
  const disable = (id: string) => disableRaw(id, { onError: onError('Désactiver dual delivery') })
  const allowExternal = (id: string) => allowExternalRaw(id, { onError: onError('Ouvrir le groupe aux externes') })
  const enableCollab = (id: string) => enableCollabRaw(id, { onError: onError('Activer la boîte collaborative') })
  const silence = (id: string) =>
    silenceRaw(id, {
      onError: onError('Désactiver le fan-out membres'),
      onSuccess: (data) => {
        const { total, updated, alreadySilent, failed } = data
        window.alert(
          `Membres traités : ${total}\n• Mis en silencieux : ${updated}\n• Déjà silencieux : ${alreadySilent}\n• Échecs : ${failed}`,
        )
      },
    })
  const addAlias = (id: string) =>
    addAliasRaw(id, {
      onError: onError('Ajouter l\'alias @mig.onela.com'),
      onSuccess: (data) =>
        window.alert(
          data.added
            ? `Alias ajouté : ${data.alias}`
            : `Alias déjà présent : ${data.alias}`,
        ),
    })
  const bulkResultAlert = (action: string) => (data: { total: number; created: number; alreadyOk: number; failed: number; failedMembers: string[] }) =>
    window.alert(
      `${action}\n\nMembres traités : ${data.total}\n• Créés : ${data.created}\n• Déjà OK : ${data.alreadyOk}\n• Échecs : ${data.failed}` +
        (data.failedMembers.length ? `\n\nÉchecs sur :\n- ${data.failedMembers.slice(0, 10).join('\n- ')}` : ''),
    )
  const setupLabel = (id: string) =>
    setupLabelRaw(id, { onError: onError('Créer le libellé aux membres'), onSuccess: bulkResultAlert('Libellé Gmail créé') })
  const setupFilter = (id: string) =>
    setupFilterRaw(id, {
      onError: onError('Créer le filtre aux membres'),
      onSuccess: (data) => {
        const { total, created, alreadyOk, failed, failedMembers, backfilledMessages } = data
        window.alert(
          `Filtre Gmail créé\n\nMembres traités : ${total}\n• Créés : ${created}\n• Déjà OK : ${alreadyOk}\n• Échecs : ${failed}\n\n` +
            `Mails existants reclassés (label + archive) : ${backfilledMessages}` +
            (failedMembers.length ? `\n\nÉchecs sur :\n- ${failedMembers.slice(0, 10).join('\n- ')}` : ''),
        )
      },
    })
  const setupSendAs = (id: string) =>
    setupSendAsRaw(id, { onError: onError('Ajouter "Envoyer en tant que"'), onSuccess: bulkResultAlert('"Envoyer en tant que" ajouté') })

  if (!groupReady) return null

  const forwarding = data?.forwarding
  const allowsExternal = data?.groupAllowsExternalPosts ?? false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collaborativeInboxOn = ((data as any)?.groupCollaborativeInbox ?? false) as boolean
  const isActive = !!forwarding?.active
  // expectedRoutingAddress vient du backend (calculé/persisté)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expectedRouting = (data as any)?.expectedRoutingAddress as string | undefined
  const wrongTarget =
    isActive && expectedRouting && forwarding?.forwardTo?.toLowerCase() !== expectedRouting.toLowerCase()

  // Input éditable pour l'adresse de routage (avec defaut intelligent)
  const defaultBcc = expectedRouting ?? ''
  const [bccInput, setBccInput] = useState<string>('')
  const localPart = migration.targetGroupEmail.split('@')[0] ?? ''

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
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${allowsExternal ? 'bg-green-500' : 'bg-gray-300'}`} />
          Groupe accepte les posts externes&nbsp;:{' '}
          <span className={allowsExternal ? 'text-gray-800' : 'text-gray-500'}>
            {data?.groupPostPermission ?? 'inconnu (scope apps.groups.settings ?)'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${collaborativeInboxOn ? 'bg-green-500' : 'bg-gray-300'}`} />
          Boîte de réception collaborative&nbsp;:{' '}
          <span className={collaborativeInboxOn ? 'text-gray-800' : 'text-gray-500'}>
            {collaborativeInboxOn ? 'activée' : 'désactivée (le mail va aux membres, pas à la boîte du groupe)'}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-3 space-y-2">
        {(!isActive || wrongTarget) && (
          <div>
            <label className="mb-1 block text-xs text-gray-600">
              Adresse de routage BCC&nbsp;:
              <span className="ml-1 text-gray-400">(défaut : domaine de transition <code>mig.&lt;domaine&gt;</code>)</span>
            </label>
            <input
              type="email"
              value={bccInput}
              onChange={(e) => setBccInput(e.target.value)}
              placeholder={defaultBcc}
              className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Utilise le domaine de transition <code>mig.onela.com</code> (déjà configuré côté Google
              Workspace pour la migration classique). <code>{localPart || 'localpart'}@mig.onela.com</code>{' '}
              doit exister comme alias du groupe ou comme domain alias automatique.
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
              onClick={() => {
                if (window.confirm('Désactiver le dual delivery (supprimer la transport rule) ?')) {
                  disable(migration.id)
                }
              }}
              disabled={disabling}
              className="inline-flex items-center gap-1 rounded bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
            >
              <ShieldOff className="h-3 w-3" />
              {disabling ? 'Désactivation…' : 'Désactiver dual delivery'}
            </button>
          )}
          {!allowsExternal && (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    "Ouvrir le groupe à TOUS les expéditeurs externes (ANYONE_CAN_POST) ?\n\nNécessaire pour que les mails BCC arrivent dans l'archive. Tu pourras durcir après cutover.",
                  )
                ) {
                  allowExternal(migration.id)
                }
              }}
              disabled={opening}
              className="inline-flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {opening ? 'Ouverture…' : 'Ouvrir le groupe aux externes'}
            </button>
          )}
          {!collaborativeInboxOn && (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    "Activer la boîte de réception collaborative ?\n\nLes mails apparaîtront dans l'inbox du groupe (mode shared mailbox), les membres pourront s'assigner/marquer comme résolu. Active aussi l'historique des conversations (prérequis).",
                  )
                ) {
                  enableCollab(migration.id)
                }
              }}
              disabled={enablingCollab}
              className="inline-flex items-center gap-1 rounded bg-purple-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {enablingCollab ? 'Activation…' : 'Activer boîte collaborative'}
            </button>
          )}
          <button
            onClick={() => addAlias(migration.id)}
            disabled={addingAlias}
            className="inline-flex items-center gap-1 rounded bg-teal-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
            title={`Ajouter ${localPart}@mig.onela.com comme alias du groupe`}
          >
            {addingAlias ? 'Ajout…' : `Ajouter alias @mig.onela.com`}
          </button>
          <button
            onClick={() => {
              if (
                window.confirm(
                  "Passer TOUS les membres en mode silencieux (delivery_settings='NONE') ?\n\n" +
                    "Les membres ne recevront plus de copie dans leur boîte Gmail perso ; ils verront " +
                    "les mails uniquement dans l'interface du groupe.\n\n" +
                    "À refaire à chaque ajout d'un nouveau membre (valeur par défaut = ALL_MAIL).",
                )
              ) {
                silence(migration.id)
              }
            }}
            disabled={silencing}
            className="inline-flex items-center gap-1 rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {silencing ? 'Application…' : 'Pas d\'email aux membres'}
          </button>
        </div>

        {/* Setup "shared mailbox via Gmail label" sur le Gmail perso de chaque membre */}
        <div className="mt-3 rounded border border-gray-100 bg-gray-50 p-2.5">
          <div className="mb-2 text-[11px] font-semibold text-gray-700">
            Setup Gmail des membres (alternative au mode Groupe pour les users qui se perdent)
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                if (window.confirm(`Créer le libellé "${migration.targetGroupName}" dans le Gmail de tous les membres ?`))
                  setupLabel(migration.id)
              }}
              disabled={settingUpLabel}
              className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {settingUpLabel ? 'Création…' : `1. Créer libellé "${migration.targetGroupName}"`}
            </button>
            <button
              onClick={() => {
                if (
                  window.confirm(
                    `Créer un filtre Gmail chez tous les membres ?\n\nCritère : to:${migration.targetGroupEmail}\nAction : applique le libellé "${migration.targetGroupName}" + archive (skip inbox)`,
                  )
                )
                  setupFilter(migration.id)
              }}
              disabled={settingUpFilter}
              className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {settingUpFilter ? 'Création…' : '2. Créer règle de tri'}
            </button>
            <button
              onClick={() => {
                if (
                  window.confirm(
                    `Ajouter "Envoyer en tant que ${migration.targetGroupEmail}" chez tous les membres ?\n\nIls pourront répondre avec l'adresse partagée.`,
                  )
                )
                  setupSendAs(migration.id)
              }}
              disabled={settingUpSendAs}
              className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {settingUpSendAs ? 'Ajout…' : '3. Ajouter "Envoyer en tant que"'}
            </button>
          </div>
          <p className="mt-2 text-[10px] text-gray-500">
            Idempotent : à refaire après ajout de nouveaux membres. Les libellés/filtres/send-as déjà
            présents sont skippés.
          </p>
        </div>
      </div>
    </div>
  )
}

