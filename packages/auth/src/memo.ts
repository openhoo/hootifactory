/**
 * Lazy memoization keyed by an arbitrary key. Returns a function that computes
 * the value on first request for a key and returns the cached value thereafter.
 * Concurrent callers for the same key share the single computed value (e.g. a
 * pending Promise), so async loaders run exactly once per key.
 */
export function memoizeByKey<K, V>(load: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>();
  return (key: K): V => {
    let value = cache.get(key);
    if (!value) {
      value = load(key);
      cache.set(key, value);
    }
    return value;
  };
}
