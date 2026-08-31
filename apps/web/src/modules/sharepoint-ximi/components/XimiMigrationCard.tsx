import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Play,
  Pause,
  Trash2,
  AlertTriangle,
  Building2,
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Users,
  ShieldAlert,
  FileClock,
  Archive,
  ArchiveRestore,
  Pencil,
  Check,
  X,
  Trash,
  MoveRight,
} from 'lucide-react'
import type { XimiMigrationRecord, XimiStepStatus } from '@dsi-app/shared'
import {
  useRunXimiMigration,
  usePauseXimiMigration,
  useUnstickXimiMigration,
  useRetryXimiPermissions,
  useRenameXimiMigration,
  useArchiveXimiMigration,
  useUnarchiveXimiMigration,
  useDeleteXimiMigration,
} from '../hooks/useXimiMigration'
import { ximiApi } from '../api'

function fmtBytes(n: number): string {
  if (!n) return '0 o'
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const STATUS_STYLES: Record<
  XimiMigrationRecord['status'],
  { label: string; cls: string; icon: React.ElementType }
> = {
  pending: { label: 'En attente', cls: 'bg-gray-100 text-gray-700', icon: Loader2 },
  running: { label: 'En cours', cls: 'bg-blue-100 text-blue-700', icon: Loader2 },
  paused: { label: 'En pause', cls: 'bg-amber-100 text-amber-700', icon: Pause },
  success: { label: 'Terminé', cls: 'bg-green-100 text-green-700', icon: CheckCircle2 },
  error: { label: 'Erreur', cls: 'bg-red-100 text-red-700', icon: XCircle },
}

const STEP_STYLES: Record<XimiStepStatus, string> = {
  pending: 'bg-gray-100 text-gray-600',
  running: 'bg-blue-100 text-blue-700',
  success: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  skipped: 'bg-gray-100 text-gray-400',
}

const STEP_LABELS: Record<XimiStepStatus, string> = {
  pending: 'à faire',
  running: 'en cours',
  success: 'OK',
  error: 'échec',
  skipped: 'sans objet',
}

export function XimiMigrationCard({ migration: m }: { migration: XimiMigrationRecord }) {
  const [showChanges, setShowChanges] = useState(false)
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const run = useRunXimiMigration()
  const pause = usePauseXimiMigration()
  const unstick = useUnstickXimiMigration()
  const retryPerms = useRetryXimiPermissions()
  const rename = useRenameXimiMigration()
  const archive = useArchiveXimiMigration()
  const unarchive = useUnarchiveXimiMigration()
  const del = useDeleteXimiMigration()

  const isActive = m.status === 'running' || m.status === 'pending'
  const status = STATUS_STYLES[m.status]
  const StatusIcon = status.icon

  const total = Math.max(m.totalItems, m.migratedItems + m.failedItems + m.skippedItems)
  // Progression en OCTETS : 30 000 petits fichiers et 50 gros ne représentent
  // pas le même travail. Repli sur les fichiers tant que le pré-comptage n'a pas
  // figé totalBytes.
  const pct =
    m.totalBytes > 0
      ? Math.min(100, Math.round((m.processedBytes / m.totalBytes) * 100))
      : total > 0
        ? Math.round(((m.migratedItems + m.skippedItems) / total) * 100)
        : 0
  const scanPct = total > 0 ? Math.min(100, Math.round((m.scannedItems / total) * 100)) : 0

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      {/* En-tête : agence / site */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 shrink-0 text-gray-400" />
            {editingLabel === null ? (
              <>
                <h3 className="truncate font-semibold text-gray-900">
                  {m.label || m.sourceSiteName}
                </h3>
                <button
                  onClick={() => setEditingLabel(m.label ?? '')}
                  className="shrink-0 text-gray-300 hover:text-gray-600"
                  title="Renommer cette migration"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <form
                className="flex min-w-0 flex-1 items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  rename.mutate(
                    { id: m.id, label: editingLabel },
                    { onSuccess: () => setEditingLabel(null) },
                  )
                }}
              >
                <input
                  autoFocus
                  value={editingLabel}
                  onChange={(e) => setEditingLabel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setEditingLabel(null)}
                  maxLength={200}
                  placeholder={m.sourceSiteName}
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm font-semibold focus:border-blue-500 focus:outline-none"
                />
                <button type="submit" className="shrink-0 rounded p-1 text-green-600 hover:bg-green-50">
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingLabel(null)}
                  className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </form>
            )}
          </div>
          {/* Le couple d'URL est l'information que Ximi attend : on l'affiche
              directement sur la carte, pas seulement dans le tableau exporté. */}
          <div className="mt-1 space-y-0.5 text-xs">
            <a
              href={m.sourceSiteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1 truncate text-gray-500 hover:text-blue-600"
            >
              <span className="shrink-0 font-medium text-gray-400">ONELA</span>
              <span className="truncate">{m.sourceSiteUrl}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
            {m.targetSiteUrl ? (
              <a
                href={m.targetSiteUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center gap-1 truncate text-gray-500 hover:text-blue-600"
              >
                <span className="shrink-0 font-medium text-gray-400">Ouihelp</span>
                <span className="truncate">{m.targetSiteUrl}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <p className="text-gray-400">
                Ouihelp — site non créé
                {m.targetSiteAlias ? ` (alias prévu : /sites/${m.targetSiteAlias})` : ''}
              </p>
            )}
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${status.cls}`}
        >
          <StatusIcon className={`h-3.5 w-3.5 ${isActive ? 'animate-spin' : ''}`} />
          {status.label}
        </span>
      </div>

      {/* Étapes site + droits */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded px-2 py-0.5 font-medium ${STEP_STYLES[m.siteStatus]}`}>
          Site : {STEP_LABELS[m.siteStatus]}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium ${STEP_STYLES[m.permissionStatus]}`}
          title={m.dynamicGroupName ?? 'Aucun groupe dynamique associé'}
        >
          <Users className="h-3 w-3" />
          Droits : {STEP_LABELS[m.permissionStatus]}
        </span>
        {m.dynamicGroupName && (
          <span className="truncate text-gray-500">{m.dynamicGroupName}</span>
        )}
        {m.hasDeltaToken && (
          <span
            className="rounded bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700"
            title="Une passe complète a déjà eu lieu : les prochaines synchros ne reprennent que les changements"
          >
            Synchro delta armée
          </span>
        )}
      </div>

      {(m.siteError || m.permissionError) && (
        <div className="mt-2 space-y-1">
          {m.siteError && (
            <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
              Création du site : {m.siteError}
            </p>
          )}
          {m.permissionError && (
            <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <ShieldAlert className="mr-1 inline h-3.5 w-3.5" />
              Droits : {m.permissionError}
            </p>
          )}
        </div>
      )}

      {/* Progression */}
      {m.analyzeOnly ? (
        <div className="mt-3 flex items-center justify-between text-xs text-gray-600">
          <span>{m.totalItems.toLocaleString('fr-FR')} fichiers</span>
          <span className="font-medium text-gray-800">{fmtBytes(m.totalBytes)}</span>
        </div>
      ) : (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
            <span>
              {m.migratedItems.toLocaleString('fr-FR')} / {total.toLocaleString('fr-FR')} fichiers
              {m.updatedItems > 0 && (
                <span className="ml-1 text-blue-600">· {m.updatedItems} mis à jour</span>
              )}
              {m.movedItems > 0 && (
                <span className="ml-1 text-indigo-600">· {m.movedItems} déplacés</span>
              )}
              {m.deletedItems > 0 && (
                <span className="ml-1 text-rose-600">· {m.deletedItems} supprimés</span>
              )}
              {m.failedItems > 0 && (
                <span className="ml-1 text-red-600">· {m.failedItems} échec(s)</span>
              )}
              {m.skippedItems > 0 && (
                <span className="ml-1 text-amber-600">· {m.skippedItems} ignoré(s)</span>
              )}
            </span>
            <span>
              {fmtBytes(m.migratedBytes)}
              {m.totalBytes > 0 && <span className="text-gray-400"> / {fmtBytes(m.totalBytes)}</span>}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-full rounded-full transition-[width] duration-700 ease-out ${
                  m.failedItems > 0 ? 'bg-amber-500' : 'bg-blue-600'
                } ${isActive ? 'animate-pulse' : ''}`}
                style={{ width: `${Math.max(pct, pct > 0 ? 1.5 : 0)}%` }}
              />
            </div>
            <span
              className={`w-12 shrink-0 text-right text-xs font-semibold tabular-nums ${
                m.failedItems > 0 ? 'text-amber-700' : 'text-blue-700'
              }`}
            >
              {pct}%
            </span>
          </div>

          {/* Sur une passe delta, la barre en octets est à 100 % dès la première
              seconde (tout est déjà migré) : seul le parcours dit où on en est. */}
          {isActive && total > 0 && (
            <div className="mt-2">
              <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
                <span>
                  Parcours : {m.scannedItems.toLocaleString('fr-FR')} /{' '}
                  {total.toLocaleString('fr-FR')}
                </span>
                <span className="tabular-nums">{scanPct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-gray-400 transition-[width] duration-700"
                  style={{ width: `${Math.max(scanPct, scanPct > 0 ? 1.5 : 0)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {m.errorDetails && (
        <div className="mt-3 rounded bg-gray-50 px-3 py-2 text-xs text-gray-700">
          {m.errorDetails}
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!isActive && !m.archived && (
          <button
            onClick={() => run.mutate(m.id)}
            disabled={run.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {m.analyzeOnly
              ? "Relancer l'analyse"
              : // Relancer une migration terminée ne recopie rien : la passe est un
                // delta (ajouts, modifs, suppressions, déplacements).
                m.hasDeltaToken
                ? 'Synchroniser (delta)'
                : m.migratedItems > 0
                  ? 'Reprendre'
                  : 'Lancer la pré-migration'}
          </button>
        )}
        {isActive && (
          <button
            onClick={() => pause.mutate(m.id)}
            disabled={pause.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            <Pause className="h-3.5 w-3.5" />
            Mettre en pause
          </button>
        )}
        {m.status === 'running' && (
          <button
            onClick={() => unstick.mutate(m.id)}
            disabled={unstick.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="Forcer le statut en erreur si le worker est bloqué (redéploiement, hang)"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Débloquer
          </button>
        )}
        {/* L'attribution des droits est non bloquante pendant le transfert : il
            faut pouvoir la rejouer seule, sans relancer des dizaines de Go. */}
        {m.permissionStatus === 'error' && !isActive && (
          <button
            onClick={() => retryPerms.mutate({ id: m.id })}
            disabled={retryPerms.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
          >
            <Users className="h-3.5 w-3.5" />
            Réappliquer les droits
          </button>
        )}
        {!m.analyzeOnly && m.startedAt && (
          <button
            onClick={() => setShowChanges((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            <FileClock className="h-3.5 w-3.5" />
            {showChanges ? 'Masquer' : 'Voir'} les changements
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!m.archived ? (
            <button
              onClick={() => archive.mutate(m.id)}
              disabled={isActive || archive.isPending}
              className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-40"
              title={isActive ? 'Mets la migration en pause avant de l’archiver' : 'Archiver'}
            >
              <Archive className="h-3.5 w-3.5" />
              Archiver
            </button>
          ) : (
            <button
              onClick={() => unarchive.mutate(m.id)}
              className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50"
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
              Désarchiver
            </button>
          )}
          <button
            onClick={() => {
              // La suppression ne touche PAS au site Ouihelp : le dire ici évite
              // de croire qu'on annule la migration.
              if (
                confirm(
                  `Supprimer le suivi de « ${m.label || m.sourceSiteName} » ?\n\n` +
                    `Le site Ouihelp et ses fichiers ne sont PAS supprimés — seul le suivi ` +
                    `disparaît. Une nouvelle migration repartirait de zéro et créerait des doublons.`,
                )
              ) {
                del.mutate(m.id)
              }
            }}
            disabled={isActive || del.isPending}
            className="inline-flex items-center gap-1.5 rounded border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Supprimer
          </button>
        </div>
      </div>

      {showChanges && <ChangesPanel migrationId={m.id} />}
    </div>
  )
}

/** Détail de ce que la dernière passe a changé — la vérification du jour J. */
function ChangesPanel({ migrationId }: { migrationId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['ximi-changes', migrationId],
    queryFn: () => ximiApi.changes(migrationId),
    staleTime: 10_000,
  })

  if (isLoading) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Chargement des changements…
      </div>
    )
  }
  if (!data) return null

  const sections = [
    { title: 'Créés', items: data.created, count: data.createdCount, cls: 'text-green-700', Icon: Check },
    { title: 'Mis à jour', items: data.updated, count: data.updatedCount, cls: 'text-blue-700', Icon: FileClock },
    { title: 'Supprimés', items: data.deleted, count: data.deletedCount, cls: 'text-rose-700', Icon: Trash },
  ]

  return (
    <div className="mt-3 rounded border border-gray-100 bg-gray-50 p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
        <span>
          Passe du{' '}
          {data.runStartedAt
            ? new Date(data.runStartedAt).toLocaleString('fr-FR')
            : '(non démarrée)'}
        </span>
        {/* Les déplacements/renommages sont un compteur de passe, pas un statut
            de ligne : on affiche le total sans liste détaillée. */}
        {data.movedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-indigo-700">
            <MoveRight className="h-3.5 w-3.5" />
            {data.movedCount} déplacé(s)/renommé(s)
          </span>
        )}
      </div>
      <div className="space-y-3">
        {sections.map((s) => (
          <div key={s.title}>
            <p className={`mb-1 text-xs font-semibold ${s.cls}`}>
              <s.Icon className="mr-1 inline h-3.5 w-3.5" />
              {s.title} — {s.count.toLocaleString('fr-FR')}
            </p>
            {s.items.length === 0 ? (
              <p className="text-xs text-gray-400">Aucun</p>
            ) : (
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-gray-600">
                {s.items.slice(0, 200).map((i) => (
                  <li key={i.id} className="truncate" title={i.spPath ?? undefined}>
                    {i.spPath ?? i.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {data.truncated && (
        <p className="mt-2 text-xs text-gray-400">
          Listes tronquées (500 max) — les compteurs, eux, sont exacts.
        </p>
      )}
    </div>
  )
}
