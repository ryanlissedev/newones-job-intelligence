import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { SOURCES } from "./index";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const BESLUIT_PATTERN = /^- Besluit: `(?<besluit>[a-z_]+)`$/mu;

const readVoorwaardenBesluit = (slug: string): string | null => {
  const docPath = path.join(REPO_ROOT, "docs/sources", `${slug}.md`);
  const doc = readFileSync(docPath, "utf-8");
  const [, section] = doc.split(/^## Voorwaarden$/mu);
  if (section === undefined) {
    return null;
  }
  return section.match(BESLUIT_PATTERN)?.groups?.besluit ?? null;
};

describe("voorwaarden evidence (CTP-648)", () => {
  it("every source's docs/sources/<slug>.md has a ## Voorwaarden section whose Besluit equals seed.voorwaardenStatus", () => {
    for (const [slug, definition] of Object.entries(SOURCES)) {
      const besluit = readVoorwaardenBesluit(slug);
      expect(
        besluit,
        `${slug}: missing "## Voorwaarden" section or "- Besluit:" line in docs/sources/${slug}.md`
      ).not.toBeNull();
      expect(
        besluit,
        `${slug}: doc Besluit "${besluit}" !== seed.voorwaardenStatus "${definition.seed.voorwaardenStatus}"`
      ).toBe(definition.seed.voorwaardenStatus);
    }
  });
});
