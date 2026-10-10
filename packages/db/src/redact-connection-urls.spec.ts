import { describe, expect, it } from "bun:test";

import { redactConnectionUrls } from "./redact-connection-urls";

describe("redactConnectionUrls", () => {
  it("strips a connection string with its password", () => {
    const redacted = redactConnectionUrls(
      "connect ECONNREFUSED postgres://ji_app:hunter2@10.0.0.4:5432/ji tail"
    );

    expect(redacted).toBe("connect ECONNREFUSED [redacted] tail");
    expect(redacted).not.toContain("hunter2");
  });

  it("strips the postgresql:// spelling and every occurrence", () => {
    expect(
      redactConnectionUrls("postgresql://a:b@h/d and postgresql://c:d@h/d")
    ).toBe("[redacted] and [redacted]");
  });

  it("strips a URL carried in the middle of a joined cause chain", () => {
    // The shape curateScrapeRun logs: several messages joined with " <- ".
    const redacted = redactConnectionUrls(
      "Failed query: insert <- connect ECONNREFUSED postgres://ji_app:hunter2@h/d <- retry"
    );

    expect(redacted).toBe(
      "Failed query: insert <- connect ECONNREFUSED [redacted] <- retry"
    );
  });

  it("leaves a message without a connection string untouched", () => {
    expect(redactConnectionUrls("HTTP 429 from bluetrail")).toBe(
      "HTTP 429 from bluetrail"
    );
  });
});
