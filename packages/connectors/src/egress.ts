/**
 * Per-source egress routing for live connector HTTP (CTP-602).
 *
 * Several sources (rabobank.jobs, Intermediair, Planet Interim, Techniekwerkt)
 * answer the production box and cloud egress IPs with a hard 403; they only
 * serve Dutch residential/business ranges. The operator can run a forward
 * proxy on a Dutch IP and point selected sources at it:
 *
 *   EGRESS_PROXY_URL=http://user:pass@<nl-proxy>:<port>
 *   EGRESS_PROXY_SOURCES=rabobank,intermediair        (or "*" for all)
 *
 * Both unset is today's behaviour: every source fetches directly. The config
 * fails closed — a malformed URL, a malformed sources list, a routing request
 * with no endpoint, or a runtime without Bun's fetch `proxy` support all raise
 * EgressConfigError instead of silently degrading to direct egress, because a
 * silently direct poll reads as a source block and costs a debugging session.
 *
 * The endpoint is never logged or embedded in errors: it may carry proxy
 * credentials. The typed contract for the poller deployment lives in
 * `packages/env/src/poller.ts`; this module re-validates at the fetch
 * boundary so replay/oneshot paths that skip the poller env still cannot
 * misroute quietly.
 */

export const EGRESS_PROXY_URL_ENV = "EGRESS_PROXY_URL";
export const EGRESS_PROXY_SOURCES_ENV = "EGRESS_PROXY_SOURCES";

export class EgressConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressConfigError";
  }
}

type EgressEnv = Readonly<Record<string, string | undefined>>;

const ALL_SOURCES = "*";
const SOURCE_SLUG_PATTERN = /^[a-z0-9-]+$/u;

const parseProxyUrl = (raw: string | undefined): string | undefined => {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new EgressConfigError(
      `${EGRESS_PROXY_URL_ENV} is not a valid URL; expected an http(s) forward proxy endpoint`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EgressConfigError(
      `${EGRESS_PROXY_URL_ENV} must use the http: or https: scheme; other schemes are not supported by the fetch proxy option`
    );
  }
  return value;
};

const parseSources = (raw: string | undefined): ReadonlySet<string> => {
  const value = raw?.trim();
  if (!value) {
    return new Set();
  }
  const entries = value.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    if (entry !== ALL_SOURCES && !SOURCE_SLUG_PATTERN.test(entry)) {
      throw new EgressConfigError(
        `${EGRESS_PROXY_SOURCES_ENV} entries must be source slugs (lowercase letters, digits, hyphens) or "${ALL_SOURCES}", received "${entry}"`
      );
    }
  }
  return new Set(entries);
};

export type EgressRoute =
  | { kind: "direct" }
  | { kind: "proxy"; proxyUrl: string };

/**
 * Resolves how one source's HTTP should leave the process. Validates the env
 * eagerly — a malformed EGRESS_PROXY_URL throws even for an unrouted source.
 */
export const resolveEgressRoute = (
  sourceSlug: string | undefined,
  env: EgressEnv = process.env
): EgressRoute => {
  const proxyUrl = parseProxyUrl(env[EGRESS_PROXY_URL_ENV]);
  const sources = parseSources(env[EGRESS_PROXY_SOURCES_ENV]);
  const routed =
    sourceSlug !== undefined &&
    (sources.has(ALL_SOURCES) || sources.has(sourceSlug));
  if (!routed) {
    return { kind: "direct" };
  }
  if (proxyUrl === undefined) {
    throw new EgressConfigError(
      `${EGRESS_PROXY_SOURCES_ENV} routes "${sourceSlug}" through a proxy but ${EGRESS_PROXY_URL_ENV} is not set; refusing to fall back to direct egress`
    );
  }
  return { kind: "proxy", proxyUrl };
};

// Bun's fetch honours the `proxy` init option; Node's undici fetch ignores it,
// which would silently direct-route a proxied source — the exact failure this
// module exists to prevent, so refuse instead.
const supportsProxyInit = (): boolean => Object.hasOwn(process.versions, "bun");

/**
 * The fetch implementation for one source: the injected/global fetch for
 * direct egress, or the same fetch with the `proxy` init option set when the
 * source is routed. Client code keeps injecting `fetchImpl` for tests; this is
 * only the default when none is provided.
 */
export const resolveEgressFetch = (
  sourceSlug: string | undefined,
  env: EgressEnv = process.env,
  baseFetch: typeof fetch = fetch
): typeof fetch => {
  const route = resolveEgressRoute(sourceSlug, env);
  if (route.kind === "direct") {
    return baseFetch;
  }
  if (!supportsProxyInit()) {
    throw new EgressConfigError(
      `egress proxy for "${sourceSlug}" requires Bun's fetch proxy support; refusing to degrade to direct egress on this runtime`
    );
  }
  const { proxyUrl } = route;
  return Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      // SAFETY: Bun extends RequestInit with `proxy`; the cast keeps the
      // literal legal for consumers type-checked without bun-types while Bun
      // still reads the property at runtime.
      const initWithProxy = { ...init, proxy: proxyUrl } as RequestInit;
      return baseFetch(input, initWithProxy);
    },
    {
      // bun-types declares fetch.preconnect; the proxy wrapper has no
      // preconnect semantics of its own, so it is an intentional no-op.
      preconnect: () => {
        /* no-op: proxied fetch does not preconnect */
      },
    }
  );
};

export interface EgressSummary {
  /** Slugs (or "*") the operator routed through the proxy. Never the URL. */
  proxiedSources: string[];
  proxyConfigured: boolean;
}

/**
 * Startup-facing view of the egress env for logs. Throws on any inconsistent
 * combination so a poller boots loudly rather than polling a source directly
 * the operator meant to proxy.
 */
export const describeEgressConfig = (
  env: EgressEnv = process.env
): EgressSummary => {
  const proxyUrl = parseProxyUrl(env[EGRESS_PROXY_URL_ENV]);
  const sources = parseSources(env[EGRESS_PROXY_SOURCES_ENV]);
  if (sources.size > 0 && proxyUrl === undefined) {
    throw new EgressConfigError(
      `${EGRESS_PROXY_SOURCES_ENV} is set but ${EGRESS_PROXY_URL_ENV} is not; refusing to start with unresolvable egress routing`
    );
  }
  return {
    proxiedSources: [...sources].toSorted(),
    proxyConfigured: proxyUrl !== undefined,
  };
};
