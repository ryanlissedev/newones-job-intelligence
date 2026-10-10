import { describe, expect, it } from "bun:test";

import type { BronId } from "@ji/domain";

import {
  asCommandBytes,
  buildHostDumpInvocation,
  buildHostRestoreInvocation,
  createFixtureConnector,
  parseArguments,
  POLICY_RPO_MS,
  POLICY_RTO_MS,
} from "./restore-drill";

const BRON_ID: BronId = "00000000-0000-4000-8000-0000000000ad";

const credentials = {
  adminPassword: "admin-secret",
  adminUser: "ji_admin",
  appPassword: "app-secret",
  appUser: "ji_app",
  hostPort: 5432,
  migratorPassword: "migrator-secret",
  migratorUser: "ji_migrator",
} as const;

const hostRunner = { binary: "/usr/bin/pg_dump", kind: "host" as const };

describe("asCommandBytes (Bun 1.3 ArrayBuffer boundary)", () => {
  it("wraps a bare ArrayBuffer so createHash accepts it", async () => {
    const { createHash } = await import("node:crypto");
    const source = new TextEncoder().encode("ctp-632-arraybuffer");
    const ab = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength
    );
    expect(ab).toBeInstanceOf(ArrayBuffer);
    const wrapped = asCommandBytes(ab);
    expect(wrapped).toBeInstanceOf(Uint8Array);
    const digest = createHash("sha256").update(wrapped).digest("hex");
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("returns an existing Uint8Array unchanged", () => {
    const input = new Uint8Array([1, 2, 3]);
    expect(asCommandBytes(input)).toBe(input);
  });
});

describe("host dump and restore invocations", () => {
  it("pass the admin password through the child environment", () => {
    const dump = buildHostDumpInvocation(hostRunner, credentials, "source_db");
    const restore = buildHostRestoreInvocation(
      hostRunner,
      credentials,
      "target_db"
    );

    expect(dump.command[0]).toBe("/usr/bin/pg_dump");
    expect(restore.command[0]).toBe("/usr/bin/psql");
    expect(dump.env?.PGPASSWORD).toBe(credentials.adminPassword);
    expect(restore.env?.PGPASSWORD).toBe(credentials.adminPassword);
  });
});

describe("parseArguments", () => {
  it("defaults to the artifact receipt path and no retention", () => {
    expect(parseArguments([])).toEqual({
      keepDatabases: false,
      outputPath: ".artifacts/restore-drill-receipt.json",
    });
  });

  it("parses --output and --keep, tolerating a leading -- separator", () => {
    expect(parseArguments(["--", "--output", "/tmp/r.json", "--keep"])).toEqual(
      { keepDatabases: true, outputPath: "/tmp/r.json" }
    );
  });

  it("rejects unknown options, duplicates and missing values", () => {
    expect(() => parseArguments(["--bogus"])).toThrow("Unsupported option");
    expect(() => parseArguments(["--keep", "--keep"])).toThrow(
      "Duplicate option"
    );
    expect(() => parseArguments(["--output"])).toThrow("requires a value");
    expect(() => parseArguments(["--output", "--keep"])).toThrow(
      "requires a value"
    );
  });
});

describe("policy constants", () => {
  it("mirror the documented RPO/RTO policy values", () => {
    expect(POLICY_RPO_MS).toBe(3_600_000);
    expect(POLICY_RTO_MS).toBe(14_400_000);
  });
});

describe("createFixtureConnector", () => {
  const itemA = { bronReferentie: "spec-a", title: "Spec Aanvraag A" };
  const itemB = { bronReferentie: "spec-b", title: "Spec Aanvraag B" };

  it("pages the listing by checkpoint.page and reports hasMore", async () => {
    const connector = await createFixtureConnector({
      bronId: BRON_ID,
      pages: [[itemA], [itemB]],
    });

    expect(connector.fetchUsesNetwork).toBe(false);

    const page0 = await connector.discover(null);
    expect(page0.items.map((item) => item.bronReferentie)).toEqual(["spec-a"]);
    expect(page0.hasMore).toBe(true);
    expect(page0.checkpoint).toEqual({ page: 1 });

    const page1 = await connector.discover(page0.checkpoint);
    expect(page1.items.map((item) => item.bronReferentie)).toEqual(["spec-b"]);
    expect(page1.hasMore).toBe(false);
    expect(page1.checkpoint).toEqual({ page: 2 });
  });

  it("throws while the failure budget lasts, then recovers", async () => {
    const failureBudget = { remaining: 2 };
    const connector = await createFixtureConnector({
      bronId: BRON_ID,
      failDiscoverOnPage: 1,
      failureBudget,
      pages: [[itemA], []],
    });

    const page0 = await connector.discover(null);
    await expect(connector.discover(page0.checkpoint)).rejects.toThrow(
      "fixture discover failure on page 1"
    );
    await expect(connector.discover(page0.checkpoint)).rejects.toThrow(
      "fixture discover failure on page 1"
    );
    expect(failureBudget.remaining).toBe(0);

    const recovered = await connector.discover(page0.checkpoint);
    expect(recovered.items).toEqual([]);
    expect(recovered.hasMore).toBe(false);
  });

  it("fetches the prepared body for a discovered item", async () => {
    const connector = await createFixtureConnector({
      bronId: BRON_ID,
      pages: [[itemA]],
    });
    const discovery = await connector.discover(null);
    const [discovered] = discovery.items;
    const fetched = discovered ? await connector.fetch(discovered) : null;

    if (fetched?.status !== "fetched") {
      throw new Error("fixture fetch did not return a fetched result");
    }
    expect(fetched.bronReferentie).toBe("spec-a");
    expect(fetched.contentType).toBe("json");
    expect(new TextDecoder().decode(fetched.body)).toContain("spec-a");
  });
});
