/** Share reads, never keep stale data as a fallback after an upstream failure. */
export function cachedReader<T>(read: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | undefined;
  let pending: Promise<T> | undefined;
  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.value;
    if (!pending) pending = read().then(value => {
      cached = { value, expiresAt: Date.now() + ttlMs };
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
