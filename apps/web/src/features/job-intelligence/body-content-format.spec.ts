import { describe, expect, it } from "bun:test";

import {
  BRON_BODY_CONTENT_FORMAT,
  looksLikeHtml,
  resolveBodyContentFormat,
} from "./body-content-format";

describe("per-bron body content format audit (CTP-481)", () => {
  it("marks Motian v1 HTML boards as html", () => {
    expect(BRON_BODY_CONTENT_FORMAT.get("nationale-vacaturebank")).toBe("html");
    expect(BRON_BODY_CONTENT_FORMAT.get("nationalevacaturebank")).toBe("html");
    expect(BRON_BODY_CONTENT_FORMAT.get("werkzoeken")).toBe("html");
  });

  it("marks live stripper brons as plain", () => {
    expect(BRON_BODY_CONTENT_FORMAT.get("tenderned")).toBe("plain");
    expect(BRON_BODY_CONTENT_FORMAT.get("inhuurdesk")).toBe("plain");
    expect(BRON_BODY_CONTENT_FORMAT.get("flinter")).toBe("plain");
    expect(BRON_BODY_CONTENT_FORMAT.get("opdrachtoverheid")).toBe("plain");
  });

  it("detects leftover HTML markers", () => {
    expect(looksLikeHtml("<p>Hallo</p>")).toBe(true);
    expect(looksLikeHtml("<ul><li>a</li></ul>")).toBe(true);
    expect(looksLikeHtml("Geen markup, alleen tekst.")).toBe(false);
  });

  it("detects entity-encoded HTML markers (CTP-483)", () => {
    expect(looksLikeHtml("&lt;p&gt;Hallo&lt;/p&gt;")).toBe(true);
    expect(
      resolveBodyContentFormat({
        bronSlug: "unknown-board",
        content: "&lt;b&gt;bold&lt;/b&gt;",
      })
    ).toBe("html");
  });

  it("resolves NVB HTML via bron policy", () => {
    expect(
      resolveBodyContentFormat({
        bronSlug: "nationale-vacaturebank",
        content: "<p>TypeScript</p>",
      })
    ).toBe("html");
  });

  it("keeps plain tenderned text as plain", () => {
    expect(
      resolveBodyContentFormat({
        bronSlug: "tenderned",
        content: "Azure platform beschrijving zonder tags.",
      })
    ).toBe("plain");
  });

  it("upgrades plain-policy bron when tags remain in the payload", () => {
    expect(
      resolveBodyContentFormat({
        bronSlug: "tenderned",
        content: "<p>Onverwachte tags</p>",
      })
    ).toBe("html");
  });

  it("falls back to HTML detection for unknown brons", () => {
    expect(
      resolveBodyContentFormat({
        bronSlug: "unknown-board",
        content: "<b>bold</b>",
      })
    ).toBe("html");
    expect(
      resolveBodyContentFormat({
        bronSlug: "unknown-board",
        content: "plain text only",
      })
    ).toBe("plain");
  });
});
