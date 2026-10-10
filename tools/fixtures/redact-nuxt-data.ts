/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening -- one-off fixture redaction tool operating on raw recorded payloads at the I/O boundary (see tools/fixtures/record.ts). */
/**
 * Mechanically drops one store from the `#__NUXT_DATA__` (devalue) payload in
 * an HTML connector fixture recorded by `record.ts`.
 *
 * Nuxt serialises its state as a flat array of values that reference each
 * other by index, so a key cannot simply be deleted: every value that was only
 * reachable through it would stay in the array. This script rewires the
 * dropped key to `-1` (devalue's `undefined`) and nulls every array slot that
 * is no longer reachable from the root, so the PII is gone while the indices
 * every other value depends on stay valid.
 *
 *   bun tools/fixtures/redact-nuxt-data.ts \
 *     --fixture fixtures/connectors/opdrachtoverheid/detail-alliander.json \
 *     --drop pinia.teamStore
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

type DevalueValue =
  | DevalueValue[]
  | Record<string, number>
  | boolean
  | null
  | number
  | string;

const OPEN_MARKER = 'id="__NUXT_DATA__"';
const CLOSE_TAG = "</script>";
const UNDEFINED_REF = -1;
const WRAPPERS = new Set(["Ref", "ShallowRef", "Reactive", "ShallowReactive"]);

interface FixtureFile {
  captureNote: string;
  payload: string;
  [key: string]: unknown;
}

const isRecord = (value: DevalueValue): value is Record<string, number> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const childIndices = (value: DevalueValue): number[] => {
  if (Array.isArray(value)) {
    const [head, ...rest] = value;
    if (typeof head === "string" && (WRAPPERS.has(head) || head === "Set")) {
      return rest.filter((entry): entry is number => typeof entry === "number");
    }
    return value.filter((entry): entry is number => typeof entry === "number");
  }
  if (isRecord(value)) {
    return Object.values(value);
  }
  return [];
};

const deref = (values: DevalueValue[], index: number): number => {
  const value = values[index];
  if (
    Array.isArray(value) &&
    typeof value[0] === "string" &&
    WRAPPERS.has(value[0]) &&
    typeof value[1] === "number"
  ) {
    return deref(values, value[1]);
  }
  return index;
};

/** Follows `a.b.c` from the root object and returns the object holding the
 * last segment plus that segment, so the caller can rewire the key. */
const locate = (
  values: DevalueValue[],
  dropPath: string
): { holder: Record<string, number>; key: string } => {
  const segments = dropPath.split(".");
  const last = segments.pop();
  if (last === undefined) {
    throw new Error("--drop must name at least one key");
  }
  let index = deref(values, 0);
  for (const segment of segments) {
    const value = values[index];
    if (!(isRecord(value) && segment in value)) {
      throw new Error(`Key ${segment} not found while following ${dropPath}`);
    }
    index = deref(values, value[segment] ?? UNDEFINED_REF);
  }
  const holder = values[index];
  if (!(isRecord(holder) && last in holder)) {
    throw new Error(`Key ${last} not found while following ${dropPath}`);
  }
  return { holder, key: last };
};

export const redactNuxtData = (
  html: string,
  dropPaths: readonly string[]
): { html: string; nulled: number } => {
  const markerIndex = html.indexOf(OPEN_MARKER);
  if (markerIndex === -1) {
    throw new Error("No #__NUXT_DATA__ script found in fixture payload");
  }
  const start = html.indexOf(">", markerIndex) + 1;
  const end = html.indexOf(CLOSE_TAG, start);
  // SAFETY: Nuxt writes the devalue array as JSON; a fixture that does not
  // parse here is not a Nuxt page and the throw is the right outcome.
  const values = JSON.parse(html.slice(start, end)) as DevalueValue[];

  for (const dropPath of dropPaths) {
    const { holder, key } = locate(values, dropPath);
    holder[key] = UNDEFINED_REF;
  }

  const reachable = new Set<number>();
  const stack = [0];
  while (stack.length > 0) {
    const index = stack.pop();
    if (index === undefined || index < 0 || reachable.has(index)) {
      continue;
    }
    reachable.add(index);
    const value = values[index];
    if (value !== undefined) {
      stack.push(...childIndices(value));
    }
  }

  let nulled = 0;
  const redacted = values.map((value, index) => {
    if (reachable.has(index) || value === null) {
      return value;
    }
    nulled += 1;
    return null;
  });

  return {
    html: `${html.slice(0, start)}${JSON.stringify(redacted)}${html.slice(end)}`,
    nulled,
  };
};

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      drop: { multiple: true, type: "string" },
      fixture: { type: "string" },
    },
  });
  const fixturePath = values.fixture;
  const dropPaths = values.drop ?? [];
  if (!fixturePath || dropPaths.length === 0) {
    throw new Error("--fixture and at least one --drop are required");
  }
  // SAFETY: fixtures are written by record.ts as JSON objects with a string
  // `payload` for HTML captures.
  const fixture = JSON.parse(
    await readFile(fixturePath, "utf-8")
  ) as FixtureFile;
  const { html, nulled } = redactNuxtData(fixture.payload, dropPaths);
  fixture.payload = html;
  fixture.captureNote = `${fixture.captureNote} Redacted by tools/fixtures/redact-nuxt-data.ts: dropped ${dropPaths.join(", ")} from #__NUXT_DATA__ (${nulled} unreachable slots nulled).`;
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `${fixturePath}: dropped ${dropPaths.join(", ")}, nulled ${nulled} slots`
  );
}
