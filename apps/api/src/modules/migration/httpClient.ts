// HTTP client avec timeout — évite qu'une connexion figée (Graph/Google) ne
// bloque un batch de migration à l'infini. Sans ça, un fetch sans réponse gèle
// la tâche, plus aucune écriture en base, et le détecteur d'orphelins finit par
// la tuer puis la relance → livelock.

const DEFAULT_TIMEOUT_MS = 120_000 // 2 min : généreux pour gros MIME / import Gmail

export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init?: (Parameters<typeof fetch>[1] & { timeoutMs?: number }) | undefined,
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = init ?? {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Timeout après ${timeoutMs}ms`)), timeoutMs)
  // Propager une éventuelle annulation externe
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason)
    else callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true })
  }
  try {
    return await fetch(input, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
