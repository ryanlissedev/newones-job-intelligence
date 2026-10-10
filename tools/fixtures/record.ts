/**
 * Records one live response as a connector fixture, per the AGENTS.md
 * "Fixtures are real recordings" rule:
 *
 * - one real request (GET, or POST when `--body` is given);
 * - the raw response is written untouched to a temp dir, never the repo
 *   (it can hold PII);
 * - `capturedAt` is that raw file's mtime in UTC, never a rounded value;
 * - trimming is mechanical only: HTML elements removed by selector, JSON
 *   keys deleted by name, contact details replaced by a fixed marker.
 *   Nothing is retyped or invented.
 *
 * Usage:
 *   bun tools/fixtures/record.ts --source <slug> --name <file-stem> --url <url>
 *     [--body '<json>'] [--strip <css selector>]... [--strip-key <key>]...
 *     [--strip-attr '<css selector>::<attribute>']...
 *     [--note <text>] [--raw-dir <dir>] [--from-raw <file>] [--no-defaults]
 *     [--content-type json|html] [--out-dir <dir>] [--no-redact]
 *
 * Contact redaction is on by default: email addresses and Dutch phone numbers
 * are replaced in every payload string, and the counts land in `captureNote`.
 * `--no-redact` exists for a source whose parser reads a contact field; using
 * it means the fixture guard spec will reject the result, which is the point.
 *
 * `--no-defaults` drops DEFAULT_HTML_STRIP so only the named `--strip`
 * selectors apply -- for pages whose parser reads data inside one of the
 * defaults (Need Staffing's pagination lives in a `<nav>`).
 *
 * `--from-raw` re-trims an earlier recording without a second request; the
 * raw file's mtime (the original fetch time) stays the capturedAt. Whether a
 * raw file is JSON or HTML is detected from its content (a `JSON.parse`
 * probe), never from its extension -- a JSON endpoint answering with a
 * missing or wrong `Content-Type`, or a `--from-raw` file named with the
 * wrong extension, must not silently route through the wrong trimmer.
 * `--content-type` overrides detection when a payload is ambiguous.
 *
 * A raw capture can hold PII, so it is written to a fresh, uniquely-named
 * temp directory created with mode 0700, and each raw file is written with
 * mode 0600. An explicit `--raw-dir` gets the same 0700 treatment when this
 * tool is the one creating it.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

export const USER_AGENT = "Catapulze-JI fixture capture";

/** Always stripped from HTML. JSON-LD scripts are data, not script, and stay. */
export const DEFAULT_HTML_STRIP = [
  'script:not([type="application/ld+json"])',
  "style",
  "svg",
  "nav",
  "footer",
] as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value instanceof Object && !Array.isArray(value);

/** Assigns the way `JSON.parse` does. `out["__proto__"] = value` calls the
 * inherited setter, which either retargets the prototype or is ignored, so
 * the key silently disappears from the payload this tool exists to preserve.
 * `defineProperty` creates it as an ordinary own data property. */
const setJsonEntry = (out: JsonObject, key: string, value: JsonValue): void => {
  Object.defineProperty(out, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

export interface StripResult<T> {
  readonly counts: Record<string, number>;
  readonly value: T;
}

export const stripHtml = async (
  html: string,
  selectors: readonly string[],
  /** `selector::attribute` -- drops one attribute that carries PII (e.g. a
   * recruiter-name class) without removing the element's content. */
  attributes: readonly string[] = []
): Promise<StripResult<string>> => {
  const counts: Record<string, number> = {};
  let rewriter = new HTMLRewriter();
  for (const spec of attributes) {
    const [selector = "", attribute = ""] = spec.split("::");
    counts[spec] = 0;
    rewriter = rewriter.on(selector, {
      element: (element) => {
        if (element.hasAttribute(attribute)) {
          counts[spec] = (counts[spec] ?? 0) + 1;
          element.removeAttribute(attribute);
        }
      },
    });
  }
  for (const selector of selectors) {
    counts[selector] = 0;
    rewriter = rewriter.on(selector, {
      element: (element) => {
        // ponytail: lol-html still visits children of a removed element, so a
        // nested match (svg inside nav) counts once per selector it matches.
        counts[selector] = (counts[selector] ?? 0) + 1;
        element.remove();
      },
    });
  }
  const value = await rewriter.transform(new Response(html)).text();
  return { counts, value };
};

/**
 * Contact details published in vacancy prose are personal data and must not
 * enter the repository, which is public. Element selectors cannot reach them:
 * they sit in ordinary <p> copy inside the vacancy body with no class or
 * wrapper to target. So they are removed by pattern instead, mechanically,
 * and the replacement is a fixed marker rather than an invented value.
 *
 * A dot is deliberately not a phone separator here. Dutch numbers are written
 * with spaces or hyphens, and admitting a dot makes the pattern swallow
 * decimals (measured: it matched 253 Striive listing scores).
 */
const CONTACT_SEPARATOR = String.raw`[\s\u00a0-]?`;

export const CONTACT_REDACTIONS = [
  {
    label: "email",
    pattern:
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/gu,
    replacement: "redacted@example.invalid",
  },
  {
    // Entity-encoded form sources emit inside mailto hrefs and copy
    // (`naam&#64;domein.nl`, seen on Alliander vacancy records).
    label: "email",
    pattern:
      /[A-Za-z0-9._%+-]+&#64;[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/gu,
    replacement: "redacted@example.invalid",
  },
  {
    label: "phone",
    pattern: new RegExp(
      [
        `(?:\\+31|0031|&#43;31|&#x2[Bb];31)${CONTACT_SEPARATOR}\\(?0?\\)?${CONTACT_SEPARATOR}\\d(?:${CONTACT_SEPARATOR}\\d){8}`,
        // `+31 (6) 42492333`: the parenthesised digit counts toward the nine.
        `(?:\\+31|&#43;31|&#x2[Bb];31)${CONTACT_SEPARATOR}\\(\\d{1,2}\\)${CONTACT_SEPARATOR}\\d(?:${CONTACT_SEPARATOR}\\d){7}`,
        `\\b06${CONTACT_SEPARATOR}\\d(?:${CONTACT_SEPARATOR}\\d){7}\\b`,
        // Not after a slash: `/vacature/0123-456789/` is a reference id in a
        // URL, and connectors derive externalId from that path.
        String.raw`(?<!/)\b0\d{2,3}-\d{6,7}\b`,
        String.raw`\b0\d{2,3}\s\d{3}\s?\d{2}\s?\d{2}\b`,
      ].join("|"),
      "gu"
    ),
    replacement: "+31000000000",
  },
] as const;

export type ContactLabel = (typeof CONTACT_REDACTIONS)[number]["label"];

/** A host under a reserved TLD (RFC 2606/6761) and the null number cannot
 * reach a person. The corpus guard reads them as already redacted, so the
 * redactor leaves them alone through the same predicate: the two can never
 * drift, and a second pass over a redacted payload is a no-op. */
const REDACTED_EMAIL_HOST =
  /@(?:[A-Za-z0-9.-]+\.)?(?:invalid|example|test|localhost)$/u;
const REDACTED_PHONE = "+31000000000";

/** The recorder preserves the source's own encoding of `+`: a number emitted
 * as `&#43;31…` or `&#x2B;31…` keeps its entity prefix when the digits are
 * zeroed, so the placeholder can appear in any of the pattern's forms. */
const decodePhoneEntities = (match: string): string =>
  match.replaceAll(/&#43;|&#x2[Bb];/gu, "+");

export const isRedactedContact = (
  label: ContactLabel,
  match: string
): boolean =>
  label === "email"
    ? REDACTED_EMAIL_HOST.test(match)
    : decodePhoneEntities(match) === REDACTED_PHONE;

/** Replaces every contact detail in one payload string with a fixed marker.
 * Runs after element and key stripping, so it only ever sees what would
 * otherwise be committed. */
export const redactContactText = (text: string): StripResult<string> => {
  const counts: Record<string, number> = Object.fromEntries(
    CONTACT_REDACTIONS.map(({ label }) => [`redacted:${label}`, 0])
  );
  let value = text;
  for (const { label, pattern, replacement } of CONTACT_REDACTIONS) {
    value = value.replace(pattern, (match) => {
      // A marker matches the pattern that produced it, so without this a
      // second pass reports another round of removals and rewrites a fixture
      // that was already clean. Skipping what the guard accepts converges.
      if (isRedactedContact(label, match)) {
        return match;
      }
      counts[`redacted:${label}`] = (counts[`redacted:${label}`] ?? 0) + 1;
      return replacement;
    });
  }
  return { counts, value };
};

/**
 * True for a JSON string and for nothing else.
 *
 * `typeof node === "string"` is the ordinary way to write this, and
 * `anti-slop/no-runtime-typeof` forbids it repo-wide. Rather than suppress the
 * rule, the check eliminates every other member of `JsonValue`: `null`, both
 * booleans, arrays and objects, and numbers via `Number.isFinite`, which tests
 * without coercing. JSON has no NaN or Infinity, so no number survives it.
 */
const isJsonString = (value: JsonValue): value is string =>
  value !== null &&
  value !== true &&
  value !== false &&
  !(value instanceof Object) &&
  !Number.isFinite(value);

/**
 * Redacts every string in a parsed JSON payload, so the JSON path and the HTML
 * path produce the same bytes for the same text.
 *
 * Redacting `JSON.stringify` output instead is where two silent defects came
 * from. In serialized text a newline is the two characters `\n`: the email
 * local-part class swallowed that `n`, the replacement started one character
 * late, and the orphaned backslash paired with the marker's leading `r` into a
 * valid `\r`, corrupting the payload undetectably. The same `n` is a word
 * character, so the three phone alternatives that open with `\b` found no
 * boundary and never matched at all. `\t` and `\uXXXX` behaved the same way.
 *
 * Keys are redacted along with values, as the serialized form did, because the
 * corpus guard reads the file as text and would flag a contact-shaped key that
 * this tool could not repair. Two sibling keys collapsing onto one marker
 * would silently drop a field, so that case throws instead.
 */
export const redactContactsInJson = (
  value: JsonValue
): StripResult<JsonValue> => {
  const counts: Record<string, number> = Object.fromEntries(
    CONTACT_REDACTIONS.map(({ label }) => [`redacted:${label}`, 0])
  );
  const redact = (text: string): string => {
    const redacted = redactContactText(text);
    for (const [label, count] of Object.entries(redacted.counts)) {
      counts[label] = (counts[label] ?? 0) + count;
    }
    return redacted.value;
  };
  const walk = (node: JsonValue): JsonValue => {
    if (isJsonString(node)) {
      return redact(node);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (!isJsonObject(node)) {
      return node;
    }
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(node)) {
      const redactedKey = redact(key);
      if (Object.hasOwn(out, redactedKey)) {
        throw new Error(
          `redacting key ${JSON.stringify(key)} to ${JSON.stringify(redactedKey)} would overwrite a sibling key; drop one with --strip-key instead`
        );
      }
      setJsonEntry(out, redactedKey, walk(child));
    }
    return out;
  };
  return { counts, value: walk(value) };
};

export const stripJsonKeys = (
  input: JsonValue,
  keys: readonly string[]
): StripResult<JsonValue> => {
  const counts: Record<string, number> = Object.fromEntries(
    keys.map((key) => [key, 0])
  );
  const walk = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (!isJsonObject(node)) {
      return node;
    }
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(node)) {
      if (keys.includes(key)) {
        counts[key] = (counts[key] ?? 0) + 1;
        continue;
      }
      setJsonEntry(out, key, walk(child));
    }
    return out;
  };
  return { counts, value: walk(input) };
};

const formatCounts = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .map(([what, count]) => `${what}×${count}`)
    .join(", ") || "nothing";

interface FetchRawInput {
  readonly body: string | undefined;
  readonly name: string;
  /** `undefined` means "no explicit --raw-dir": get a fresh, uniquely-named
   * 0700 temp directory rather than a fixed, predictable shared path. */
  readonly rawDirRoot: string | undefined;
  readonly source: string;
  readonly url: string;
}

/** Resolves the directory a raw capture is written into, and locks it down:
 * no explicit `--raw-dir` gets a unique `mkdtemp` root (POSIX guarantees mode
 * 0700 regardless of umask); an explicit `--raw-dir` is chmodded to 0700 only
 * when this call is the one that creates it, never a directory the caller
 * already owns. */
const resolveRawDir = async (
  rawDirRoot: string | undefined,
  source: string
): Promise<string> => {
  if (rawDirRoot === undefined) {
    const uniqueRoot = await mkdtemp(path.join(tmpdir(), "ji-fixture-raw-"));
    const rawDir = path.join(uniqueRoot, source);
    await mkdir(rawDir, { mode: 0o700, recursive: true });
    return rawDir;
  }
  const rawDir = path.join(rawDirRoot, source);
  const created = await mkdir(rawDir, { recursive: true });
  if (created !== undefined) {
    await chmod(created, 0o700);
  }
  return rawDir;
};

/** One real request; the untouched response lands outside the repo, because a
 * raw page can hold PII that must never be committed. */
const fetchRaw = async (input: FetchRawInput): Promise<string> => {
  const isPost = input.body !== undefined;
  const headers = new Headers({ "User-Agent": USER_AGENT });
  if (isPost) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(input.url, {
    body: input.body,
    headers,
    method: isPost ? "POST" : "GET",
  });
  if (!response.ok) {
    throw new Error(`${input.url} answered HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const rawDir = await resolveRawDir(input.rawDirRoot, input.source);
  const rawPath = path.join(
    rawDir,
    `${input.name}.${contentType.includes("json") ? "json" : "html"}`
  );
  await writeFile(rawPath, await response.text(), { mode: 0o600 });
  return rawPath;
};

interface TrimResult {
  readonly counts: Record<string, number>;
  readonly payload: JsonValue;
  readonly payloadBytes: number;
}

interface TrimOptions {
  readonly noDefaults: boolean;
  readonly noRedact: boolean;
  readonly strip: readonly string[];
  readonly stripAttr: readonly string[];
  readonly stripKey: readonly string[];
}

const trimRaw = async (
  rawText: string,
  isJson: boolean,
  options: TrimOptions
): Promise<TrimResult> => {
  if (isJson) {
    // SAFETY: the raw file was written from a JSON response and re-read
    // verbatim, so JSON.parse yields a JSON value.
    const parsed = JSON.parse(rawText) as JsonValue;
    const stripped = stripJsonKeys(parsed, options.stripKey);
    const redacted = options.noRedact
      ? { counts: {}, value: stripped.value }
      : redactContactsInJson(stripped.value);
    return {
      counts: { ...stripped.counts, ...redacted.counts },
      payload: redacted.value,
      payloadBytes: Buffer.byteLength(JSON.stringify(redacted.value)),
    };
  }
  const stripped = await stripHtml(
    rawText,
    [...(options.noDefaults ? [] : DEFAULT_HTML_STRIP), ...options.strip],
    options.stripAttr
  );
  const redacted = options.noRedact
    ? { counts: {}, value: stripped.value }
    : redactContactText(stripped.value);
  return {
    counts: { ...stripped.counts, ...redacted.counts },
    payload: redacted.value,
    payloadBytes: Buffer.byteLength(redacted.value),
  };
};

/** Content decides JSON vs HTML, never a file extension -- a JSON endpoint
 * with a missing/wrong `Content-Type`, or a `--from-raw` file named with the
 * wrong extension, must still route through the matching trimmer. */
const detectIsJson = (
  rawText: string,
  explicitContentType: string | undefined
): boolean => {
  if (explicitContentType !== undefined) {
    if (explicitContentType !== "json" && explicitContentType !== "html") {
      throw new Error(
        `--content-type must be "json" or "html", got ${JSON.stringify(explicitContentType)}`
      );
    }
    return explicitContentType === "json";
  }
  try {
    JSON.parse(rawText);
    return true;
  } catch {
    return false;
  }
};

const REPO_FIXTURES_DIR = path.join(
  import.meta.dir,
  "../../fixtures/connectors"
);
const REPO_ROOT = path.resolve(import.meta.dir, "../..");

/** Raw responses can carry PII and must never land in the repo (see the
 * module docblock). `--raw-dir` is user-supplied, so refuse one that
 * resolves inside the repository root instead of silently writing there. */
const assertRawDirOutsideRepo = (rawDir: string): void => {
  const resolved = path.resolve(rawDir);
  const isInsideRepo =
    resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${path.sep}`);
  if (isInsideRepo) {
    throw new Error(
      `--raw-dir ${rawDir} resolves inside the repository (${REPO_ROOT}); raw responses can carry PII and must be written outside the repo`
    );
  }
};

/** Records (or, with `--from-raw`, re-trims) one fixture and returns the
 * one-line summary. `--out-dir` defaults to the repo's fixtures/connectors. */
export const recordFixture = async (
  args: readonly string[]
): Promise<string> => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      body: { type: "string" },
      "content-type": { type: "string" },
      "from-raw": { type: "string" },
      name: { type: "string" },
      "no-defaults": { type: "boolean" },
      "no-redact": { type: "boolean" },
      note: { type: "string" },
      "out-dir": { type: "string" },
      "raw-dir": { type: "string" },
      source: { type: "string" },
      strip: { multiple: true, type: "string" },
      "strip-attr": { multiple: true, type: "string" },
      "strip-key": { multiple: true, type: "string" },
      url: { type: "string" },
    },
  });
  const { body, name, note, source, url } = values;
  if (!(source && name && url)) {
    throw new Error("--source, --name and --url are required");
  }
  if (values["raw-dir"]) {
    assertRawDirOutsideRepo(values["raw-dir"]);
  }

  const rawPath =
    values["from-raw"] ??
    (await fetchRaw({
      body,
      name,
      rawDirRoot: values["raw-dir"],
      source,
      url,
    }));
  const rawText = await readFile(rawPath, "utf-8");
  const isJson = detectIsJson(rawText, values["content-type"]);
  const stripKey = values["strip-key"] ?? [];
  if (stripKey.length > 0 && !isJson) {
    throw new Error(
      `--strip-key given but ${rawPath} is not JSON (detected as HTML); pass --content-type json to override detection, or drop --strip-key`
    );
  }
  const rawStats = await stat(rawPath);
  const capturedAt = rawStats.mtime.toISOString();
  const trimmed = await trimRaw(rawText, isJson, {
    noDefaults: values["no-defaults"] ?? false,
    noRedact: values["no-redact"] ?? false,
    strip: values.strip ?? [],
    stripAttr: values["strip-attr"] ?? [],
    stripKey,
  });

  const provenance = `Recorded by tools/fixtures/record.ts: ${body === undefined ? "GET" : `POST ${body}`} ${url}. Mechanically stripped (${isJson ? "keys" : "elements"}): ${formatCounts(trimmed.counts)}.`;
  const fixture = {
    captureNote: note ? `${provenance} ${note}` : provenance,
    capturedAt,
    contentType: isJson ? "json" : "html",
    contractVersion: "connector-fixture/v1",
    payload: trimmed.payload,
    source,
  };
  const outDir = path.join(values["out-dir"] ?? REPO_FIXTURES_DIR, source);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, `${name}.json`),
    `${JSON.stringify(fixture, null, 2)}\n`
  );

  return `${url} ${Buffer.byteLength(rawText)}→${trimmed.payloadBytes} bytes capturedAt=${capturedAt} stripped: ${formatCounts(trimmed.counts)} raw=${rawPath}`;
};

if (import.meta.main) {
  console.log(await recordFixture(process.argv.slice(2)));
}
