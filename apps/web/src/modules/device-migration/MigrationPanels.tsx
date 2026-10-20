import { useState } from 'react'
import {
  Package,
  RotateCcw,
  ShieldAlert,
  Eye,
  Upload,
  CheckCircle2,
  XCircle,
  Info,
} from 'lucide-react'
import type {
  DeviceAppCatalogEntry,
  DeviceMigrationRecord,
  DeviceMigrationRun,
  MigrationMode,
  MigrationProfileMapping,
  MigrationStatus,
} from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { CopyButton } from '@/modules/migration/components/CopyButton'
import { deviceMigrationApi } from './api'
import {
  useAbandonMigration,
  useClearMigration,
  useResumeMigration,
  useAppCatalog,
  useCancelMigration,
  useProfilePreview,
  useUpdateAppRules,
  useMigrationPackage,
  useScheduleMigration,
  useUpdateTargetName,
  useUploadMigrationPackage,
} from './hooks'

function fmtDateTime(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

export const MIGRATION_CFG: Record<MigrationStatus, { label: string; cls: string }> = {
  scheduled: { label: 'Bascule programmée', cls: 'bg-indigo-50 text-indigo-700' },
  staging: { label: 'Bascule : préparation', cls: 'bg-indigo-50 text-indigo-700' },
  staged: { label: 'Bascule : prêt', cls: 'bg-indigo-50 text-indigo-700' },
  cleanup: { label: 'Bascule : retrait Autopilot ONELA', cls: 'bg-indigo-50 text-indigo-700' },
  ready: { label: 'Bascule : réinitialisation imminente', cls: 'bg-indigo-100 text-indigo-800' },
  resetting: { label: 'Bascule : réinstallation de Windows', cls: 'bg-indigo-100 text-indigo-800' },
  joining: { label: 'Bascule : jonction Ouihelp', cls: 'bg-indigo-100 text-indigo-800' },
  done: { label: 'Basculé chez Ouihelp', cls: 'bg-emerald-50 text-emerald-700' },
  failed: { label: 'Bascule en échec', cls: 'bg-red-50 text-red-700' },
  cancelled: { label: 'Bascule annulée', cls: 'bg-gray-100 text-gray-500' },
}

const ACTIVE: MigrationStatus[] = [
  'scheduled',
  'staging',
  'staged',
  'cleanup',
  'ready',
  'resetting',
  'joining',
]
const CANCELLABLE: MigrationStatus[] = ['scheduled', 'staging', 'staged']
/** Sans nouvelles du poste au-delà, la réinstallation a probablement buté (WinRE, réseau…) */
const RESET_SILENCE_MS = 3 * 3600_000
/** Version minimale de l'agent pour une bascule en place (même garde-fou que l'API). */
const INPLACE_AGENT_VERSION = '1.2.2'

// ── PPKG Ouihelp ─────────────────────────────────────────────────────────────

export function PackagePanel({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading } = useMigrationPackage()
  const upload = useUploadMigrationPackage()
  const [file, setFile] = useState<File | null>(null)
  const [expires, setExpires] = useState('')
  const p = data?.package
  const expiresSoon =
    p?.tokenExpiresAt && new Date(p.tokenExpiresAt).getTime() - Date.now() < 30 * 86_400_000

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 text-xs">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
        <Package className="h-4 w-4" /> PPKG Ouihelp (jeton de jonction en bloc)
      </div>
      {isLoading ? (
        <Spinner />
      ) : p ? (
        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div>
            <span className="text-gray-400">Fichier :</span> {p.fileName} (
            {Math.round(p.sizeBytes / 1024)} Ko)
          </div>
          <div>
            <span className="text-gray-400">Empreinte :</span>{' '}
            <span className="font-mono">{p.sha256.slice(0, 16)}…</span>
          </div>
          <div>
            <span className="text-gray-400">Téléversé :</span> {fmtDateTime(p.uploadedAt)} par{' '}
            {p.uploadedBy}
          </div>
          <div className={cn(expiresSoon && 'font-medium text-amber-700')}>
            <span className="text-gray-400">Jeton valable jusqu’au :</span>{' '}
            {p.tokenExpiresAt
              ? new Date(p.tokenExpiresAt).toLocaleDateString('fr-FR')
              : 'non renseigné'}
          </div>
        </div>
      ) : (
        <p className="text-amber-700">Aucun PPKG : aucune bascule ne peut être programmée.</p>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
          <label className="space-y-1">
            <span className="block text-gray-500">Nouveau PPKG (.ppkg)</span>
            <input
              type="file"
              accept=".ppkg"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-xs"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-gray-500">Fin de validité du jeton</span>
            <input
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1"
            />
          </label>
          <Button
            size="sm"
            disabled={!file || upload.isPending}
            onClick={() =>
              file &&
              upload.mutate(
                { file, tokenExpiresAt: expires || null },
                { onSuccess: () => setFile(null) }
              )
            }
          >
            <Upload className="mr-1.5 h-4 w-4" /> {p ? 'Remplacer' : 'Téléverser'}
          </Button>
          {upload.error && <p className="w-full text-red-600">{(upload.error as Error).message}</p>}
        </div>
      )}
      <p className="text-gray-400">
        Remis uniquement à l’agent authentifié d’un poste dont la bascule est programmée, puis
        effacé du poste après la jonction.
      </p>
    </div>
  )
}

// ── Bascule d'un poste ───────────────────────────────────────────────────────

/** Libellé du statut, adapté au mode (« resetting » = bascule en cours pour le mode en place). */
export function migrationLabel(m: DeviceMigrationRun): string {
  if (m.mode === 'inplace') {
    if (m.status === 'ready') return 'Bascule : imminente'
    if (m.status === 'resetting') return 'Bascule : en cours sur le poste'
  }
  return MIGRATION_CFG[m.status].label
}

/** Raisons de ne pas pouvoir programmer (mêmes garde-fous que l'API, affichés d'avance). */
function blockers(d: DeviceMigrationRecord, mode: MigrationMode): string[] {
  const b: string[] = []
  if (!d.targetName) b.push('Nom Ouihelp à saisir')
  if (d.targetNameConflict) b.push(`Nom déjà attribué à ${d.targetNameConflict}`)
  if (mode === 'reset' && d.joinType !== 'entra_joined')
    b.push('Réinstallation limitée aux PC Entra Joined')
  if (mode === 'inplace' && d.joinType !== 'entra_joined' && d.joinType !== 'hybrid')
    b.push('Bascule en place limitée aux PC Entra Joined ou hybrides')
  if (!d.serialNumber) b.push('N° de série inconnu')
  if (!d.agent) b.push('Agent DSI non installé')
  else {
    if (d.agent.silent) b.push('Agent silencieux depuis plus de 24 h')
    if (
      mode === 'inplace' &&
      d.agent.report.agentVersion.localeCompare(INPLACE_AGENT_VERSION, undefined, {
        numeric: true,
      }) < 0
    )
      b.push(`Agent ${d.agent.report.agentVersion} : ${INPLACE_AGENT_VERSION} requis`)
    if (mode === 'reset') {
      if (d.agent.report.winreEnabled === false) b.push('WinRE désactivé')
      if (
        d.agent.report.network.wifi &&
        d.agent.report.network.wifiProfiles.length === 0 &&
        !d.agent.report.network.ethernet
      )
        b.push('Aucun profil Wi-Fi enregistré à restaurer')
    }
  }
  return b
}

const SOURCE_LABEL: Record<NonNullable<MigrationProfileMapping['source']>, string> = {
  migration: 'compte créé par la DSI App',
  mail: 'même adresse',
  manual: 'saisi',
}

/**
 * Profils ONELA du poste. Un seul est conservé et transféré au compte Ouihelp (par défaut le
 * dernier connecté) ; les autres sont supprimés du poste à la bascule, clé de registre et
 * dossier compris. Éditable avant programmation.
 */
function ProfileMap({
  profiles,
  editable,
  targets,
  setTargets,
  mainSid,
  setMainSid,
}: {
  profiles: MigrationProfileMapping[]
  editable: boolean
  targets: Record<string, string | null>
  setTargets: (t: Record<string, string | null>) => void
  mainSid: string | null
  setMainSid: (sid: string | null) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')
  if (profiles.length === 0)
    return <p className="text-gray-500">Aucun profil d’utilisateur ONELA sur ce poste.</p>
  const setTarget = (sid: string, upn: string | null | undefined) => {
    const next = { ...targets }
    if (upn === undefined) delete next[sid]
    else next[sid] = upn
    setTargets(next)
  }
  return (
    <table className="w-full">
      <thead>
        <tr className="text-left text-gray-400">
          <th className="py-1 pr-3 font-normal">Profil ONELA</th>
          <th className="py-1 pr-3 font-normal">Dernière connexion</th>
          <th className="py-1 pr-3 font-normal">Données locales</th>
          <th className="py-1 font-normal">À la bascule</th>
        </tr>
      </thead>
      <tbody>
        {profiles.map((p) => (
          <tr key={p.oldSid} className="border-t border-gray-100 align-top">
            <td className="py-1 pr-3 font-mono">{p.oldUpn ?? p.oldAccount ?? p.oldSid}</td>
            <td className="py-1 pr-3 text-gray-500">
              {p.lastLogonAt ? new Date(p.lastLogonAt).toLocaleDateString('fr-FR') : '—'}
            </td>
            <td className="py-1 pr-3">{p.localDataMb == null ? '—' : `${p.localDataMb} Mo`}</td>
            <td className="py-1">
              {p.action === 'delete' ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-amber-700">
                    Supprimé du poste (registre et dossier C:\Users)
                  </span>
                  {editable && (
                    <button
                      className="text-primary-600 hover:underline"
                      onClick={() => setMainSid(p.oldSid)}
                    >
                      Conserver celui-ci
                    </button>
                  )}
                </span>
              ) : editing === p.oldSid ? (
                <span className="flex flex-wrap items-center gap-2">
                  <input
                    className="w-64 rounded-md border border-gray-300 px-2 py-1"
                    placeholder="prenom.nom@ouihelp.fr"
                    value={value}
                    onChange={(e) => setValue(e.target.value.trim())}
                  />
                  <Button
                    size="sm"
                    disabled={!value.includes('@')}
                    onClick={() => {
                      setTarget(p.oldSid, value)
                      setEditing(null)
                    }}
                  >
                    OK
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                    Annuler
                  </Button>
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-700">
                    Conservé
                    {editable && (mainSid === p.oldSid ? ' (choix DSI)' : ' (dernier connecté)')},
                    repris par
                  </span>
                  {p.newUpn ? (
                    <span className="font-mono text-gray-800">{p.newUpn}</span>
                  ) : (
                    <span className="text-red-600">{p.error ?? 'compte Ouihelp à choisir'}</span>
                  )}
                  {p.newUpn && p.source && (
                    <span className="text-gray-400">({SOURCE_LABEL[p.source]})</span>
                  )}
                  {editable && (
                    <>
                      <button
                        className="text-primary-600 hover:underline"
                        onClick={() => {
                          setValue(p.newUpn ?? '')
                          setEditing(p.oldSid)
                        }}
                      >
                        Choisir le compte
                      </button>
                      {p.oldSid in targets && (
                        <button
                          className="text-gray-500 hover:underline"
                          onClick={() => setTarget(p.oldSid, undefined)}
                        >
                          Correspondance auto
                        </button>
                      )}
                    </>
                  )}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Futur nom chez Ouihelp (convention ONL-<site>-<n° de série>), modifiable hors bascule. */
function TargetName({
  d,
  canWrite,
  locked,
}: {
  d: DeviceMigrationRecord
  canWrite: boolean
  locked: boolean
}) {
  const update = useUpdateTargetName()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(d.targetName ?? '')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-gray-400">Nom chez Ouihelp :</span>
      {editing ? (
        <>
          <input
            className="w-40 rounded-md border border-gray-300 px-2 py-1 font-mono uppercase"
            maxLength={15}
            value={value}
            onChange={(e) => setValue(e.target.value.toUpperCase())}
          />
          <Button
            size="sm"
            disabled={update.isPending || !value}
            onClick={() =>
              update.mutate({ id: d.id, name: value }, { onSuccess: () => setEditing(false) })
            }
          >
            Enregistrer
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
            Annuler
          </Button>
        </>
      ) : (
        <>
          <span className={cn('font-mono', d.targetName ? 'text-gray-800' : 'text-amber-700')}>
            {d.targetName ?? 'impossible à déduire'}
          </span>
          <span className="text-gray-400">
            {d.targetName ? (d.targetNameAuto ? '(convention)' : '(saisi)') : ''}
          </span>
          {canWrite && !locked && (
            <>
              <button
                className="text-primary-600 hover:underline"
                onClick={() => {
                  setValue(d.targetName ?? '')
                  setEditing(true)
                }}
              >
                Modifier
              </button>
              {!d.targetNameAuto && (
                <button
                  className="text-gray-500 hover:underline"
                  onClick={() => update.mutate({ id: d.id, name: null })}
                >
                  Revenir à la convention
                </button>
              )}
            </>
          )}
        </>
      )}
      {d.targetNameConflict && (
        <span className="text-red-600">déjà attribué à {d.targetNameConflict}</span>
      )}
      {update.error && <span className="text-red-600">{(update.error as Error).message}</span>}
    </div>
  )
}

export function MigrationPanel({ d, canWrite }: { d: DeviceMigrationRecord; canWrite: boolean }) {
  const { confirm } = useConfirm()
  const schedule = useScheduleMigration()
  const cancel = useCancelMigration()
  const abandon = useAbandonMigration()
  const clear = useClearMigration()
  const resume = useResumeMigration()
  const [secret, setSecret] = useState<{ user: string; password: string } | null>(null)
  // true : prévenir l'utilisateur connecté et attendre « Démarrer » ; false : seulement hors session
  const [promptUser, setPromptUser] = useState(true)
  // Décision DSI (20/10/2026) : uniquement la bascule en place
  const mode: MigrationMode = 'inplace'
  const [targets, setTargets] = useState<Record<string, string | null>>({})
  // Profil conservé et transféré ; null = le dernier connecté, choisi par le serveur
  const [mainSid, setMainSid] = useState<string | null>(null)
  const m = d.migration
  const active = !!m && ACTIVE.includes(m.status)
  const block = blockers(d, mode)
  const preview = useProfilePreview(
    d.id,
    targets,
    mainSid,
    canWrite && !active && mode === 'inplace' && !!d.agent
  )
  const previewProfiles = preview.data?.profiles ?? []
  const mainProfile = previewProfiles.find((p) => p.action === 'migrate')
  const removedProfiles = previewProfiles.filter((p) => p.action === 'delete')
  const previewBlock =
    mode === 'inplace' && preview.data
      ? !mainProfile
        ? 'Aucun profil d’utilisateur ONELA sur ce poste'
        : mainProfile.error
          ? `Profil conservé : ${mainProfile.error}`
          : !mainProfile.newSid
            ? 'Compte Ouihelp du profil conservé à choisir'
            : null
      : null
  const silentReset =
    m?.status === 'resetting' &&
    m.updatedAt &&
    Date.now() - new Date(m.updatedAt).getTime() > RESET_SILENCE_MS

  const onSchedule = async () => {
    const trigger = promptUser
      ? 'L’agent prévient l’utilisateur connecté et attend qu’il clique « Démarrer » (ou agit tout de suite si personne n’est connecté). '
      : 'L’agent agit dès qu’aucune session n’est ouverte. '
    const res = await confirm({
      title: `Basculer ${d.displayName ?? 'ce poste'} vers Ouihelp (en place) ?`,
      message: (
        <div className="space-y-2 text-sm">
          <p>
            {trigger}Le serveur retire le poste d’Autopilot ONELA, puis le poste quitte ONELA,
            rejoint Entra et Intune Ouihelp avec le PPKG, et prend le nom{' '}
            <strong>{d.targetName}</strong>.
          </p>
          <p>
            <strong>Windows, applications et fichiers sont conservés.</strong> Le profil de{' '}
            <strong>{mainProfile?.oldUpn ?? mainProfile?.oldAccount}</strong> est transféré au
            compte <strong>{mainProfile?.newUpn}</strong>. Les applications décochées dans le
            catalogue « Applications » sont désinstallées.
          </p>
          {removedProfiles.length > 0 && (
            <p className="text-amber-700">
              <strong>{removedProfiles.length} autre(s) profil(s) seront supprimés du poste</strong>{' '}
              (clé de registre et dossier de C:\Users, données locales comprises) :{' '}
              {removedProfiles.map((p) => p.oldUpn ?? p.oldAccount ?? p.oldSid).join(', ')}.
            </p>
          )}
          <p>
            Deux redémarrages, puis l’utilisateur se connecte avec son adresse Ouihelp et retrouve
            son bureau. Annulation possible jusqu’à l’étape « prêt ».
          </p>
        </div>
      ),
      confirmLabel: 'Programmer la bascule',
    })
    if (!res.confirmed) return
    schedule.mutate({
      id: d.id,
      mode,
      promptUser,
      profileTargets: targets,
      mainProfileSid: mainSid,
    })
  }

  // En place, après « bascule en cours », le poste a déjà quitté ONELA : l'agent termine le
  // travail local (profils, jonction) même abandonné ici, sinon le poste resterait entre deux.
  const switchStarted =
    m?.mode === 'inplace' && (m.status === 'resetting' || m.status === 'joining')

  // Bascule en place en échec après le point de non-retour : le poste a quitté ONELA, l'agent
  // peut reprendre le travail restant (profils, jonction) au lieu d'une reprise manuelle.
  const canResume = m?.mode === 'inplace' && m.status === 'failed' && m.profiles.length > 0

  const onResume = async () => {
    const res = await confirm({
      title: 'Reprendre la bascule sur le poste ?',
      message:
        'L’agent repart de l’étape atteinte sur le poste : transfert du profil s’il reste à faire, puis jonction Ouihelp. Si le poste est encore rattaché à ONELA, il refusera et il faudra reprogrammer une bascule complète.',
      confirmLabel: 'Reprendre',
    })
    if (res.confirmed) resume.mutate(d.id)
  }

  const onAbandon = async () => {
    const res = await confirm({
      title: 'Abandonner cette bascule ?',
      tone: 'danger',
      message: switchStarted
        ? 'La bascule passe en échec dans la DSI App pour pouvoir en programmer une autre. Le poste a déjà quitté ONELA : l’agent continue sur place (transfert des profils, jonction Ouihelp) et la finalisation côté tenants ne sera pas faite. À vérifier sur le poste.'
        : 'La bascule passe en échec dans la DSI App pour pouvoir en programmer une autre. Rien n’est fait sur le poste ni dans les tenants : à reprendre à la main.',
      confirmLabel: 'Abandonner',
    })
    if (res.confirmed) abandon.mutate(d.id)
  }

  const onClear = async () => {
    const res = await confirm({
      title: 'Remettre ce poste « à migrer » ?',
      message:
        'Le suivi de la bascule (journal, profils, compte de secours) est effacé de la DSI App. Rien n’est fait sur le poste ni dans les tenants : à utiliser quand le PC a été remis sur ONELA.',
      confirmLabel: 'Remettre à migrer',
    })
    if (res.confirmed) clear.mutate(d.id)
  }

  return (
    <div className="space-y-3 border-t border-gray-200 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-gray-700">
          <RotateCcw className="h-4 w-4" /> Bascule vers Ouihelp
          {m &&
            (m.mode === 'inplace' ? ' (en place, profil conservé)' : ' (réinstallation propre)')}
          {m && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                MIGRATION_CFG[m.status].cls
              )}
            >
              {migrationLabel(m)}
            </span>
          )}
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {m?.hasBreakglass && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => setSecret(await deviceMigrationApi.breakglass(d.id))}
                title="Compte administrateur local créé par la réinstallation (consultation tracée)"
              >
                <Eye className="mr-1.5 h-4 w-4" /> Compte de secours
              </Button>
            )}
            {m && CANCELLABLE.includes(m.status) && (
              <Button
                size="sm"
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(d.id)}
              >
                Annuler la bascule
              </Button>
            )}
            {m && ['done', 'failed', 'cancelled'].includes(m.status) && (
              <Button size="sm" variant="outline" disabled={clear.isPending} onClick={onClear}>
                Remettre à migrer
              </Button>
            )}
            {m && ['cleanup', 'ready', 'resetting', 'joining'].includes(m.status) && (
              <Button size="sm" variant="outline" disabled={abandon.isPending} onClick={onAbandon}>
                Abandonner
              </Button>
            )}
            {canResume && (
              <Button size="sm" variant="outline" disabled={resume.isPending} onClick={onResume}>
                Reprendre la bascule
              </Button>
            )}
            {!active && (
              <Button
                size="sm"
                disabled={
                  block.length > 0 ||
                  schedule.isPending ||
                  (mode === 'inplace' && (!preview.data || !!previewBlock))
                }
                onClick={onSchedule}
              >
                {m ? 'Reprogrammer' : 'Programmer la bascule'}
              </Button>
            )}
          </div>
        )}
      </div>

      {canWrite && !active && (
        <div className="flex flex-wrap items-center gap-4 text-gray-600">
          <span className="text-gray-400">Déclenchement :</span>
          <label className="flex items-center gap-1">
            <input type="radio" checked={promptUser} onChange={() => setPromptUser(true)} />
            Prévenir l’utilisateur (fenêtre « Démarrer / Plus tard », 3 reports)
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={!promptUser} onChange={() => setPromptUser(false)} />
            Seulement hors session
          </label>
        </div>
      )}
      {m && m.promptUser && ['scheduled', 'staging'].includes(m.status) && (
        <p className={cn('text-xs', m.snoozeExhausted ? 'text-amber-700' : 'text-gray-500')}>
          Mode avertissement
          {m.snoozeCount > 0 && ` — ${m.snoozeCount} report(s) par l’utilisateur`}
          {m.snoozeExhausted && ' — reports épuisés : relancer l’utilisateur'}
        </p>
      )}

      <TargetName d={d} canWrite={canWrite} locked={active} />

      {m?.mode === 'inplace' && m.profiles.length > 0 && (active || m.status === 'done') ? (
        <ProfileMap
          profiles={m.profiles}
          editable={false}
          targets={{}}
          setTargets={() => {}}
          mainSid={null}
          setMainSid={() => {}}
        />
      ) : (
        canWrite &&
        !active &&
        mode === 'inplace' &&
        d.agent &&
        (preview.isLoading ? (
          <Spinner />
        ) : preview.error ? (
          <p className="text-red-600">{(preview.error as Error).message}</p>
        ) : (
          <ProfileMap
            profiles={previewProfiles}
            editable
            targets={targets}
            setTargets={setTargets}
            mainSid={mainSid}
            setMainSid={setMainSid}
          />
        ))
      )}

      {!active && (block.length > 0 || previewBlock) && (
        <p className="text-gray-500">
          Non programmable : {[...block, ...(previewBlock ? [previewBlock] : [])].join(' · ')}
        </p>
      )}
      {clear.error && <p className="text-red-600">{(clear.error as Error).message}</p>}
      {(schedule.error || cancel.error || abandon.error) && (
        <p className="text-red-600">
          {((schedule.error ?? cancel.error ?? abandon.error) as Error).message}
        </p>
      )}
      {m?.error && (
        <div className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
          <ShieldAlert className="h-4 w-4 shrink-0" /> {m.error}
        </div>
      )}
      {silentReset && (
        <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          {m?.mode === 'inplace'
            ? 'Aucune nouvelle du poste depuis plus de 3 h après le début de la bascule : vérifier sur place (compte de secours .\\dsi-secours), puis « Abandonner » si besoin.'
            : 'Aucune nouvelle du poste depuis plus de 3 h après le lancement de la réinitialisation : il est sans doute resté sur l’installation de Windows ou dans l’environnement de récupération. Intervention sur place, puis « Abandonner ».'}
        </div>
      )}
      {secret && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-white px-3 py-2">
          <span>
            <span className="text-gray-400">Compte :</span>{' '}
            <span className="font-mono">.\{secret.user}</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="text-gray-400">Mot de passe :</span>{' '}
            <span className="font-mono">{secret.password}</span>{' '}
            <CopyButton text={secret.password} />
          </span>
          <span className="text-gray-400">Administrateur local créé par la bascule.</span>
        </div>
      )}

      {m && m.steps.length > 0 && (
        <ol className="space-y-1">
          {[...m.steps].reverse().map((s, i) => (
            <li key={`${s.at}-${i}`} className="flex gap-2">
              {s.status === 'ok' ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              ) : s.status === 'error' ? (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
              ) : (
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
              )}
              <span className="w-28 shrink-0 text-gray-400">{fmtDateTime(s.at)}</span>
              <span className="w-16 shrink-0 text-gray-400">{s.source}</span>
              <span
                className={cn(
                  'min-w-0 break-words',
                  s.status === 'error' ? 'text-red-700' : 'text-gray-700'
                )}
              >
                {s.message}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// ── Catalogue des applications (bascule en place) ───────────────────────────

type AppFilter = 'all' | 'review' | 'keep' | 'remove'

/**
 * Applications vues par les agents, une règle par application pour tout le parc : cochée =
 * conservée, décochée = désinstallée à la bascule en place. Jamais revue = conservée.
 */
export function AppsPanel({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading, error } = useAppCatalog(true)
  const update = useUpdateAppRules()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<AppFilter>('all')
  const apps = data?.apps ?? []
  const needle = q.trim().toLowerCase()
  const visible = apps.filter((a: DeviceAppCatalogEntry) => {
    if (needle && !`${a.name} ${a.publisher ?? ''}`.toLowerCase().includes(needle)) return false
    if (filter === 'review') return a.keep === null
    if (filter === 'keep') return a.keep === true
    if (filter === 'remove') return a.keep === false
    return true
  })
  const toReview = apps.filter((a) => a.keep === null).length
  const toRemove = apps.filter((a) => a.keep === false).length

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-gray-700">
          Applications du parc ({apps.length}) — {toRemove} à désinstaller, {toReview} à revoir
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-56 rounded-md border border-gray-300 px-2 py-1"
            placeholder="Rechercher une application"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="rounded-md border border-gray-300 px-2 py-1"
            value={filter}
            onChange={(e) => setFilter(e.target.value as AppFilter)}
          >
            <option value="all">Toutes</option>
            <option value="review">À revoir</option>
            <option value="keep">Conservées</option>
            <option value="remove">À désinstaller</option>
          </select>
          {canWrite && visible.some((a) => a.keep === null) && (
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  keys: visible.filter((a) => a.keep === null).map((a) => a.key),
                  keep: true,
                })
              }
            >
              Marquer les affichées « à revoir » comme conservées
            </Button>
          )}
        </div>
      </div>
      <p className="text-gray-500">
        Cochée = conservée ; <strong>décochée = désinstallée</strong> lors de la bascule en place
        (règle valable pour tout le parc). Une application jamais revue est conservée. Seules les
        désinstallations silencieuses (MSI ou commande prévue par l’éditeur) sont lancées ; les
        autres restent en place et sont signalées dans le journal.
      </p>
      {update.error && <p className="text-red-600">{(update.error as Error).message}</p>}
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <p className="text-red-600">{(error as Error).message}</p>
      ) : apps.length === 0 ? (
        <p className="text-gray-500">
          Aucune application remontée : l’inventaire arrive avec l’agent 1.2.0.
        </p>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-gray-400">
                <th className="py-1 pr-2 font-normal">Conserver</th>
                <th className="py-1 pr-3 font-normal">Application</th>
                <th className="py-1 pr-3 font-normal">Éditeur</th>
                <th className="py-1 pr-3 text-right font-normal">Postes</th>
                <th className="py-1 font-normal">Désinstallation silencieuse</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.key} className="border-t border-gray-100">
                  <td className="py-1 pr-2">
                    <input
                      type="checkbox"
                      disabled={!canWrite || update.isPending}
                      checked={a.keep !== false}
                      onChange={(e) => update.mutate({ keys: [a.key], keep: e.target.checked })}
                    />
                  </td>
                  <td className="py-1 pr-3">
                    <span className={cn(a.keep === false && 'text-red-700 line-through')}>
                      {a.name}
                    </span>
                    {a.keep === null && (
                      <span className="ml-2 rounded bg-amber-50 px-1.5 text-[10px] text-amber-700">
                        à revoir
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-3 text-gray-500">{a.publisher ?? '—'}</td>
                  <td className="py-1 pr-3 text-right">{a.deviceCount}</td>
                  <td
                    className={cn(
                      'py-1',
                      a.uninstallableCount < a.deviceCount ? 'text-amber-700' : 'text-gray-500'
                    )}
                  >
                    {a.uninstallableCount === a.deviceCount
                      ? 'oui'
                      : `${a.uninstallableCount} / ${a.deviceCount} postes`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
