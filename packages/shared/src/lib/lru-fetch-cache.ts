/**
 * Generic in-process LRU fetch cache — Epic #286 follow-up (issue #294).
 *
 * Extracted from the two near-identical branding-logo caches that PR #287
 * landed in the API (`modules/branding/logo-cache.ts`) and the worker
 * (`services/branding-logo-cache.ts`). Both wrapped `lru-cache` with the
 * exact same shape (50 entries, 1h TTL, byte-size bound) around a
 * `(key) => Promise<Buffer>` S3 fetch; only the fetch closure differed.
 *
 * This module owns the LRU shape and the "return cached, else fetch and
 * cache" flow. The fetcher is supplied per `get()` call so the caller can
 * close over request/job-scoped state (e.g. `orgId`) while the cache stays
 * keyed by the content-addressed asset id.
 *
 * Pure JS — depends only on `lru-cache` (isomorphic). It deliberately does
 * NOT import `@aws-sdk/client-s3` or any Node-only S3 helper, so it never
 * drags the AWS SDK into the web bundle (ADR-013). The S3 fetch lives in
 * each consuming package's closure, not here.
 */

import { LRUCache } from "lru-cache";

/** One hour, in milliseconds — the default entry TTL. */
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface LruFetchCacheOptions {
  /** Max number of entries. Default 50. */
  max?: number;
  /** Entry time-to-live in milliseconds. Default 1h. */
  ttlMs?: number;
  /** Total byte budget across all entries. Default 50 MB. */
  maxSize?: number;
}

export interface LruFetchCache {
  /**
   * Return the cached buffer for `key`, or invoke `fetch(key)` to resolve
   * it. A non-null result is cached; a `null` result is NOT cached, so a
   * transient miss (asset not ready, blob missing in S3) is re-attempted
   * on the next call rather than pinning a negative result for the TTL.
   */
  get(key: string, fetch: (key: string) => Promise<Buffer | null>): Promise<Buffer | null>;
  /** Clear all entries — test hook + operator invalidation. */
  clear(): void;
}

/**
 * Create an in-process LRU cache of `Buffer` values keyed by string, with a
 * fetch-through `get`. Defaults match the branding-logo cache the two
 * consumers previously hand-rolled: 50 entries, 1h TTL, 50 MB byte budget.
 */
export function createLruFetchCache(options: LruFetchCacheOptions = {}): LruFetchCache {
  const cache = new LRUCache<string, Buffer>({
    max: options.max ?? 50,
    ttl: options.ttlMs ?? ONE_HOUR_MS,
    sizeCalculation: (value) => value.byteLength,
    maxSize: options.maxSize ?? 50 * 1024 * 1024,
  });

  return {
    async get(key, fetch) {
      const cached = cache.get(key);
      if (cached) return cached;

      const buffer = await fetch(key);
      if (!buffer) return null;

      cache.set(key, buffer);
      return buffer;
    },
    clear() {
      cache.clear();
    },
  };
}
