import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const compose = await Bun.file(path.join(root, "docker-compose.yml")).text();
const sourcesDir = path.join(root, "packages/application/src/sources");

const sourceLiveFlags = async (): Promise<readonly string[]> => {
  const entries = await readdir(sourcesDir);
  const files = entries.filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".spec.ts")
  );
  const flags = new Set<string>();
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of small source files
    const text = await Bun.file(path.join(sourcesDir, file)).text();
    for (const match of text.matchAll(
      /liveEnv: "(?<flag>[A-Z0-9_]+_LIVE)"/gu
    )) {
      if (match.groups?.flag) {
        flags.add(match.groups.flag);
      }
    }
  }
  return [...flags].toSorted();
};

describe("docker-compose poller live flags", () => {
  it("passes every source live flag through to the poller", async () => {
    const flags = await sourceLiveFlags();
    expect(flags.length).toBeGreaterThan(40);
    const missing = flags.filter(
      (flag) => !compose.includes(`      ${flag}: \${${flag}:-}\n`)
    );
    expect(missing).toEqual([]);
  });

  it("never enables a source from compose: every live flag defaults to empty", () => {
    const withDefault = [
      ...compose.matchAll(
        /^\s+(?<flag>[A-Z0-9_]+_LIVE): \$\{[A-Z0-9_]+_LIVE:-(?<fallback>[^}]*)\}/gmu
      ),
    ]
      .filter((match) => (match.groups?.fallback ?? "") !== "")
      .map((match) => match.groups?.flag);
    expect(withDefault).toEqual([]);
  });

  it("keeps the parked sources passthrough-only", () => {
    for (const flag of [
      "CIRCLE8_LIVE",
      "INDEED_LIVE",
      "LINKEDIN_LIVE",
      "MERCELL_LIVE",
      "WERK_NL_LIVE",
    ]) {
      expect(compose).toContain(`      ${flag}: \${${flag}:-}\n`);
      expect(compose).not.toMatch(new RegExp(`${flag}:\\s*["']?1`, "u"));
    }
  });
});
