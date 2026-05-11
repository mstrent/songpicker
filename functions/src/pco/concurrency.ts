// Bounded-concurrency map. Like Promise.all but at most `concurrency`
// promises run in parallel. Used to throttle bursts of PCO API calls to
// stay under the 100-req/20-sec rate limit.
export async function pMap<T, R>(
  items: readonly T[],
  mapper: (item: T) => Promise<R>,
  concurrency = 5,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await mapper(items[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )
  return results
}
