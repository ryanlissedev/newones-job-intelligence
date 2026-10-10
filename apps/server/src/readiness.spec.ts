import { describe, expect, it } from "bun:test";

import { Hono } from "hono";

import type { ReadinessDeps, ReadinessReport } from "./readiness";
import { createReadinessHandler } from "./readiness";

const FAST_TIMEOUT_MS = 30;
const FAST_CACHE_MS = 20;

const okCheckpoint = () => ({
  appliedSequence: 42n,
  generation: 1,
  schemaHash:
    "aanvragen-v12[active|archive]:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie,locatie_land,opdrachtgever_naam,provincie,publicatiedatum,sluitingsdatum,skills,status,tarief_eenheid,tarief_max,tarief_min,titel,uren_per_week_max,uren_per_week_min,werkvorm,projection_hash;locatie=nullable-omitted;locatie_land=nullable-omitted;eindklant=null;skills=json-array",
});

const baseDeps = (overrides: Partial<ReadinessDeps> = {}): ReadinessDeps => ({
  cacheMs: FAST_CACHE_MS,
  checkDbReadiness: () => Promise.resolve({ ready: true }),
  checkManticore: () => Promise.resolve({ exists: true }),
  checkRawObjectStore: () => Promise.resolve(),
  checkSearchProjection: () =>
    Promise.resolve({
      checkpoint: okCheckpoint(),
      lag: { events: 0, seconds: 0 },
    }),
  checkTimeoutMs: FAST_TIMEOUT_MS,
  nodeEnv: "development",
  rawObjectStoreKind: "s3",
  ...overrides,
});

const requestReadyz = async (
  deps: ReadinessDeps
): Promise<{ status: number; body: ReadinessReport }> => {
  const app = new Hono();
  app.get("/readyz", createReadinessHandler(deps));
  const response = await app.request("/readyz");
  // SAFETY: the handler under test always serializes a ReadinessReport body.
  const body = (await response.json()) as ReadinessReport;
  return { body, status: response.status };
};

describe("GET /readyz", () => {
  it("returns 200 ready when every component is healthy", async () => {
    const { status, body } = await requestReadyz(baseDeps());

    expect(status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.components.postgres.status).toBe("ok");
    expect(body.components.manticore.status).toBe("ok");
    expect(body.components.rawObjectStore.status).toBe("ok");
    expect(body.components.redis).toEqual({ status: "not-configured" });
    expect(body.components.searchProjection.status).toBe("ok");
    expect(body.components.searchProjection.generation).toBe(1);
    expect(body.components.searchProjection.appliedSequence).toBe("42");
  });

  it("returns 503 unavailable when postgres reports a migration mismatch", async () => {
    const { status, body } = await requestReadyz(
      baseDeps({
        checkDbReadiness: () =>
          Promise.resolve({
            ready: false,
            reason: "migration_mismatch" as const,
          }),
      })
    );

    expect(status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(body.components.postgres).toMatchObject({
      reason: "migration_mismatch",
      status: "failed",
    });
  });

  it("returns 503 with reason 'timeout' when manticore does not answer within the check budget", async () => {
    const { status, body } = await requestReadyz(
      baseDeps({
        // oxlint-disable-next-line promise/avoid-new -- deliberately never resolves, to prove the check-level timeout fires.
        checkManticore: () => new Promise<{ exists: boolean }>(() => {}),
      })
    );

    expect(status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(body.components.manticore).toMatchObject({
      reason: "timeout",
      status: "failed",
    });
  }, 5000);

  it("returns 503 unavailable with reason 'table_missing' when the RT table is absent", async () => {
    const { status, body } = await requestReadyz(
      baseDeps({ checkManticore: () => Promise.resolve({ exists: false }) })
    );

    expect(status).toBe(503);
    expect(body.components.manticore).toMatchObject({
      reason: "table_missing",
      status: "failed",
    });
  });

  it("returns 200 degraded when the raw object store (S3) probe fails", async () => {
    const { status, body } = await requestReadyz(
      baseDeps({
        checkRawObjectStore: () => Promise.reject(new Error("boom")),
      })
    );

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.components.rawObjectStore).toMatchObject({
      reason: "unreachable",
      status: "degraded",
    });
  });

  it("returns 503 unavailable when the filesystem raw store is selected in production", async () => {
    const { status, body } = await requestReadyz(
      baseDeps({ nodeEnv: "production", rawObjectStoreKind: "filesystem" })
    );

    expect(status).toBe(503);
    expect(body.components.rawObjectStore).toMatchObject({
      reason: "filesystem_backend_in_production",
      status: "failed",
    });
  });

  it("reports redis not-configured without affecting overall status", async () => {
    const { status, body } = await requestReadyz(
      baseDeps({ redisUrl: undefined })
    );

    expect(status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.components.redis).toEqual({ status: "not-configured" });
  });

  it("degrades (never fails) when outbox lag exceeds the degraded threshold", async () => {
    const { status, body } = await requestReadyz(
      baseDeps({
        checkSearchProjection: () =>
          Promise.resolve({
            checkpoint: okCheckpoint(),
            lag: { events: 12, seconds: 301 },
          }),
      })
    );

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.components.searchProjection).toMatchObject({
      lagEvents: 12,
      lagSeconds: 301,
      reason: "lag_elevated",
      status: "degraded",
    });
  });

  it("returns 503 when the checkpoint has the old always-present location mapping", async () => {
    const { status, body } = await requestReadyz(
      baseDeps({
        checkSearchProjection: () =>
          Promise.resolve({
            checkpoint: {
              ...okCheckpoint(),
              schemaHash:
                "aanvragen-v4[active|archive]:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie,locatie_land,sluitingsdatum,status,tarief_max,tarief_min,titel,projection_hash",
            },
            lag: { events: 0, seconds: 0 },
          }),
      })
    );

    expect(status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(body.components.searchProjection).toMatchObject({
      reason: "schema_hash_mismatch",
      status: "failed",
    });
  });

  it("degrades (never unavailable) when the checkpoint/lag read itself fails", async () => {
    const { status, body } = await requestReadyz(
      baseDeps({
        checkSearchProjection: () => Promise.reject(new Error("timeout")),
      })
    );

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.components.searchProjection).toMatchObject({
      generation: null,
      reason: "projection_read_failed",
      status: "degraded",
    });
  });

  it("caches the composite result so a probe storm does not re-invoke checks", async () => {
    let dbReadinessCalls = 0;
    const deps = baseDeps({
      cacheMs: 100_000,
      checkDbReadiness: () => {
        dbReadinessCalls += 1;
        return Promise.resolve({ ready: true });
      },
    });
    const app = new Hono();
    app.get("/readyz", createReadinessHandler(deps));

    await app.request("/readyz");
    await app.request("/readyz");

    expect(dbReadinessCalls).toBe(1);
  });

  it("singleflights concurrent cold requests: each checker runs exactly once for 10 simultaneous callers", async () => {
    let dbReadinessCalls = 0;
    let manticoreCalls = 0;
    const deps = baseDeps({
      cacheMs: 100_000,
      checkDbReadiness: () => {
        dbReadinessCalls += 1;
        return Promise.resolve({ ready: true });
      },
      checkManticore: () => {
        manticoreCalls += 1;
        return Promise.resolve({ exists: true });
      },
    });
    const app = new Hono();
    app.get("/readyz", createReadinessHandler(deps));

    const CONCURRENT_CALLERS = 10;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_CALLERS }, () => app.request("/readyz"))
    );

    expect(dbReadinessCalls).toBe(1);
    expect(manticoreCalls).toBe(1);
    for (const response of responses) {
      expect(response.status).toBe(200);
    }
  });

  it("aborts a hung checker's signal and still answers within the check budget", async () => {
    let observedAbort = false;
    const deps = baseDeps({
      checkManticore: (signal) =>
        // oxlint-disable-next-line promise/avoid-new -- resolves only from the signal's "abort" event, no existing promise to reuse.
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(new Error("aborted"));
          });
        }),
    });

    const startedAt = Date.now();
    const { status } = await requestReadyz(deps);
    const elapsedMs = Date.now() - startedAt;

    expect(status).toBe(503);
    // FAST_TIMEOUT_MS (30ms) plus generous scheduling slack — proves the
    // response doesn't wait for the hung checker to resolve on its own.
    expect(elapsedMs).toBeLessThan(FAST_TIMEOUT_MS + 500);
    expect(observedAbort).toBe(true);
  });

  it("never leaks a connection string or credential in a failing component's reason", async () => {
    const secret = "postgres://user:hunter2@db.internal:5432/ji";
    const { body } = await requestReadyz(
      baseDeps({
        checkDbReadiness: () => Promise.reject(new Error(secret)),
        checkRawObjectStore: () =>
          Promise.reject(
            new Error("s3://AKIAEXAMPLE:secretkey@bucket.example/raw")
          ),
        redisUrl: "redis://user:hunter2@cache.internal:6379",
      })
    );

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("AKIAEXAMPLE");
    expect(serialized).not.toContain("db.internal");
  });
});
