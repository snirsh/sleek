/**
 * Bounded-concurrency map that PRESERVES INPUT ORDER. Wave 5 uses it to fan out
 * per-region history/neighbor extraction (src/context/index.ts): each region costs a
 * git subprocess, so the cap stops a large PR from fork-bombing the machine, while
 * the positional result array keeps `ContextInput.regions` byte-stable in diff order
 * — cache keys and scaffold determinism depend on that ordering.
 *
 * Rejection is fail-fast: the first rejection propagates and no NEW work is started
 * (in-flight items settle unobserved), matching the sequential loop it replaced.
 */

/**
 * Map `items` through async `fn` with at most `limit` calls in flight. Results are
 * returned in input order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }

  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  // `limit` workers race down a shared cursor; each writes into its input slot.
  async function worker(): Promise<void> {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failed = true; // stop starting new work; the throw rejects Promise.all
        throw error;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
