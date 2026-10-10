/**
 * CTP-648: live robots.txt probe per registered source. Derives each bron's
 * host (and the path prefixes its connector actually requests) from the
 * connector config/constants — the same URLs `field-coverage.ts` replays —
 * then fetches https://<host>/robots.txt once per host, sequentially, with a
 * plain UA and a 10 s timeout. Prints a table and writes
 * /tmp/ji-run/voorwaarden-probe.json.
 *
 * Run: bun scripts/probe-source-voorwaarden.ts [--bron <slug>]
 */

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { SOURCES } from "@ji/application/sources";
import * as jsonLd from "@ji/connectors/json-ld";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const OUT_PATH = "/tmp/ji-run/voorwaarden-probe.json";
const TIMEOUT_MS = 10_000;
const USER_AGENT = "catapulze-ji-voorwaarden-probe";
const URL_LITERAL = /https:\/\/[a-z0-9.-]+(?<pathname>\/[^\s"'`]*)?/giu;
const TEMPLATE_PLACEHOLDER = /\$\{?<?\w*>?\}?/u;

interface JsonLdConfig {
  detailBaseUrl?: string;
  detailFixtures?: Record<string, string>;
  detailUrlRewrite?: { pattern: RegExp; replace: string };
  discovery?: { kind: string; url: string } | { url: string };
  slug?: string;
}

const readText = (filePath: string): string => readFileSync(filePath, "utf-8");

/** Static prefix of a rewrite/detail template, up to the first placeholder. */
const staticPrefix = (template: string): string => {
  const cut = template.search(TEMPLATE_PLACEHOLDER);
  const head = cut === -1 ? template : template.slice(0, cut);
  return head.replace(/\/[^/]*$/u, "/").replace(/^$/u, "/");
};

const directoryOf = (pathname: string): string =>
  pathname.replace(/\/[^/]*$/u, "/") || "/";

const urlLiteralsIn = (source: string): string[] => {
  const urls: string[] = [];
  for (const match of source.matchAll(URL_LITERAL)) {
    if (match[0].includes(".test") || match[0].includes("example.")) {
      continue;
    }
    urls.push(match[0]);
  }
  return urls;
};

interface HostInfo {
  host: string | null;
  hostSource: string;
  paths: string[];
}

/** Host + requested path prefixes for a json-ld source's connector config. */
const fromJsonLdConfig = (slug: string): HostInfo | null => {
  // SAFETY: the json-ld barrel mixes config objects with factory functions;
  // only configs carry a `slug` equal to a bron slug, so the find below
  // selects a real JsonLdConnectorConfig.
  const configs = Object.values(jsonLd) as JsonLdConfig[];
  const value = configs.find((config) => config.slug === slug);
  if (value) {
    const urls: string[] = [];
    const { discovery } = value;
    if (discovery && "url" in discovery) {
      urls.push(discovery.url);
    }
    if (value.detailBaseUrl) {
      urls.push(value.detailBaseUrl);
    }
    const host = urls[0] ? new URL(urls[0]).host : null;
    const paths = new Set<string>();
    for (const url of urls) {
      paths.add(directoryOf(new URL(url).pathname));
    }
    if (value.detailUrlRewrite) {
      paths.add(staticPrefix(value.detailUrlRewrite.replace));
    }
    for (const key of Object.keys(value.detailFixtures ?? {})) {
      try {
        paths.add(directoryOf(new URL(key).pathname));
      } catch {
        // Non-URL fixture keys carry no path signal.
      }
    }
    return {
      host,
      hostSource: "json-ld config discovery.url",
      paths: [...paths],
    };
  }
  return null;
};

/** Host + requested path prefixes for a dedicated connector under
 * packages/connectors/src/<slug>/ — first https literal in client.ts (the
 * DEFAULT_BASE_URL / endpoint constants) wins; types.ts adds detail URLs. */
const fromConnectorDir = (slug: string): HostInfo | null => {
  const dir = path.join(REPO_ROOT, "packages/connectors/src", slug);
  const urls: string[] = [];
  for (const file of ["client.ts", "types.ts", "client-effect.ts"]) {
    const filePath = path.join(dir, file);
    try {
      urls.push(...urlLiteralsIn(readText(filePath)));
    } catch {
      // File absent — try the next conventional name.
    }
  }
  if (urls.length === 0) {
    return null;
  }
  const { host } = new URL(urls[0]);
  const paths = new Set<string>();
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.host === host) {
        paths.add(directoryOf(parsed.pathname));
      }
    } catch {
      // Not a URL literal.
    }
  }
  return {
    host,
    hostSource: `connectors/${slug} URL literals`,
    paths: [...paths],
  };
};

/** Last resort: first URL inside the recorded listing fixture payload. */
const fromListingFixture = (slug: string): HostInfo | null => {
  const fixturePath = path.join(
    REPO_ROOT,
    "fixtures/connectors",
    slug,
    "listing-page-0.json"
  );
  try {
    // SAFETY: connector fixtures are `connector-fixture/v1` envelopes; the
    // only field read is `payload`, and a missing string just yields no URLs.
    const parsed = JSON.parse(readText(fixturePath)) as { payload?: string };
    const urls = urlLiteralsIn(parsed.payload ?? "");
    if (urls.length === 0) {
      return null;
    }
    const { host } = new URL(urls[0]);
    const paths = new Set<string>();
    for (const url of urls) {
      try {
        paths.add(directoryOf(new URL(url).pathname));
      } catch {
        // Not a URL.
      }
    }
    return {
      host,
      hostSource: "fixture listing payload URLs",
      paths: [...paths].slice(0, 3),
    };
  } catch {
    return null;
  }
};

const hostInfo = (slug: string): HostInfo =>
  fromJsonLdConfig(slug) ??
  fromConnectorDir(slug) ??
  fromListingFixture(slug) ?? { host: null, hostSource: "none", paths: [] };

interface RobotsGroup {
  agents: string[];
  disallows: string[];
  crawlDelay: string | null;
}

const parseRobots = (text: string): RobotsGroup[] => {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    const split = line.indexOf(":");
    if (line === "" || split === -1) {
      lastWasAgent = false;
      continue;
    }
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent) {
        current = { agents: [], crawlDelay: null, disallows: [] };
        groups.push(current);
      }
      current?.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (current !== null) {
      lastWasAgent = false;
      if (field === "disallow") {
        current.disallows.push(value);
      } else if (field === "crawl-delay") {
        current.crawlDelay ??= value;
      }
    }
  }
  return groups;
};

const disallowToRegExp = (rule: string): RegExp =>
  new RegExp(
    `^${rule
      .replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&")
      .replaceAll("*", ".*")
      .replace(/\$$/u, "$")}`,
    "u"
  );

interface ProbeRow {
  slug: string;
  host: string | null;
  hostSource: string;
  status: number;
  wildcardDisallowAll: boolean;
  pathsChecked: string[];
  pathsDisallowed: string[];
  crawlDelay: string | null;
  capturedAt: string;
}

const probeHost = async (slug: string, info: HostInfo): Promise<ProbeRow> => {
  const capturedAt = new Date().toISOString();
  const base: Omit<ProbeRow, "capturedAt"> = {
    crawlDelay: null,
    host: info.host,
    hostSource: info.hostSource,
    pathsChecked: info.paths,
    pathsDisallowed: [],
    slug,
    status: 0,
    wildcardDisallowAll: false,
  };
  if (!info.host) {
    return { ...base, capturedAt };
  }
  try {
    const response = await fetch(`https://${info.host}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    base.status = response.status;
    if (!response.ok) {
      return { ...base, capturedAt };
    }
    const groups = parseRobots(await response.text());
    const wildcard = groups.find((group) => group.agents.includes("*"));
    if (!wildcard) {
      return { ...base, capturedAt };
    }
    base.crawlDelay = wildcard.crawlDelay;
    base.wildcardDisallowAll = wildcard.disallows.some((rule) => rule === "/");
    base.pathsDisallowed = info.paths.filter((requested) =>
      wildcard.disallows.some(
        (rule) => rule !== "" && disallowToRegExp(rule).test(requested)
      )
    );
    return { ...base, capturedAt };
  } catch {
    return { ...base, capturedAt };
  }
};

const onlySlug = process.argv.indexOf("--bron");
const slugs = Object.keys(SOURCES).filter(
  (slug) => onlySlug === -1 || slug === process.argv[onlySlug + 1]
);

const rows: ProbeRow[] = [];
for (const slug of slugs) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by contract: one robots.txt request per host at a time.
  rows.push(await probeHost(slug, hostInfo(slug)));
}

console.log(
  "slug | host | status | disallow:*=/ | disallowed connector paths | crawl-delay | hostSource"
);
console.log(
  "--------------------------------------------------------------------------------------------"
);
for (const row of rows) {
  console.log(
    `${row.slug} | ${row.host ?? "?"} | ${row.status} | ${
      row.wildcardDisallowAll ? "Disallow: /" : "ok"
    } | ${row.pathsDisallowed.length > 0 ? row.pathsDisallowed.join(", ") : "-"} | ${
      row.crawlDelay ?? "-"
    } | ${row.hostSource}`
  );
}

mkdirSync(path.dirname(OUT_PATH), { recursive: true });
await Bun.write(OUT_PATH, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`\nwrote ${OUT_PATH}`);
