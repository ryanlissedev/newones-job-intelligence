import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { recordFixture } from "./record";
import type { JsonValue } from "./record";
import { redactFixture } from "./redact-committed";

const SOURCE = "redact-committed-spec";

/** Synthetic on purpose: `.internal` can never be delegated in the public DNS
 * and `0999` is not an area code in the Dutch numbering plan. */
const RAW_HTML = `<html><body><p>Bel de vacaturelijn op 0999-000000 of mail v.voorbeeld@geen-echt-domein.internal.</p></body></html>`;

const record = async (
  dir: string,
  name: string,
  extra: readonly string[] = []
): Promise<string> => {
  const rawPath = path.join(dir, `${name}.html`);
  await writeFile(rawPath, RAW_HTML);
  await recordFixture([
    "--source",
    SOURCE,
    "--name",
    name,
    "--url",
    "https://example.test/detail",
    "--from-raw",
    rawPath,
    "--out-dir",
    path.join(dir, "out"),
    ...extra,
  ]);
  return path.join(dir, "out", SOURCE, `${name}.json`);
};

const payloadOf = async (file: string): Promise<JsonValue> =>
  // SAFETY: the fixture envelope this spec writes always carries a payload.
  (JSON.parse(await readFile(file, "utf-8")) as { payload: JsonValue }).payload;

describe("redactFixture", () => {
  it("repairs an HTML payload to the same bytes the recorder would have written", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "redact-committed-spec-"));
    const recorded = await record(dir, "recorded");
    const committed = await record(dir, "committed", ["--no-redact"]);

    expect(await redactFixture(committed)).toContain(
      "redacted:email×1, redacted:phone×1"
    );
    expect(await payloadOf(committed)).toBe(await payloadOf(recorded));

    await rm(dir, { force: true, recursive: true });
  });

  it("converges: a second pass changes nothing and appends no second note", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "redact-committed-spec-"));
    const committed = await record(dir, "committed", ["--no-redact"]);

    await redactFixture(committed);
    const afterFirst = await readFile(committed, "utf-8");
    const secondPass = await redactFixture(committed);

    expect(secondPass).toBe(`${committed}: nothing to redact`);
    expect(await readFile(committed, "utf-8")).toBe(afterFirst);

    await rm(dir, { force: true, recursive: true });
  });

  it("skips a fixture with no payload key instead of throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "redact-committed-spec-"));
    // The shape of fixtures/backfill/*.json: database rows, not a capture.
    const file = path.join(dir, "rows.json");
    const before = `${JSON.stringify({ rows: [{ id: "a" }] }, null, 2)}\n`;
    await writeFile(file, before);

    expect(await redactFixture(file)).toBe(`${file}: skipped, no payload key`);
    expect(await readFile(file, "utf-8")).toBe(before);

    await rm(dir, { force: true, recursive: true });
  });
});
