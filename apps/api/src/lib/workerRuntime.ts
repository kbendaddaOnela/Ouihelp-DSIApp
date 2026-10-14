// Mécanique commune des workers in-process (mail, boîtes partagées, SharePoint
// → Drive, SharePoint → Ouihelp/Ximi). Chaque worker garde ses propres règles de
// sélection (concurrence, phases) ; seuls le polling, le battement de cœur et le
// seuil d'orphelin sont partagés — ils étaient recopiés à l'identique 4 fois.

/** Intervalle de scrutation de la file des jobs. */
export const POLL_INTERVAL_MS = 5000

/**
 * Battement de cœur : un job actif mais lent (resume qui re-scanne des milliers
 * d'éléments déjà migrés, gros téléchargement) doit rafraîchir son updatedAt
 * régulièrement. Sinon le détecteur d'orphelins le croit mort, le remet en
 * 'pending' et le relance → livelock (la tâche redémarre sans jamais finir).
 */
export const HEARTBEAT_MS = 60_000

/**
 * Inactivité au-delà de laquelle un job 'running' absent de la mémoire du process
 * est considéré orphelin (process crashé ou recyclé par un redéploiement). Avec
 * le battement toutes les 60 s, 15 min laisse une grande marge.
 */
export const ORPHAN_STALE_MS = 15 * 60 * 1000

/** true si un job 'running' n'a plus donné signe de vie depuis ORPHAN_STALE_MS. */
export function isOrphaned(updatedAt: Date | string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > ORPHAN_STALE_MS
}

/**
 * Lance `tick` toutes les POLL_INTERVAL_MS, SANS chevauchement : un tick plus
 * long que l'intervalle (base lente, nombreux orphelins à remettre en file) est
 * sauté plutôt que doublé. Avec setInterval seul, deux ticks pouvaient tourner
 * en parallèle sur la même file.
 */
export function startPollingLoop(
  name: string,
  tick: () => Promise<void>,
  opts: { runImmediately?: boolean } = {},
): void {
  let inTick = false
  const run = () => {
    if (inTick) return
    inTick = true
    tick()
      .catch((err) => console.error(`[${name}] tick error:`, err))
      .finally(() => {
        inTick = false
      })
  }
  setInterval(run, POLL_INTERVAL_MS)
  if (opts.runImmediately) run()
}

/**
 * Rafraîchit le updatedAt d'un job toutes les HEARTBEAT_MS via `touch`.
 * Renvoie la fonction d'arrêt (à appeler en fin de traitement).
 */
export function startHeartbeat(label: string, id: string, touch: () => Promise<unknown>): () => void {
  const timer = setInterval(() => {
    void touch().catch((err) => console.warn(`[${label}] ${id}:`, err instanceof Error ? err.message : err))
  }, HEARTBEAT_MS)
  return () => clearInterval(timer)
}
