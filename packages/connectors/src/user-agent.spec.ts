import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  JOB_INTELLIGENCE_USER_AGENT,
  withJobIntelligenceUserAgent,
} from "./user-agent";

const SRC = import.meta.dir;
const BROWSER_LIKE =
  /Mozilla\/\d|Chrome\/\d|AppleWebKit|Safari\/\d|Gecko\/|Edg\//u;
// A file that issues a request must route it through one of these.
const UA_MARKERS =
  /withJobIntelligenceUserAgent|JOB_INTELLIGENCE_USER_AGENT|buildLiveFetchHeaders|toLiveFetchHeadersInit/u;
const ISSUES_REQUEST = /\bfetchImpl\(|(?<![.\w])fetch\(\s*[`"'\w]/u;
// egress.ts only builds the proxy-aware fetch; it never picks a request's headers.
const EXEMPT = new Set(["egress.ts", "user-agent.ts"]);

const connectorSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "fixtures" ? [] : connectorSources(full);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")
      ? [full]
      : [];
  });

const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");

describe("JOB_INTELLIGENCE_USER_AGENT", () => {
  it("is the honest product identifier, not a browser string", () => {
    expect(JOB_INTELLIGENCE_USER_AGENT).toMatch(/^NewonesJobIntelligence\/\d/u);
    expect(JOB_INTELLIGENCE_USER_AGENT).not.toMatch(BROWSER_LIKE);
  });
});

describe("withJobIntelligenceUserAgent", () => {
  it("sets the shared UA, replacing a missing or browser-like one, and keeps other headers", async () => {
    const seen: Headers[] = [];
    const base = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return Promise.resolve(new Response("ok"));
      },
      { preconnect: () => {} }
    );
    const wrapped = withJobIntelligenceUserAgent(base);
    await wrapped("https://example.test/a");
    await wrapped("https://example.test/b", {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 Chrome/128.0.0.0",
      },
    });
    expect(seen.map((headers) => headers.get("User-Agent"))).toEqual([
      JOB_INTELLIGENCE_USER_AGENT,
      JOB_INTELLIGENCE_USER_AGENT,
    ]);
    expect(seen[1]?.get("Content-Type")).toBe("application/json");
  });
});

describe("connector HTTP clients User-Agent guard", () => {
  const files = connectorSources(SRC).filter(
    (file) => !EXEMPT.has(path.relative(SRC, file))
  );

  it("never hard-codes a browser-like User-Agent", () => {
    const offenders = files.filter((file) =>
      BROWSER_LIKE.test(stripComments(readFileSync(file, "utf-8")))
    );
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it("routes every request-issuing file through the shared User-Agent", () => {
    const offenders = files.filter((file) => {
      const source = stripComments(readFileSync(file, "utf-8"));
      return ISSUES_REQUEST.test(source) && !UA_MARKERS.test(source);
    });
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
