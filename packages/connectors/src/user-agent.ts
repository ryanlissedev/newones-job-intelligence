/**
 * The one User-Agent every live scraper/poller sends. It names the product
 * honestly instead of imitating a browser, so a source operator can see who
 * is fetching and allow-list or block us deliberately. There is no public
 * product/contact URL in this repository yet; add `(+<url>)` here once one
 * exists. Bump the version when crawl behaviour changes materially.
 */
export const JOB_INTELLIGENCE_USER_AGENT_VERSION = "1.0";

export const JOB_INTELLIGENCE_USER_AGENT =
  `NewonesJobIntelligence/${JOB_INTELLIGENCE_USER_AGENT_VERSION}` as const;

/**
 * Wraps a fetch so every request carries `JOB_INTELLIGENCE_USER_AGENT`,
 * replacing any User-Agent a caller set. Connector clients wrap their
 * (egress-resolved or injected) fetch with this, so no request falls back to
 * the runtime default (`Bun/x.y`) or a browser string.
 */
export const withJobIntelligenceUserAgent = (
  fetchImpl: (
    input: string | URL | Request,
    init?: RequestInit
  ) => Promise<Response>
): typeof fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      headers.set("User-Agent", JOB_INTELLIGENCE_USER_AGENT);
      return fetchImpl(input, { ...init, headers });
    },
    {
      // bun-types declares fetch.preconnect; the wrapper adds no connection
      // semantics of its own, so it is an intentional no-op (as in egress.ts).
      preconnect: () => {
        /* no-op: the UA wrapper does not preconnect */
      },
    }
  );
