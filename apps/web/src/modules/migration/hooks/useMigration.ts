import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { MigrationRecord, MigrateUsersRequest, MigrateExistingRequest } from '@dsi-app/shared'
import { migrationApi, migrationTargetsApi } from '../api'

export function useMigrationSearch(query: string) {
  return useQuery({
    queryKey: ['migration-search', query],
    queryFn: () => migrationApi.search(query),
    enabled: query.length >= 2,
    staleTime: 30_000,
  })
}

/**
 * Migrations actives (non archivées). Filtré côté SQL : l'ancien /history
 * paginait actives + archivées ensemble, donc une migration active pouvait
 * sortir de la page 1 dès que 50 archives plus récentes existaient.
 */
export function useMigrationHistory() {
  return useQuery({
    queryKey: ['migration-history'],
    queryFn: () => migrationApi.history({ archived: false }),
    staleTime: 5_000,
    refetchInterval: (q) => {
      // Refresh actif quand au moins une migration (mail/cal/contacts) est en cours
      const anyRunning = q.state.data?.migrations.some((m) =>
        ['pending', 'running'].includes(m.stepMailMigration) ||
        ['pending', 'running'].includes(m.stepCalendarMigration) ||
        ['pending', 'running'].includes(m.stepContactsMigration)
      )
      return anyRunning ? 5_000 : false
    },
  })
}

/** Historique archivé — paginé, chargé seulement quand la section est dépliée. */
export function useArchivedMigrations(page: number, enabled: boolean) {
  return useQuery({
    queryKey: ['migration-archived', page],
    queryFn: () => migrationApi.history({ archived: true, page }),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
}

/** UPN déjà migrés, pour le badge « déjà migré » sur les résultats de recherche. */
export function useMigratedUpns() {
  return useQuery({
    queryKey: ['migrated-upns'],
    queryFn: () => migrationApi.migratedUpns(),
    staleTime: 60_000,
  })
}

export function useRunMigration(onSuccess: (migrations: MigrationRecord[]) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: MigrateUsersRequest) => migrationApi.run(req),
    onSuccess: (data) => {
      onSuccess(data.migrations)
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
      queryClient.invalidateQueries({ queryKey: ['migrated-upns'] })
      // Provisioning Entra tourne en background — relancer plusieurs fois pour récupérer
      // les transitions pending → running → success/error
      const refreshTimes = [3000, 8000, 15000, 30000]
      for (const ms of refreshTimes) {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['migration-history'] })
        }, ms)
      }
      // Alerter pour les comptes ignorés (idempotency)
      if (data.skipped && data.skipped.length > 0) {
        const lines = data.skipped.map((s) => `• ${s.onelaUpn} — ${s.reason}`).join('\n')
        alert(`${data.skipped.length} compte(s) ignoré(s) :\n\n${lines}`)
      }
    },
  })
}

export function useRunMigrationExisting(onSuccess: (migrations: MigrationRecord[]) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: MigrateExistingRequest) => migrationApi.runExisting(req),
    onSuccess: (data) => {
      onSuccess(data.migrations)
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useAddGoogleAlias() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, alias }: { id: string; alias?: string }) => migrationApi.addGoogleAlias(id, alias),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useActivateNewFormat() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.activateNewFormat(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['migration-history'] }),
  })
}

export function useMigrateMail() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (vars: string | { id: string; order?: 'asc' | 'desc'; beforeDays?: number | null }) =>
      typeof vars === 'string'
        ? migrationApi.migrateMail(vars)
        : migrationApi.migrateMail(vars.id, vars.order ?? 'desc', vars.beforeDays),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useMigrateCalendar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.migrateCalendar(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useMigrateContacts() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.migrateContacts(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

/**
 * Sondage Admin SDK « le compte est-il provisionné par SCIM ? ».
 * Un appel Google par carte concernée : sur un lot de 15 comptes fraîchement
 * créés, l'intervalle de 30 s faisait 30 appels/min en tâche de fond. Le SCIM
 * met 5 à 40 min — 60 s suffit largement, et on s'arrête dès que c'est prêt.
 */
export function useCheckGoogle(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['check-google', id],
    queryFn: () => migrationApi.checkGoogle(id),
    enabled,
    refetchInterval: (q) => (enabled && q.state.data?.exists !== true ? 60_000 : false),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  })
}

export function useMigrationErrors(id: string, phase: 'mail' | 'calendar' | 'contacts', enabled: boolean, failedCount?: number) {
  return useQuery({
    queryKey: ['migration-errors', id, phase, failedCount],
    queryFn: () => migrationApi.fetchErrors(id, phase),
    enabled,
    staleTime: 30_000,
  })
}

// Archiver / désarchiver / supprimer déplace une ligne entre les deux listes :
// il faut invalider les deux caches, pas seulement les actives.
function invalidateBothLists(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['migration-history'] })
  qc.invalidateQueries({ queryKey: ['migration-archived'] })
}

export function useArchiveMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.archive(id),
    onSuccess: () => invalidateBothLists(qc),
  })
}

export function useUnarchiveMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.unarchive(id),
    onSuccess: () => invalidateBothLists(qc),
  })
}

export function useDeleteMigration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.remove(id),
    onSuccess: () => {
      invalidateBothLists(qc)
      qc.invalidateQueries({ queryKey: ['migrated-upns'] })
    },
  })
}

export function useStopPhase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, phase }: { id: string; phase: 'mail' | 'calendar' | 'contacts' }) =>
      migrationApi.stop(id, phase),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['migration-history'] })
    },
  })
}

export function useResetPhase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, phase }: { id: string; phase: 'mail' | 'calendar' | 'contacts' }) =>
      migrationApi.reset(id, phase),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['migration-history'] })
      qc.invalidateQueries({ queryKey: ['migration-errors'] })
    },
  })
}

export function useRelabelMail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.relabelMail(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['migration-history'] }),
  })
}

export function useDedupeMail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.dedupeMail(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['migration-history'] }),
  })
}

export function useMoveOu() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.moveOu(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['migration-history'] }),
  })
}

export function useSetForwarding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.setForwarding(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['migration-history'] })
      qc.invalidateQueries({ queryKey: ['forwarding-status', id] })
    },
  })
}

export function useRemoveForwarding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => migrationApi.removeForwarding(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['migration-history'] })
      qc.invalidateQueries({ queryKey: ['forwarding-status', id] })
    },
  })
}

/**
 * Statut de la redirection Exchange. Un appel Exchange Admin REST par carte
 * dépliée, sur le même tenant que le worker mail : on met en cache 5 min et on
 * ne refetch pas au focus. Les mutations set/remove invalident déjà la clé.
 */
export function useForwardingStatus(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['forwarding-status', id],
    queryFn: () => migrationApi.checkForwarding(id),
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  })
}

export function useMigrationStats() {
  return useQuery({
    queryKey: ['migration-stats'],
    queryFn: () => migrationTargetsApi.stats(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  })
}

export function useImportTargets() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (csv: string) => migrationTargetsApi.importCSV(csv),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['migration-stats'] }),
  })
}

export function useResetDone() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => migrationTargetsApi.resetDone(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['migration-stats'] }),
  })
}
