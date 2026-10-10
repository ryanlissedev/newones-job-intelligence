import { describe, expect, it } from "bun:test";

import type { ResultCacheEntry } from "../types";
import { RedisResultCache } from "./redis-result-cache";

// Live integration test against a real Redis instance (docker-compose's
// `redis` service on 127.0.0.1:6379). Skipped entirely unless REDIS_URL is
// set — same convention as manticore/live.spec.ts — so `bun run gate` stays
// fast and mock-only. Uses a run-unique key prefix and deletes only the
// keys this run created; never FLUSHALL/FLUSHDB the shared instance.
const redisUrl = process.env.REDIS_URL;

const sampleEntry = (
  overrides: Partial<ResultCacheEntry> = {}
): ResultCacheEntry => ({
  astHash: "hash-1",
  facets: {
    bron_id: [],
    contracttype: [],
    locatie: [],
    locatie_land: [],
    provincie: [],
    skills: [],
    status: [],
  },
  filters: {},
  hits: [{ id: "doc-1", weight: 1 }],
  indexVersion: 1,
  scope: "active",
  total: 1,
  windowLimit: 1000,
  ...overrides,
});

describe("RedisResultCache live integration (RJC-388)", () => {
  it("round-trips a set entry and reports it absent after cleanup", async () => {
    if (!redisUrl) {
      return;
    }

    const runId = crypto.randomUUID();
    const key = `rjc388-live-test:${runId}`;
    const cache = await RedisResultCache.connect(redisUrl);
    expect(cache).not.toBeNull();
    if (!cache) {
      throw new Error("Expected a live Redis connection");
    }

    try {
      expect(await cache.get(key)).toBeNull();

      const entry = sampleEntry();
      await cache.set(key, entry, 60);
      const roundTripped = await cache.get(key);
      expect(roundTripped).toEqual(entry);
    } finally {
      // ponytail: no delete() on ResultCache — reuse a 1s TTL set to expire
      // this run's key promptly instead of adding a delete just for cleanup.
      await cache.set(key, sampleEntry(), 1);
      await cache.close();
    }
  });

  it("returns null (not an error) for an unreachable Redis URL", async () => {
    if (!redisUrl) {
      return;
    }

    const cache = await RedisResultCache.connect("redis://127.0.0.1:1");
    expect(cache).toBeNull();
  });
});
