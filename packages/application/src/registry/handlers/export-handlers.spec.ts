import { describe, expect, it } from "bun:test";

import type { SliceAStores } from "../stores/types";
import { createTestSliceADeps } from "../test-fixtures";
import { createCommitExportHandler, isExportEnabled } from "./export-handlers";

const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000426";

describe("createCommitExportHandler", () => {
  it("reports availability only for explicitly configured clients", () => {
    expect(isExportEnabled({})).toBe(false);
    expect(isExportEnabled(createTestSliceADeps())).toBe(true);
  });

  it("fails closed before reading stores when no Spott client is configured", async () => {
    const fixtureDeps = createTestSliceADeps();
    let storeReads = 0;
    // SAFETY: This proxy preserves the SliceAStores surface solely to fail on
    // every property read; the cast does not narrow or accept external data.
    const guardedStores = new Proxy(fixtureDeps.stores, {
      get: () => {
        storeReads += 1;
        throw new Error("The disabled export handler must not read a store");
      },
    }) as SliceAStores;
    const handler = createCommitExportHandler({
      bronnen: fixtureDeps.bronnen,
      scopeId: fixtureDeps.scopeId,
      searchAdapter: fixtureDeps.searchAdapter,
      stores: guardedStores,
    });

    const result = await handler(
      { snapshotId: SNAPSHOT_ID },
      { principal: { kind: "user", subjectId: "approver-1" } }
    );

    expect(result).toEqual({
      error: {
        code: "EXPORT_DISABLED",
        details: { id: SNAPSHOT_ID },
        message:
          "Export is disabled because no Spott write client is configured",
      },
      ok: false,
    });
    expect(storeReads).toBe(0);
    expect(fixtureDeps.stores.exportAttempts.list()).toHaveLength(0);
    expect(fixtureDeps.stores.externalReceipts.list()).toHaveLength(0);
  });
});
