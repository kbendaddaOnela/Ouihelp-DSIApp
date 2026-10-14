// Exécute `fn` sur `items` avec au plus `limit` appels en parallèle (évite de
// saturer / faire throttler Graph ou Gmail quand on interroge des dizaines de
// groupes ou de boîtes). L'ordre des résultats suit celui de `items`.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let i = 0
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
