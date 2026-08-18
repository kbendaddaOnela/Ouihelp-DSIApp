import { useState, useEffect } from 'react'
import {
  Play,
  Pause,
  Trash2,
  AlertTriangle,
  HardDriveDownload,
  Loader2,
  CheckCircle2,
  XCircle,
  FolderOpen,
  FileClock,
  Download,
  Archive,
  ArchiveRestore,
  Pencil,
  Check,
  X,
} from 'lucide-react'
import type {
  SharepointMigrationRecord,
  SharepointChangedItem,
  SharepointMigrationChangesResponse,
} from '@dsi-app/shared'
import {
  useRunSharepointMigration,
  usePauseSharepointMigration,
  useUnstickSharepointMigration,
  useRenameSharepointMigration,
  useArchiveSharepointMigration,
  useUnarchiveSharepointMigration,
  useDeleteSharepointMigration,
} from '../hooks/useSharepointMigration'
import { sharepointMigrationApi } from '../api'

function fmtBytes(n: number): string {
  if (!n) return '0 o'
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function fmtDuration(sec: number): string {
  if (sec < 90) return 'moins d’une minute'
  const h = Math.floor(sec / 3600)
  const min = Math.round((sec % 3600) / 60)
  if (h === 0) return `${min} min`
  if (h < 24) return min > 0 ? `${h} h ${min} min` : `${h} h`
  return `${Math.floor(h / 24)} j ${h % 24} h`
}

const STATUS_STYLES: Record<
  SharepointMigrationRecord['status'],
  { label: string; cls: string; icon: React.ElementType }
> = {
  pending: { label: 'En attente', cls: 'bg-gray-100 text-gray-700', icon: Loader2 },
  running: { label: 'En cours', cls: 'bg-blue-100 text-blue-700', icon: Loader2 },
  paused: { label: 'En pause', cls: 'bg-amber-100 text-amber-700', icon: Pause },
  success: { label: 'Terminé', cls: 'bg-green-100 text-green-700', icon: CheckCircle2 },
  error: { label: 'Erreur', cls: 'bg-red-100 text-red-700', icon: XCircle },
}

export function SharepointMigrationCard({ migration: m }: { migration: SharepointMigrationRecord }) {
  const [showErrors, setShowErrors] = useState(false)
  const [showChanges, setShowChanges] = useState(false)
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const run = useRunSharepointMigration()
  const pause = usePauseSharepointMigration()
  const unstick = useUnstickSharepointMigration()
  const rename = useRenameSharepointMigration()
  const archive = useArchiveSharepointMigration()
  const unarchive = useUnarchiveSharepointMigration()
  const del = useDeleteSharepointMigration()

  const isActive = m.status === 'running' || m.status === 'pending'
  const status = STATUS_STYLES[m.status]
  const StatusIcon = status.icon
  // Les fichiers ignorés (trop volumineux) sont « traités » : ils comptent dans
  // la progression mais ne sont pas des erreurs (barre ambre seulement si vrai échec).
  const total = Math.max(m.totalItems, m.migratedItems + m.failedItems + m.skippedItems)
  // La progression se mesure en OCTETS, pas en nombre de fichiers : 30 000 petits
  // fichiers et 50 gros ne représentent pas le même travail, et un % au fichier
  // avance par à-coups sans rapport avec le temps restant.
  // Repli sur les fichiers tant que le pré-comptage n'a pas figé totalBytes.
  const pct =
    m.totalBytes > 0
      ? Math.min(100, Math.round((m.processedBytes / m.totalBytes) * 100))
      : total > 0
        ? Math.round(((m.migratedItems + m.skippedItems) / total) * 100)
        : 0
  const hasDetails = m.failedItems > 0 || m.skippedItems > 0
  const scanPct = total > 0 ? Math.min(100, Math.round((m.scannedItems / total) * 100)) : 0
  // Estimation de fin : extrapolation linéaire du rythme de parcours observé
  // depuis le début du run. Volontairement basée sur le PARCOURS et non sur les
  // octets — c'est lui qui commande la durée (cf. ADV : 158 519 petits fichiers).
  const eta = (() => {
    if (!isActive || !m.startedAt || m.scannedItems < 50 || total <= m.scannedItems) return null
    const elapsedSec = (Date.now() - new Date(m.startedAt).getTime()) / 1000
    if (elapsedSec < 30) return null
    const remainingSec = ((total - m.scannedItems) * elapsedSec) / m.scannedItems
    return fmtDuration(remainingSec)
  })()

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <HardDriveDownload className="h-4 w-4 shrink-0 text-gray-400" />
            {editingLabel === null ? (
              <>
                {/* Le libellé libre prime ; sans lui on retombe sur le nom du Drive. */}
                <h3 className="truncate font-semibold text-gray-900">
                  {m.label || m.gdSharedDriveName}
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
                  placeholder={m.gdSharedDriveName}
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm font-semibold text-gray-900 focus:border-blue-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={rename.isPending}
                  className="shrink-0 rounded p-1 text-green-600 hover:bg-green-50 disabled:opacity-50"
                  title="Enregistrer (vide = nom du Drive)"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingLabel(null)}
                  className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-50"
                  title="Annuler"
                >
                  <X className="h-4 w-4" />
                </button>
              </form>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-gray-500">
            {/* Quand un libellé est affiché en titre, le Drive cible passe ici —
                sinon on perdrait l'information de destination. */}
            {m.label && !m.analyzeOnly ? `→ ${m.gdSharedDriveName} · ` : ''}
            {m.siteName} / {m.driveName}
            {m.rootPath ? ` / ${m.rootPath}` : ''}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${status.cls}`}
        >
          <StatusIcon className={`h-3.5 w-3.5 ${m.status === 'running' || m.status === 'pending' ? 'animate-spin' : ''}`} />
          {status.label}
        </span>
      </div>

      {/* Progression — en mode analyse, on affiche le total découvert, pas de barre */}
      {m.analyzeOnly ? (
        <div className="mt-3 flex items-center justify-between text-xs text-gray-600">
          <span>{m.totalItems.toLocaleString('fr-FR')} fichiers</span>
          <span className="font-medium text-gray-800">{fmtBytes(m.totalBytes)}</span>
        </div>
      ) : (
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
          <span>
            {m.migratedItems} / {total} fichiers
            {m.updatedItems > 0 && (
              <span className="ml-1 text-blue-600">· {m.updatedItems} mis à jour</span>
            )}
            {m.failedItems > 0 && <span className="ml-1 text-red-600">· {m.failedItems} échec(s)</span>}
            {m.skippedItems > 0 && (
              <span className="ml-1 text-amber-600">· {m.skippedItems} ignoré(s) (trop gros)</span>
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

        {/* Progression du PARCOURS. Indispensable en passe delta : la barre en
            octets y est à 100 % dès la première seconde (tout est déjà migré),
            donc seule cette ligne dit où en est réellement le run. */}
        {isActive && total > 0 && (
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
              <span>
                Parcours : {m.scannedItems.toLocaleString('fr-FR')} / {total.toLocaleString('fr-FR')} fichiers
              </span>
              <span className="tabular-nums">{scanPct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-gray-400 transition-[width] duration-700 ease-out"
                style={{ width: `${Math.max(scanPct, scanPct > 0 ? 1.5 : 0)}%` }}
              />
            </div>
            {eta && <p className="mt-1 text-xs text-gray-400">Fin estimée dans {eta}</p>}
          </div>
        )}
      </div>
      )}

      {m.errorDetails && (
        <div
          className={`mt-3 rounded px-3 py-2 text-xs ${
            m.analyzeOnly ? 'bg-indigo-50 text-indigo-800' : 'bg-red-50 text-red-700'
          }`}
        >
          {m.errorDetails}
        </div>
      )}

      {/* Répartition du contenu courant (mode analyse) */}
      {m.analysisResult && m.analysisResult.length > 0 && (
        <div className="mt-3 max-h-72 overflow-y-auto rounded border border-gray-100">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Dossier</th>
                <th className="px-3 py-1.5 text-right font-medium">Fichiers</th>
                <th className="px-3 py-1.5 text-right font-medium">Taille</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {m.analysisResult.map((b) => (
                <tr key={b.name}>
                  <td className="truncate px-3 py-1.5 text-gray-800">{b.name}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">
                    {b.files.toLocaleString('fr-FR')}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium text-gray-700">
                    {fmtBytes(b.bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
              ? 'Relancer l’analyse'
              : // Une migration terminée qu'on relance ne recopie pas tout : elle
                // ne repasse que ce qui a changé côté SharePoint (synchro delta).
                m.status === 'success'
                ? 'Synchroniser (delta)'
                : m.migratedItems > 0
                  ? 'Reprendre'
                  : 'Lancer'}
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
        {(m.updatedItems > 0 || m.status === 'success') && !m.analyzeOnly && (
          <button
            onClick={() => setShowChanges((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            title="Lister les fichiers créés et mis à jour par la dernière passe"
          >
            <FileClock className="h-3.5 w-3.5" />
            {showChanges ? 'Masquer' : 'Voir'} les changements
          </button>
        )}
        {hasDetails && (
          <button
            onClick={() => setShowErrors((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {showErrors ? 'Masquer' : 'Voir'} les détails
          </button>
        )}
        {m.archived ? (
          <button
            onClick={() => unarchive.mutate(m.id)}
            disabled={unarchive.isPending}
            className="ml-auto inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
            Désarchiver
          </button>
        ) : (
          <button
            onClick={() => archive.mutate(m.id)}
            disabled={archive.isPending || isActive}
            className="ml-auto inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title={
              isActive
                ? 'Mets la migration en pause avant de l’archiver'
                : 'Ranger dans l’historique (le Shared Drive et le suivi sont conservés)'
            }
          >
            <Archive className="h-3.5 w-3.5" />
            Archiver
          </button>
        )}
        <button
          onClick={() => {
            if (confirm(`Supprimer la migration vers "${m.gdSharedDriveName}" ? (le Shared Drive Google n'est PAS supprimé)`)) {
              del.mutate(m.id)
            }
          }}
          disabled={del.isPending || isActive}
          className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          title={isActive ? 'Arrête la migration avant de supprimer' : 'Supprimer le suivi'}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {showChanges && <ChangeList migrationId={m.id} driveName={m.gdSharedDriveName} />}
      {showErrors && <ErrorList migrationId={m.id} />}
    </div>
  )
}

/**
 * Liste ce que la dernière passe a changé. Sans elle, « 35 mis à jour » est
 * invérifiable : l'opérateur ne peut pas valider une passe delta à l'aveugle.
 */
function ChangeList({ migrationId, driveName }: { migrationId: string; driveName: string }) {
  const [data, setData] = useState<SharepointMigrationChangesResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    sharepointMigrationApi
      .changes(migrationId)
      .then((d) => alive && setData(d))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [migrationId])

  const created = data?.created ?? []
  const updated = data?.updated ?? []

  const downloadCsv = () => {
    const esc = (v: string | number | null) =>
      `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [
      ['Type', 'Nom', 'Chemin SharePoint', 'Taille (octets)', 'Modifié le (SharePoint)', 'Traité le'].join(';'),
      ...[
        ...created.map((i) => ['Créé', i] as const),
        ...updated.map((i) => ['Mis à jour', i] as const),
      ].map(([type, i]) =>
        [esc(type), esc(i.name), esc(i.spPath), esc(i.sizeBytes), esc(i.spLastModified), esc(i.syncedAt)].join(';'),
      ),
    ]
    // BOM UTF-8 : sans lui, Excel affiche « Contrôle de gestion » en mojibake.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `changements-${driveName.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const Section = ({
    title,
    count,
    items,
    tone,
  }: {
    title: string
    count: number
    items: SharepointChangedItem[]
    tone: string
  }) => (
    <div>
      <p className={`mb-1 font-semibold ${tone}`}>
        {title} ({count.toLocaleString('fr-FR')})
      </p>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.id} className="border-b border-gray-100 pb-1.5 last:border-0">
            <div className="font-medium text-gray-800">{i.name}</div>
            {i.spPath && <div className="truncate text-gray-400">{i.spPath}</div>}
            <div className="text-gray-500">
              {i.sizeBytes != null && <>{fmtBytes(i.sizeBytes)} · </>}
              modifié le{' '}
              {i.spLastModified
                ? new Date(i.spLastModified).toLocaleString('fr-FR')
                : 'date inconnue'}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )

  return (
    <div className="mt-3 max-h-72 space-y-3 overflow-y-auto rounded border border-gray-100 bg-gray-50 p-2 text-xs">
      {loading && <p className="text-gray-500">Chargement…</p>}
      {!loading && created.length === 0 && updated.length === 0 && (
        <p className="text-gray-500">
          Aucun changement lors de la dernière passe — la source et le Drive sont identiques.
        </p>
      )}
      {(created.length > 0 || updated.length > 0) && (
        <button
          onClick={downloadCsv}
          className="inline-flex items-center gap-1.5 rounded border border-gray-200 bg-white px-2.5 py-1 font-medium text-gray-600 hover:bg-gray-100"
        >
          <Download className="h-3.5 w-3.5" />
          Télécharger le CSV
        </button>
      )}
      {data?.truncated && (
        <p className="rounded bg-amber-50 px-2 py-1 text-amber-700">
          Liste tronquée aux 500 plus récents par catégorie — les totaux affichés restent exacts.
        </p>
      )}
      {created.length > 0 && (
        <Section
          title="Nouveaux fichiers"
          count={data?.createdCount ?? created.length}
          items={created}
          tone="text-green-700"
        />
      )}
      {updated.length > 0 && (
        <Section
          title="Contenu mis à jour"
          count={data?.updatedCount ?? updated.length}
          items={updated}
          tone="text-blue-700"
        />
      )}
    </div>
  )
}

function ErrorList({ migrationId }: { migrationId: string }) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof sharepointMigrationApi.errors>
  > | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      setData(await sharepointMigrationApi.errors(migrationId))
    } finally {
      setLoading(false)
    }
  }

  if (data === null && !loading) {
    void load()
    return null
  }

  const errors = data?.errors ?? []
  const skipped = data?.skipped ?? []

  return (
    <div className="mt-3 max-h-60 space-y-2 overflow-y-auto rounded border border-gray-100 bg-gray-50 p-2 text-xs">
      {loading && <p className="text-gray-500">Chargement…</p>}
      {!loading && errors.length === 0 && skipped.length === 0 && (
        <p className="text-gray-500">Aucun détail.</p>
      )}
      {errors.length > 0 && (
        <div>
          <p className="mb-1 font-semibold text-red-700">Erreurs ({errors.length})</p>
          <ul className="space-y-1.5">
            {errors.map((e) => (
              <li key={e.id} className="border-b border-gray-100 pb-1.5 last:border-0">
                <div className="font-medium text-gray-800">{e.name ?? e.spItemId}</div>
                {e.spPath && <div className="text-gray-400">{e.spPath}</div>}
                <div className="text-red-600">{e.errorDetails}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <div>
          <p className="mb-1 font-semibold text-amber-700">
            Ignorés — à transférer manuellement ({skipped.length})
          </p>
          <ul className="space-y-1.5">
            {skipped.map((e) => (
              <li key={e.id} className="border-b border-gray-100 pb-1.5 last:border-0">
                <div className="font-medium text-gray-800">{e.name ?? e.spItemId}</div>
                {e.spPath && <div className="text-gray-400">{e.spPath}</div>}
                <div className="text-amber-600">{e.errorDetails}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
