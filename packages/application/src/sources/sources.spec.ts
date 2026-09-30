import { describe, expect, it } from "bun:test";

import type {
  CreateSourceConnectorInput,
  SourceDefinition,
} from "./definition";
import {
  findSourceByNaam,
  resolveSourceByNaam,
  SOURCES,
  SUPPORTED_BRON_SLUGS,
} from "./index";

describe("source registry", () => {
  it("lists slugs alphabetically and keeps each definition's slug equal to its key", () => {
    expect(SUPPORTED_BRON_SLUGS).toEqual([...SUPPORTED_BRON_SLUGS].toSorted());
    for (const slug of SUPPORTED_BRON_SLUGS) {
      expect(SOURCES[slug].slug).toBe(slug);
    }
  });

  it("resolves a bron by its naam regardless of case and whitespace", () => {
    expect(resolveSourceByNaam("  tenderned ")?.slug).toBe("tenderned");
    expect(resolveSourceByNaam("INHUURDESK")?.slug).toBe("inhuurdesk");
  });

  it("matches on the definition's naam, not on naam === slug", () => {
    const sources = [
      ...Object.values(SOURCES),
      { naam: "Need Staffing IT", slug: "needstaffing" },
    ];
    expect(findSourceByNaam(sources, "need staffing it")?.slug).toBe(
      "needstaffing"
    );
    expect(findSourceByNaam(sources, "needstaffing")).toBeUndefined();
  });

  it("returns undefined for an unknown naam", () => {
    expect(resolveSourceByNaam("not a registered source")).toBeUndefined();
  });

  it("gives every source a unique bronId (a shared id cross-contaminates known-hashes and observations)", () => {
    const slugsByBronId = new Map<string, string[]>();
    for (const [slug, source] of Object.entries(SOURCES)) {
      const slugs = slugsByBronId.get(source.bronId) ?? [];
      slugs.push(slug);
      slugsByBronId.set(source.bronId, slugs);
    }
    const collisions = [...slugsByBronId.entries()]
      .filter(([, slugs]) => slugs.length > 1)
      .map(([bronId, slugs]) => `${bronId} shared by ${slugs.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("gives every source a unique slug", () => {
    const slugs = Object.keys(SOURCES);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps every activation-threshold override a positive integer below the default", () => {
    for (const [slug, source] of Object.entries(SOURCES)) {
      // SAFETY: SOURCES entries satisfy SourceDefinition via `satisfies`; the
      // inferred literal seed shape drops the optional field when unset.
      const minimum = (source.seed as SourceDefinition<string>["seed"])
        .minimumTestImportObservations;
      if (minimum === undefined) {
        continue;
      }
      // 20 mirrors DEFAULT_MINIMUM_TEST_IMPORT_OBSERVATIONS in
      // packages/db/src/bron-runtime.ts (@ji/db's env validation makes it
      // unimportable here without a DATABASE_URL).
      expect(
        Number.isInteger(minimum) && minimum >= 1 && minimum < 20,
        `${slug} seed.minimumTestImportObservations`
      ).toBe(true);
    }
  });
});

const discoverFirstItem = async (
  slug: (typeof SUPPORTED_BRON_SLUGS)[number],
  knownHashes?: CreateSourceConnectorInput["knownHashes"]
) => {
  const source = SOURCES[slug];
  const connector = source.createConnector({
    bronId: source.bronId,
    knownHashes,
    listingFixturePath: `${slug}/listing-page-0.json`,
    live: false,
    runKind: "test",
  });
  const discovery = await connector.discover(null);
  const [item] = discovery.items;
  if (!item) {
    throw new Error(`Expected at least one fixture listing item for ${slug}`);
  }
  return { connector, item };
};

describe("known-hash short-circuit capability (RJC-357 / RJC-401)", () => {
  for (const slug of SUPPORTED_BRON_SLUGS) {
    const source = SOURCES[slug];

    if (source.listingHashCoversDetail) {
      it(`${slug}: skips the fetch when the stored listing hash matches`, async () => {
        let consulted = 0;
        const { connector, item } = await discoverFirstItem(slug, {
          get: () => {
            consulted += 1;
            return Promise.resolve(null);
          },
        });
        // First resolve the item's own hash via a store that always misses,
        // then replay fetch with a store returning exactly that hash.
        const matching = source.createConnector({
          bronId: source.bronId,
          knownHashes: { get: () => Promise.resolve(item.contentHash) },
          listingFixturePath: `${slug}/listing-page-0.json`,
          live: false,
          runKind: "test",
        });
        await expect(matching.fetch(item)).resolves.toBeNull();
        // A missing (null) stored hash must never skip.
        const missed = await connector.fetch(item);
        expect(consulted).toBeGreaterThan(0);
        expect(missed).not.toBeNull();
        expect(missed?.status).toBe("fetched");
      });

      it(`${slug}: a changed listing hash forces the fetch`, async () => {
        const { item } = await discoverFirstItem(slug);
        const changed = source.createConnector({
          bronId: source.bronId,
          knownHashes: {
            get: () => Promise.resolve("different-listing-hash"),
          },
          listingFixturePath: `${slug}/listing-page-0.json`,
          live: false,
          runKind: "test",
        });
        const result = await changed.fetch(item);
        expect(result).not.toBeNull();
        expect(result?.status).toBe("fetched");
      });
    } else {
      it(`${slug}: never consults the known-hash store (listing hash cannot see detail changes)`, async () => {
        let consulted = 0;
        const { connector, item } = await discoverFirstItem(slug, {
          get: () => {
            consulted += 1;
            return Promise.resolve(item.contentHash);
          },
        });
        try {
          await connector.fetch(item);
        } catch {
          // A fixture client without a detail fixture may throw; the gate
          // under test is only that the store was never consulted.
        }
        expect(consulted).toBe(0);
      });
    }
  }
});
