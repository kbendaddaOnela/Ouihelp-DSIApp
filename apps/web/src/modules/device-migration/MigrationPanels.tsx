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
import type { DeviceMigrationRecord, MigrationStatus } from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { CopyButton } from '@/modules/migration/components/CopyButton'
import { deviceMigrationApi } from './api'
import {
  useCancelMigration,
  useMigrationPackage,
  useScheduleMigration,
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

/** Raisons de ne pas pouvoir programmer (mêmes garde-fous que l'API, affichés d'avance). */
function blockers(d: DeviceMigrationRecord): string[] {
  const b: string[] = []
  if (d.joinType !== 'entra_joined') b.push('Pilote limité aux PC Entra Joined')
  if (!d.serialNumber) b.push('N° de série inconnu')
  if (!d.agent) b.push('Agent DSI non installé')
  else {
    if (d.agent.silent) b.push('Agent silencieux depuis plus de 24 h')
    if (d.agent.report.winreEnabled === false) b.push('WinRE désactivé')
    if (
      d.agent.report.network.wifi &&
      d.agent.report.network.wifiProfiles.length === 0 &&
      !d.agent.report.network.ethernet
    )
      b.push('Aucun profil Wi-Fi enregistré à restaurer')
  }
  return b
}

export function MigrationPanel({ d, canWrite }: { d: DeviceMigrationRecord; canWrite: boolean }) {
  const { confirm, alert } = useConfirm()
  const schedule = useScheduleMigration()
  const cancel = useCancelMigration()
  const [secret, setSecret] = useState<{ user: string; password: string } | null>(null)
  const m = d.migration
  const active = !!m && ACTIVE.includes(m.status)
  const block = blockers(d)
  const silentReset =
    m?.status === 'resetting' &&
    m.updatedAt &&
    Date.now() - new Date(m.updatedAt).getTime() > RESET_SILENCE_MS

  const onSchedule = async () => {
    const res = await confirm({
      title: `Réinstaller ${d.displayName ?? 'ce poste'} pour Ouihelp ?`,
      tone: 'danger',
      message: (
        <div className="space-y-2 text-sm">
          <p>
            Dès qu’aucune session n’est ouverte, l’agent prépare le poste, le serveur le retire
            d’Autopilot ONELA, puis <strong>Windows est réinitialisé (« Supprimer tout »)</strong>.
          </p>
          <p>
            Toutes les données locales sont <strong>effacées</strong>. Le poste rejoint ensuite
            Entra et Intune Ouihelp tout seul ; l’utilisateur se connecte avec son compte Ouihelp.
          </p>
          <p>Annulation possible jusqu’à l’étape « prêt ».</p>
        </div>
      ),
      checkbox: { label: 'J’ai compris que le poste sera entièrement effacé' },
      confirmLabel: 'Programmer la réinstallation',
    })
    if (!res.confirmed) return
    if (!res.checked) {
      await alert({
        title: 'Non programmé',
        message: 'Cochez la case de confirmation pour programmer la réinstallation.',
      })
      return
    }
    schedule.mutate(d.id)
  }

  return (
    <div className="space-y-3 border-t border-gray-200 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-gray-700">
          <RotateCcw className="h-4 w-4" /> Bascule vers Ouihelp (réinstallation propre)
          {m && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                MIGRATION_CFG[m.status].cls
              )}
            >
              {MIGRATION_CFG[m.status].label}
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
            {!active && (
              <Button
                size="sm"
                variant="destructive"
                disabled={block.length > 0 || schedule.isPending}
                onClick={onSchedule}
              >
                {m ? 'Reprogrammer' : 'Programmer la réinstallation'}
              </Button>
            )}
          </div>
        )}
      </div>

      {!active && block.length > 0 && (
        <p className="text-gray-500">Non programmable : {block.join(' · ')}</p>
      )}
      {(schedule.error || cancel.error) && (
        <p className="text-red-600">{((schedule.error ?? cancel.error) as Error).message}</p>
      )}
      {m?.error && (
        <div className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
          <ShieldAlert className="h-4 w-4 shrink-0" /> {m.error}
        </div>
      )}
      {silentReset && (
        <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          Aucune nouvelle du poste depuis plus de 3 h après le lancement de la réinitialisation : il
          est sans doute resté sur l’installation de Windows (Wi-Fi non restauré, script de
          réinitialisation non exécuté). Intervention sur place avec le compte de secours ou un
          compte Ouihelp.
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
          <span className="text-gray-400">Renouvelé ensuite par LAPS Ouihelp.</span>
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
