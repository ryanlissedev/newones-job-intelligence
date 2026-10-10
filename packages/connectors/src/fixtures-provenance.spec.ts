import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { fixturePath } from "./fixtures/load";

/**
 * AGENTS.md "Fixtures are real recordings": `capturedAt` is the raw file's
 * real mtime in UTC. A date-only value, an exact midnight, or any other
 * value rounded to the hour (`:00:00.000Z`) is a placeholder, not a real
 * mtime, and a fixture file that is not a JSON envelope carries no capture
 * metadata at all. Record new fixtures with tools/fixtures/record.ts.
 */

/**
 * Pre-existing violations, each with a named follow-up. Keep this as small
 * as possible -- every entry here is a fixture whose provenance the guard
 * cannot vouch for.
 */
const ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // Pre-existing recording; capture time rounded to the hour. Re-record when
  // the tenderned source is next touched.
  "tenderned/detail-pub-001.json",
  // Pre-existing recording; capture time rounded to the hour. Re-record when
  // the tenderned source is next touched.
  "tenderned/listing-page-0.json",
]);

const FULL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HOUR_ROUNDED = /T\d{2}:00:00\.000Z$/u;

const root = fixturePath();
const files = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
  .toSorted();

const provenanceProblem = (file: string): string | null => {
  if (!file.endsWith(".json")) {
    return "not a JSON fixture envelope (no capturedAt)";
  }
  // SAFETY: every fixture is a repo-owned JSON envelope; a missing or
  // non-string capturedAt is exactly what this guard reports below.
  const parsed = JSON.parse(readFileSync(path.join(root, file), "utf-8")) as {
    capturedAt?: string;
  };
  const capturedAt = parsed.capturedAt ?? "";
  if (!FULL_UTC_TIMESTAMP.test(capturedAt)) {
    return `capturedAt ${JSON.stringify(parsed.capturedAt)} is not a full UTC timestamp`;
  }
  if (HOUR_ROUNDED.test(capturedAt)) {
    return `capturedAt ${capturedAt} is rounded to the hour`;
  }
  return null;
};

describe("connector fixture provenance", () => {
  it("scans a non-trivial fixture tree", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("every fixture carries a real, unrounded capturedAt", () => {
    const problems = files
      .filter((file) => !ALLOWLIST.has(file))
      .map((file) => ({ file, problem: provenanceProblem(file) }))
      .filter((entry) => entry.problem !== null);
    expect(problems).toEqual([]);
  });

  it("allowlist entries still violate (remove them once fixed)", () => {
    for (const file of ALLOWLIST) {
      expect(provenanceProblem(file)).not.toBeNull();
    }
  });
});
