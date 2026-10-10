import { describe, expect, it } from "bun:test";

import {
  createSliceARegistry,
  MemorySavedSearchStore,
  permissionsForRole,
} from "@ji/application/registry";
import type { SliceAStores } from "@ji/application/registry";
import { PostgresSourceHealthReader } from "@ji/db/source-health-reader";

// `@ji/db`'s barrel module eagerly builds a postgres-js client from
// `@ji/env/database` at import time, which requires DATABASE_URL to be set
// in process.env before that module (or anything importing it, including
// ./slice-a-registry) is evaluated. A dummy value is fine here: postgres-js
// and ManticoreSearchEngine.fromUrl construct lazily and never dial out.
process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:1/db";

const { createProductionSliceADeps } = await import("./slice-a-registry");
const {
  PostgresAlertStore,
  PostgresAuditStore,
  PostgresBronHealthStore,
  PostgresExternalReceiptStore,
  PostgresMarkeringStore,
} = await import("@ji/db");

const baseInput = {
  databaseUrl: process.env.DATABASE_URL,
  manticoreUrl: "http://127.0.0.1:1",
};

describe("createProductionSliceADeps", () => {
  it("wires the bulk source health reader", async () => {
    const deps = await createProductionSliceADeps({
      ...baseInput,
      nodeEnv: "test",
    });
    try {
      expect(deps.sourceHealthReader).toBeInstanceOf(
        PostgresSourceHealthReader
      );
    } finally {
      await deps.close();
    }
  });

  it("keeps production export disabled before any store access without an explicit client", async () => {
    const deps = await createProductionSliceADeps({
      databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused",
      manticoreUrl: "http://127.0.0.1:1",
      nodeEnv: "production",
      rawS3Bucket: "ji-raw-prod",
    });
    let storeReads = 0;
    // SAFETY: This proxy preserves the SliceAStores surface solely to fail on
    // every property read; the cast does not narrow or accept external data.
    const guardedStores = new Proxy(deps.stores, {
      get: () => {
        storeReads += 1;
        throw new Error("Disabled production export must not read a store");
      },
    }) as SliceAStores;

    try {
      expect(deps.spottWriteClient).toBeUndefined();
      const registry = createSliceARegistry({ ...deps, stores: guardedStores });
      const commit = registry.registry.createInvoker({
        capabilityId: "commit_export",
        operation: "POST /v1/exports",
        transport: "rest",
      });
      const result = await commit(
        { snapshotId: "00000000-0000-4000-8000-000000000426" },
        {
          principal: {
            kind: "user",
            permissions: permissionsForRole("approver"),
            subjectId: "approver-1",
          },
          requestId: "export-disabled",
        }
      );

      expect(result).toEqual({
        error: {
          code: "EXPORT_DISABLED",
          details: { id: "00000000-0000-4000-8000-000000000426" },
          message:
            "Export is disabled because no Spott write client is configured",
        },
        ok: false,
      });
      expect(storeReads).toBe(0);
    } finally {
      await deps.close();
    }
  });

  it("wires the Postgres-backed ExternalReceiptStore, not the in-memory one", async () => {
    const deps = await createProductionSliceADeps({
      ...baseInput,
      nodeEnv: "test",
    });
    try {
      expect(deps.stores.externalReceipts).toBeInstanceOf(
        PostgresExternalReceiptStore
      );
    } finally {
      await deps.close();
    }
  });

  it("wires durable stores for user-visible writes and their audit trail", async () => {
    const deps = await createProductionSliceADeps({
      ...baseInput,
      nodeEnv: "test",
    });
    try {
      expect(deps.stores.audit).toBeInstanceOf(PostgresAuditStore);
      expect(deps.stores.markeringen).toBeInstanceOf(PostgresMarkeringStore);
      // CTP-627: saved searches are the Postgres store behind the Effect
      // boundary, so the value is a wrapper object, never the memory store.
      expect(deps.stores.savedSearches).not.toBeInstanceOf(
        MemorySavedSearchStore
      );
      expect(Object.keys(deps.stores.savedSearches).toSorted()).toEqual([
        "createWithAudit",
        "getById",
        "list",
        "removeWithAudit",
        "updateWithAudit",
      ]);
    } finally {
      await deps.close();
    }
  });

  it("wires durable stores for alerts and bron health (RJC-409)", async () => {
    const deps = await createProductionSliceADeps({
      ...baseInput,
      nodeEnv: "test",
    });
    try {
      expect(deps.stores.alerts).toBeInstanceOf(PostgresAlertStore);
      expect(deps.stores.bronHealth).toBeInstanceOf(PostgresBronHealthStore);
    } finally {
      await deps.close();
    }
  });

  it("passes assertProductionPersistence in production with the current allowlist", async () => {
    const deps = await createProductionSliceADeps({
      ...baseInput,
      nodeEnv: "production",
      rawS3Bucket: "ji-raw-prod",
    });
    try {
      expect(deps.stores.externalReceipts).toBeInstanceOf(
        PostgresExternalReceiptStore
      );
    } finally {
      await deps.close();
    }
  });

  it("leaves test/development composition unaffected by the production assertion", async () => {
    const depsByEnv = await Promise.all(
      ["development", "test"].map((nodeEnv) =>
        createProductionSliceADeps({ ...baseInput, nodeEnv })
      )
    );
    await Promise.all(depsByEnv.map((deps) => deps.close()));
  });

  // RJC-386: production must refuse the worker-local filesystem raw-object
  // store (no shared filesystem with the server) and must accept the S3
  // backend without touching the network at construction time.
  describe("raw object store production guard", () => {
    it("throws naming RAW_S3_BUCKET when production resolves to the filesystem store", async () => {
      await expect(
        createProductionSliceADeps({ ...baseInput, nodeEnv: "production" })
      ).rejects.toThrow(/RAW_S3_BUCKET/u);
    });

    it("does not throw when production resolves to the S3 store", async () => {
      const deps = await createProductionSliceADeps({
        ...baseInput,
        nodeEnv: "production",
        rawS3Bucket: "ji-raw-prod",
      });
      try {
        expect(deps.objectStore).toBeDefined();
      } finally {
        await deps.close();
      }
    });

    it("leaves the filesystem store usable outside production", async () => {
      const deps = await createProductionSliceADeps({
        ...baseInput,
        nodeEnv: "development",
      });
      try {
        expect(deps.objectStore).toBeDefined();
      } finally {
        await deps.close();
      }
    });
  });
});
