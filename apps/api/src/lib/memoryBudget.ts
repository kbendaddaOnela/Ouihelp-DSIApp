// Budget mémoire PARTAGÉ par tous les workers qui bufferisent des fichiers
// (migration SharePoint → Drive et SharePoint ONELA → Ouihelp / Ximi).
//
// Chaque worker avait son propre compteur : avec les deux migrations lancées en
// même temps, le conteneur pouvait monter à 2 × SHAREPOINT_MEM_BUDGET_MB de
// contenus en vol (en plus du worker mail) — exactement ce que le budget devait
// empêcher. Un seul compteur au niveau du process rétablit le plafond voulu.

/** Plafond global des contenus en vol (Mo), tous workers confondus. */
export const MEM_BUDGET_BYTES = Number(process.env['SHAREPOINT_MEM_BUDGET_MB'] ?? 250) * 1024 * 1024

let memInFlight = 0

/** Réserve `bytes` du budget (attend si nécessaire). Un fichier plus gros que le
 *  budget passe quand même, mais seul — sinon on bloquerait indéfiniment. */
async function acquireMem(bytes: number): Promise<void> {
  while (memInFlight > 0 && memInFlight + bytes > MEM_BUDGET_BYTES) {
    await new Promise((r) => setTimeout(r, 250))
  }
  memInFlight += bytes
}

function releaseMem(bytes: number): void {
  memInFlight = Math.max(0, memInFlight - bytes)
}

/** Exécute `fn` en réservant `bytes` du budget mémoire pour toute sa durée. */
export async function withMem<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
  const reserved = Math.max(0, bytes)
  await acquireMem(reserved)
  try {
    return await fn()
  } finally {
    releaseMem(reserved)
  }
}
