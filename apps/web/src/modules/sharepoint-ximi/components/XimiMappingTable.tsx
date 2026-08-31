import { Download, Table2, Loader2, RefreshCw } from 'lucide-react'
import type { XimiMappingRow } from '@dsi-app/shared'
import { useXimiMapping } from '../hooks/useXimiMigration'

const PERMISSION_LABELS: Record<XimiMappingRow['permissionStatus'], string> = {
  pending: 'à faire',
  running: 'en cours',
  success: 'OK',
  error: 'échec',
  skipped: 'sans objet',
}

const STATUS_LABELS: Record<XimiMappingRow['status'], string> = {
  pending: 'en attente',
  running: 'en cours',
  paused: 'en pause',
  success: 'terminé',
  error: 'erreur',
}

/**
 * Tableau de correspondance site ONELA ↔ site Ouihelp.
 *
 * C'est LE livrable du module : Ximi s'en sert pour repointer les URL dans leur
 * application. L'export se fait côté navigateur (les appels API portent un jeton
 * Bearer, un simple lien de téléchargement ne l'aurait pas).
 */
export function XimiMappingTable({ expanded }: { expanded: boolean }) {
  const { data, isFetching, refetch } = useXimiMapping(expanded)
  const rows = data?.rows ?? []

  const exportCsv = () => {
    const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const header = [
      'Agence',
      'Site ONELA (nom)',
      'Site ONELA (URL)',
      'Site ONELA (ID)',
      'Site Ouihelp (nom)',
      'Site Ouihelp (URL)',
      'Site Ouihelp (ID)',
      'Groupe dynamique',
      'Droits',
      'Statut migration',
      'Fichiers migrés',
      'Dernière synchro',
    ].join(';')
    const lines = [
      header,
      ...rows.map((r) =>
        [
          esc(r.agency),
          esc(r.sourceSiteName),
          esc(r.sourceSiteUrl),
          esc(r.sourceSiteId),
          esc(r.targetSiteName),
          esc(r.targetSiteUrl),
          esc(r.targetSiteId),
          esc(r.dynamicGroupName),
          esc(PERMISSION_LABELS[r.permissionStatus]),
          esc(STATUS_LABELS[r.status]),
          esc(r.filesMigrated),
          esc(r.lastSyncAt ? new Date(r.lastSyncAt).toLocaleString('fr-FR') : ''),
        ].join(';'),
      ),
    ]
    // Séparateur « ; » + BOM UTF-8 : ce que veut Excel en configuration
    // française. Sans le BOM, « Argenteuil » passe encore, mais pas « Créteil ».
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mappage-sharepoint-ximi-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!expanded) return null

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <Table2 className="h-4 w-4 text-gray-400" />
          <h3 className="text-sm font-semibold text-gray-900">Mappage des sites (livrable Ximi)</h3>
          <span className="text-xs text-gray-500">{rows.length} site(s)</span>
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void refetch()}
            className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Actualiser
          </button>
          <button
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="inline-flex items-center gap-1.5 rounded border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            Exporter en CSV
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-gray-400">
          Aucun site migré pour l'instant.
        </p>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Agence</th>
                <th className="px-3 py-2 text-left font-medium">Site ONELA</th>
                <th className="px-3 py-2 text-left font-medium">Site Ouihelp</th>
                <th className="px-3 py-2 text-left font-medium">Groupe dynamique</th>
                <th className="px-3 py-2 text-right font-medium">Fichiers</th>
                <th className="px-3 py-2 text-left font-medium">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.migrationId} className="align-top">
                  <td className="px-3 py-2 font-medium text-gray-800">{r.agency}</td>
                  <td className="max-w-xs px-3 py-2">
                    <div className="truncate text-gray-800">{r.sourceSiteName}</div>
                    <a
                      href={r.sourceSiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-gray-400 hover:text-blue-600"
                    >
                      {r.sourceSiteUrl}
                    </a>
                  </td>
                  <td className="max-w-xs px-3 py-2">
                    {r.targetSiteUrl ? (
                      <>
                        <div className="truncate text-gray-800">{r.targetSiteName}</div>
                        <a
                          href={r.targetSiteUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate text-gray-400 hover:text-blue-600"
                        >
                          {r.targetSiteUrl}
                        </a>
                      </>
                    ) : (
                      <span className="text-gray-400">non créé</span>
                    )}
                  </td>
                  <td className="max-w-[14rem] px-3 py-2">
                    <div className="truncate text-gray-700">{r.dynamicGroupName ?? '—'}</div>
                    <div
                      className={
                        r.permissionStatus === 'success'
                          ? 'text-green-600'
                          : r.permissionStatus === 'error'
                            ? 'text-red-600'
                            : 'text-gray-400'
                      }
                    >
                      droits : {PERMISSION_LABELS[r.permissionStatus]}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                    {r.filesMigrated.toLocaleString('fr-FR')}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-gray-700">{STATUS_LABELS[r.status]}</div>
                    {r.lastSyncAt && (
                      <div className="text-gray-400">
                        {new Date(r.lastSyncAt).toLocaleString('fr-FR')}
                      </div>
                    )}
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
