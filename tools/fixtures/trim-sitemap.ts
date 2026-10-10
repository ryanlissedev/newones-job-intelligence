/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- one-off fixture redaction tool operating on raw recorded payloads at the I/O boundary (see tools/fixtures/record.ts). */
/**
 * Mechanically trims a recorded sitemap fixture to the `<url>` entries whose
 * `<loc>` matches one of the given URLs (or URL prefixes), so a fixture-mode
 * discover only yields entries that have a matching detail fixture.
 *
 *   bun tools/fixtures/trim-sitemap.ts \
 *     --fixture fixtures/connectors/opdrachtoverheid/sitemap.json \
 *     --keep https://www.opdrachtoverheid.nl/inhuuropdracht/alliander/planner-c/
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const URL_ELEMENT = /<url>[\s\S]*?<\/url>/gu;
const LOC_ELEMENT = /<loc>(?<loc>[\s\S]*?)<\/loc>/u;

interface FixtureFile {
  captureNote: string;
  payload: string;
  [key: string]: unknown;
}

export const trimSitemap = (
  xml: string,
  keep: readonly string[]
): { kept: number; removed: number; xml: string } => {
  let kept = 0;
  let removed = 0;
  const trimmed = xml.replace(URL_ELEMENT, (element) => {
    const loc = LOC_ELEMENT.exec(element)?.groups?.loc?.trim() ?? "";
    if (keep.some((prefix) => loc.startsWith(prefix))) {
      kept += 1;
      return element;
    }
    removed += 1;
    return "";
  });
  return { kept, removed, xml: trimmed };
};

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      fixture: { type: "string" },
      keep: { multiple: true, type: "string" },
    },
  });
  const fixturePath = values.fixture;
  const keep = values.keep ?? [];
  if (!fixturePath || keep.length === 0) {
    throw new Error("--fixture and at least one --keep are required");
  }
  // SAFETY: fixtures are written by record.ts as JSON objects with a string
  // `payload` for HTML/XML captures.
  const fixture = JSON.parse(
    await readFile(fixturePath, "utf-8")
  ) as FixtureFile;
  const { kept, removed, xml } = trimSitemap(fixture.payload, keep);
  fixture.payload = xml;
  fixture.captureNote = `${fixture.captureNote} Trimmed by tools/fixtures/trim-sitemap.ts: kept ${kept} <url> entries, removed ${removed}.`;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${fixturePath}: kept ${kept}, removed ${removed}`);
}
