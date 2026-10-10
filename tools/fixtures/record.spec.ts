import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_HTML_STRIP,
  recordFixture,
  redactContactsInJson,
  redactContactText,
  stripHtml,
  stripJsonKeys,
} from "./record";

describe("stripHtml", () => {
  it("removes script/style/svg/nav/footer and named contact blocks but keeps JSON-LD and content", async () => {
    const html = `<html><head><script>track()</script><style>a{}</style><script type="application/ld+json">{"@type":"JobPosting"}</script></head><body><nav><a>menu</a></nav><svg><path/></svg><h1>Titel</h1><div class="vacancy-contact-info"><p>Recruiter</p></div><footer>adres</footer></body></html>`;
    const { counts, value } = await stripHtml(html, [
      ...DEFAULT_HTML_STRIP,
      ".vacancy-contact-info",
    ]);
    expect(value).toBe(
      `<html><head><script type="application/ld+json">{"@type":"JobPosting"}</script></head><body><h1>Titel</h1></body></html>`
    );
    expect(counts).toEqual({
      ".vacancy-contact-info": 1,
      footer: 1,
      nav: 1,
      'script:not([type="application/ld+json"])': 1,
      style: 1,
      svg: 1,
    });
  });

  it("drops a named attribute but keeps the element and its content", async () => {
    const { counts, value } = await stripHtml(
      `<article class="job recruiter-jan"><p>Tekst</p></article>`,
      [],
      ["article::class"]
    );
    expect(value).toBe("<article><p>Tekst</p></article>");
    expect(counts).toEqual({ "article::class": 1 });
  });
});

/**
 * Synthetic on purpose, and it must stay that way: this repository is public,
 * so a real address in a spec is the same leak the redactor exists to stop.
 * `.internal` is reserved by ICANN for private use and can never be delegated
 * in the public DNS; `0999` is not an area code in the Dutch numbering plan
 * and `06 00 ...` is not an assigned mobile number. All three still match the
 * recorder's patterns, so they exercise the same branches a real one would.
 */
const SAMPLE_CONTACTS =
  "Bel de vacaturelijn op 0999-000000, 06 12 34 56 78 of +31 6 00 00 00 00, of mail v.voorbeeld@geen-echt-domein.internal.";

describe("redactContactText", () => {
  it("replaces an address and every Dutch number shape with a fixed marker", () => {
    const { counts, value } = redactContactText(SAMPLE_CONTACTS);

    expect(value).toBe(
      "Bel de vacaturelijn op +31000000000, +31000000000 of +31000000000, of mail redacted@example.invalid."
    );
    expect(counts).toEqual({ "redacted:email": 1, "redacted:phone": 3 });
  });

  it("leaves decimals alone, because a dot is not a Dutch phone separator", () => {
    // Admitting a dot matched 253 Striive listing scores such as 05.185353.
    const { counts, value } = redactContactText("score 05.185353 en 01.430431");

    expect(value).toBe("score 05.185353 en 01.430431");
    expect(counts).toEqual({ "redacted:email": 0, "redacted:phone": 0 });
  });

  it("leaves a reference id inside a URL alone but still redacts one in prose", () => {
    // Connectors derive externalId from the detail URL, so rewriting a path
    // segment shaped like 0NNN-NNNNNN surfaces later as a parser failure.
    const { counts, value } = redactContactText(
      "Zie https://x.nl/vacature/0123-456789/ of bel 0123-456789."
    );

    expect(value).toBe(
      "Zie https://x.nl/vacature/0123-456789/ of bel +31000000000."
    );
    expect(counts).toEqual({ "redacted:email": 0, "redacted:phone": 1 });
  });

  it("converges, so a second pass over redacted text changes and counts nothing", () => {
    // Both markers match the patterns that produced them, so without this the
    // repair tool rewrites a fixture and re-appends its note on every run.
    const once = redactContactText(SAMPLE_CONTACTS);
    const twice = redactContactText(once.value);

    expect(twice.value).toBe(once.value);
    expect(twice.counts).toEqual({ "redacted:email": 0, "redacted:phone": 0 });
  });
});

describe("redactContactsInJson", () => {
  it("redacts strings at any depth and leaves the shape and other values intact", () => {
    const { counts, value } = redactContactsInJson({
      contact: { email: "r.jansen@example.org", tel: "010-1234567" },
      scores: [1.5, 2.25],
      titel: "Data Engineer",
    });

    expect(value).toEqual({
      contact: { email: "redacted@example.invalid", tel: "+31000000000" },
      scores: [1.5, 2.25],
      titel: "Data Engineer",
    });
    expect(counts).toEqual({ "redacted:email": 1, "redacted:phone": 1 });
  });

  /**
   * Both paths must agree, because the same corpus is checked by one guard.
   * Redacting `JSON.stringify` output silently broke that next to an escape:
   * the email local-part class swallowed the `n` of a serialized `\n` and the
   * orphaned backslash paired with the marker's `r` into a valid `\r`, while
   * the phone alternatives opening with `\b` saw that `n` as a word character
   * and never matched at all.
   */
  it.each([
    ["a newline before a mobile number", "Bel:\n06-12345678"],
    ["a tab before a regional number", "Bel:\t010-1234567"],
    ["a newline before an address", "Mail:\njan@geen-echt-domein.internal"],
    [
      "a \\u escape before an address",
      "Mail:\u0007jan@geen-echt-domein.internal",
    ],
  ])("redacts %s exactly as the HTML path does", (_label, text) => {
    const viaHtml = redactContactText(text);
    const viaJson = redactContactsInJson({ body: text });

    expect(viaJson.value).toEqual({ body: viaHtml.value });
    expect(viaJson.counts).toEqual(viaHtml.counts);
  });

  it("keeps a __proto__ key as an own property instead of dropping it", () => {
    // Assigning out["__proto__"] calls the inherited setter and the key
    // silently disappears; JSON.parse creates it as an own property and the
    // walk has to do the same or the payload loses a field.
    const { value } = redactContactsInJson(
      JSON.parse('{"__proto__":{"kept":true},"safe":"ok"}')
    );

    expect(JSON.stringify(value)).toBe(
      '{"__proto__":{"kept":true},"safe":"ok"}'
    );
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe("stripJsonKeys", () => {
  it("deletes named keys at any depth and leaves every other value untouched", () => {
    const { counts, value } = stripJsonKeys(
      { data: [{ id: "a", recruiter: { name: "x" } }, { id: "b" }], total: 2 },
      ["recruiter"]
    );
    expect(value).toEqual({ data: [{ id: "a" }, { id: "b" }], total: 2 });
    expect(counts).toEqual({ recruiter: 1 });
  });

  it("keeps a __proto__ key it was not asked to strip", () => {
    const { value } = stripJsonKeys(
      JSON.parse('{"__proto__":{"kept":true},"a":1}'),
      ["a"]
    );

    expect(JSON.stringify(value)).toBe('{"__proto__":{"kept":true}}');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe("recordFixture (end to end, --from-raw, no network)", () => {
  it("writes the envelope for a brand-new source with the raw file's mtime and the real trimmed size", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "record-spec-"));
    const rawPath = path.join(dir, "raw.html");
    const html = `<html><head><script>x()</script></head><body><h1>Titel</h1><footer>adres</footer></body></html>`;
    await writeFile(rawPath, html);
    const mtime = new Date("2026-09-16T17:37:21.029Z");
    await utimes(rawPath, mtime, mtime);

    const summary = await recordFixture([
      "--source",
      "brand-new-source",
      "--name",
      "detail-1",
      "--url",
      "https://example.test/detail-1",
      "--from-raw",
      rawPath,
      "--out-dir",
      path.join(dir, "out"),
    ]);

    const fixture = JSON.parse(
      await readFile(
        path.join(dir, "out", "brand-new-source", "detail-1.json"),
        "utf-8"
      )
    );
    const trimmed = "<html><head></head><body><h1>Titel</h1></body></html>";
    expect(fixture).toMatchObject({
      capturedAt: "2026-09-16T17:37:21.029Z",
      contentType: "html",
      contractVersion: "connector-fixture/v1",
      payload: trimmed,
      source: "brand-new-source",
    });
    expect(summary).toContain(`${html.length}→${trimmed.length} bytes`);
    await rm(dir, { force: true, recursive: true });
  });

  it("refuses a --raw-dir that resolves inside the repository, before any request", async () => {
    const insideRepoDir = path.join(import.meta.dir, "raw-dir-inside-repo");
    await expect(
      recordFixture([
        "--source",
        "any-source",
        "--name",
        "any-name",
        "--url",
        "https://example.test/any",
        "--raw-dir",
        insideRepoDir,
      ])
    ).rejects.toThrow(/resolves inside the repository/u);
  });

  it("detects JSON content even when the raw file is named .html, and strips the requested keys", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "record-spec-"));
    const rawPath = path.join(dir, "raw.html");
    await writeFile(rawPath, JSON.stringify({ id: "a", recruiter: "Jan" }));

    const summary = await recordFixture([
      "--source",
      "content-sniff",
      "--name",
      "detail-1",
      "--url",
      "https://example.test/detail-1",
      "--from-raw",
      rawPath,
      "--strip-key",
      "recruiter",
      "--out-dir",
      path.join(dir, "out"),
    ]);

    const fixture = JSON.parse(
      await readFile(
        path.join(dir, "out", "content-sniff", "detail-1.json"),
        "utf-8"
      )
    );
    expect(fixture.contentType).toBe("json");
    expect(fixture.payload).toEqual({ id: "a" });
    expect(summary).toContain("recruiter×1");
    await rm(dir, { force: true, recursive: true });
  });

  it("refuses --strip-key when the raw payload is detected as HTML, instead of silently dropping it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "record-spec-"));
    // Wrong extension on purpose: detection must go by content, not name.
    const rawPath = path.join(dir, "raw.json");
    await writeFile(rawPath, "<html><body>Not JSON</body></html>");

    await expect(
      recordFixture([
        "--source",
        "wrong-ext",
        "--name",
        "detail-1",
        "--url",
        "https://example.test/detail-1",
        "--from-raw",
        rawPath,
        "--strip-key",
        "recruiter",
        "--out-dir",
        path.join(dir, "out"),
      ])
    ).rejects.toThrow(/is not JSON/u);
    await rm(dir, { force: true, recursive: true });
  });
});

describe("recordFixture (live path, mocked fetch, no network)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("selects POST (not GET) for an empty --body, and locks down the raw directory and file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "record-spec-"));
    let capturedInit: RequestInit | undefined;
    // SAFETY: this stub matches fetch's (input, init) => Promise<Response>
    // call signature; the cast only narrows away the extra static members
    // (e.g. `preconnect`) TS's global `fetch` type declares.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(Response.json({ ok: true }, { status: 200 }));
    }) as typeof fetch;

    const summary = await recordFixture([
      "--source",
      "empty-body-source",
      "--name",
      "detail-1",
      "--url",
      "https://example.test/detail-1",
      "--body",
      "",
      "--raw-dir",
      dir,
      "--out-dir",
      path.join(dir, "out"),
    ]);

    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe("");
    expect(summary).toContain("capturedAt=");

    if (process.platform !== "win32") {
      const rawDir = path.join(dir, "empty-body-source");
      const dirStat = await stat(rawDir);
      expect(dirStat.mode.toString(8).slice(-3)).toBe("700");
      const rawFileStat = await stat(path.join(rawDir, "detail-1.json"));
      expect(rawFileStat.mode.toString(8).slice(-3)).toBe("600");
    }

    await rm(dir, { force: true, recursive: true });
  });
});
