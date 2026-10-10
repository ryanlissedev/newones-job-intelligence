import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FilesystemObjectStore } from "@ji/connectors";

describe("FilesystemObjectStore", () => {
  it("round-trips stored objects under the configured root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ji-raw-"));
    const store = new FilesystemObjectStore(root);
    try {
      const expiresAt = new Date("2026-09-01T00:00:00.000Z");
      await store.put({
        body: new TextEncoder().encode('{"ok":true}'),
        contentType: "json",
        expiresAt,
        path: "raw/tenderned/test.json",
      });
      const loaded = await store.get("raw/tenderned/test.json");
      expect(loaded).not.toBeNull();
      expect(new TextDecoder().decode(loaded?.body)).toBe('{"ok":true}');
      expect(loaded?.contentType).toBe("json");
      const onDisk = await readFile(
        path.join(root, "raw/tenderned/test.json"),
        "utf-8"
      );
      expect(onDisk).toBe('{"ok":true}');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
