type CacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/**
 * Lazy memoization keyed by an arbitrary key. Concurrent callers for the same
 * key share the single computed value, including a pending Promise.
 */
export function memoizeByKey<K, V>(load: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>();
  return (key: K): V => {
    if (cache.has(key)) return cache.get(key) as V;
    const value = load(key);
    cache.set(key, value);
    return value;
  };
}

export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    assertPositiveInteger("maxEntries", maxEntries);
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  set(key: K, value: V): V {
    if (this.entries.has(key)) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, value);
    return value;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  deleteWhere(predicate: (key: K, value: V) => boolean): number {
    let deleted = 0;
    for (const [key, value] of this.entries) {
      if (!predicate(key, value)) continue;
      if (this.entries.delete(key)) deleted += 1;
    }
    return deleted;
  }

  clear(): void {
    this.entries.clear();
  }
}

export function createTtlPromiseCache<T>(
  fetchValue: (key: string) => Promise<T>,
  ttlMs: number,
): {
  get: (key: string, now?: number) => Promise<T>;
  invalidate: (key?: string) => void;
  size: () => number;
} {
  assertPositiveInteger("ttlMs", ttlMs);
  const entries = new Map<string, CacheEntry<T>>();
  return {
    get(key, now = Date.now()) {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now) return cached.promise;

      const promise = fetchValue(key);
      entries.set(key, { expiresAt: now + ttlMs, promise });
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
      });
      return promise;
    },
    invalidate(key) {
      if (key === undefined) {
        entries.clear();
        return;
      }
      entries.delete(key);
    },
    size: () => entries.size,
  };
}

export class InFlightDeduper<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();

  get size(): number {
    return this.inFlight.size;
  }

  run(key: K, load: () => Promise<V>): Promise<V> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(load);
    this.inFlight.set(key, promise);
    void promise
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      })
      .catch(() => {});
    return promise;
  }
}

export function createAsyncLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  assertPositiveInteger("concurrency", concurrency);
  let active = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  return async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active = Math.max(0, active - 1);
      }
    }
  };
}

export async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  assertPositiveInteger("concurrency", concurrency);
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
