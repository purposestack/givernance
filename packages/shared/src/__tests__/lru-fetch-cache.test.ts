import { describe, expect, it, vi } from "vitest";
import { createLruFetchCache } from "../lib/lru-fetch-cache.js";

const buf = (s: string) => Buffer.from(s);

describe("createLruFetchCache", () => {
  it("fetches on a miss and caches the result", async () => {
    const cache = createLruFetchCache();
    const fetch = vi.fn(async (key: string) => buf(key));

    const first = await cache.get("a", fetch);
    const second = await cache.get("a", fetch);

    expect(first?.toString()).toBe("a");
    expect(second?.toString()).toBe("a");
    expect(fetch).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it("does NOT cache a null result — a transient miss is retried", async () => {
    const cache = createLruFetchCache();
    let attempt = 0;
    const fetch = vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? null : buf("ready");
    });

    const first = await cache.get("k", fetch);
    const second = await cache.get("k", fetch);

    expect(first).toBeNull();
    expect(second?.toString()).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keys entries independently", async () => {
    const cache = createLruFetchCache();
    const fetch = vi.fn(async (key: string) => buf(key));

    await cache.get("a", fetch);
    await cache.get("b", fetch);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await cache.get("a", fetch))?.toString()).toBe("a");
    expect((await cache.get("b", fetch))?.toString()).toBe("b");
    expect(fetch).toHaveBeenCalledTimes(2); // both served from cache
  });

  it("clear() drops all entries, forcing a re-fetch", async () => {
    const cache = createLruFetchCache();
    const fetch = vi.fn(async (key: string) => buf(key));

    await cache.get("a", fetch);
    cache.clear();
    await cache.get("a", fetch);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used entry past `max`", async () => {
    const cache = createLruFetchCache({ max: 2 });
    const fetch = vi.fn(async (key: string) => buf(key));

    await cache.get("a", fetch);
    await cache.get("b", fetch);
    await cache.get("c", fetch); // evicts "a" (LRU)
    await cache.get("a", fetch); // miss → re-fetch

    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
