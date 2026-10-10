import { afterEach, describe, expect, it } from "bun:test";

import {
  describeEgressConfig,
  EGRESS_PROXY_SOURCES_ENV,
  EGRESS_PROXY_URL_ENV,
  EgressConfigError,
  resolveEgressFetch,
  resolveEgressRoute,
} from "./egress";
import { createJsonLdClient } from "./json-ld/client";
import { bluetrailConfig } from "./json-ld/configs/bluetrail";

const PROXY_URL = "http://proxy-user:proxy-pass@203.0.113.10:8888";

const env = (
  overrides: Record<string, string | undefined>
): Record<string, string | undefined> => overrides;

const spyFetch = (
  onCall: (input: string | URL | Request, init?: RequestInit) => void,
  response: Response = new Response("ok")
): typeof fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      onCall(input, init);
      return Promise.resolve(response);
    },
    { preconnect: () => {} }
  );

const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of [EGRESS_PROXY_URL_ENV, EGRESS_PROXY_SOURCES_ENV]) {
    if (savedEnv[key] === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = savedEnv[key];
    }
    Reflect.deleteProperty(savedEnv, key);
  }
});

const withProcessEnv = (key: string, value?: string): void => {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
};

describe("resolveEgressRoute", () => {
  it("is direct when nothing is configured", () => {
    expect(resolveEgressRoute("rabobank", env({}))).toEqual({ kind: "direct" });
    expect(resolveEgressRoute(undefined, env({}))).toEqual({ kind: "direct" });
  });

  it("routes a listed source through the proxy", () => {
    expect(
      resolveEgressRoute(
        "rabobank",
        env({
          [EGRESS_PROXY_SOURCES_ENV]: "rabobank,intermediair",
          [EGRESS_PROXY_URL_ENV]: PROXY_URL,
        })
      )
    ).toEqual({ kind: "proxy", proxyUrl: PROXY_URL });
  });

  it("keeps unlisted sources direct even when the proxy is configured", () => {
    expect(
      resolveEgressRoute(
        "striive",
        env({
          [EGRESS_PROXY_SOURCES_ENV]: "rabobank,intermediair",
          [EGRESS_PROXY_URL_ENV]: PROXY_URL,
        })
      )
    ).toEqual({ kind: "direct" });
  });

  it('routes every source when the list is "*"', () => {
    expect(
      resolveEgressRoute(
        "striive",
        env({
          [EGRESS_PROXY_SOURCES_ENV]: "*",
          [EGRESS_PROXY_URL_ENV]: PROXY_URL,
        })
      )
    ).toEqual({ kind: "proxy", proxyUrl: PROXY_URL });
  });

  it("fails closed when a source is routed but the URL is unset", () => {
    expect(() =>
      resolveEgressRoute(
        "rabobank",
        env({ [EGRESS_PROXY_SOURCES_ENV]: "rabobank" })
      )
    ).toThrow(EgressConfigError);
  });

  it("fails closed on a malformed proxy URL, even for unrouted sources", () => {
    expect(() =>
      resolveEgressRoute(
        "striive",
        env({ [EGRESS_PROXY_URL_ENV]: "not a url" })
      )
    ).toThrow(EgressConfigError);
  });

  it("rejects non-http(s) proxy schemes", () => {
    expect(() =>
      resolveEgressRoute(
        "rabobank",
        env({
          [EGRESS_PROXY_SOURCES_ENV]: "rabobank",
          [EGRESS_PROXY_URL_ENV]: "socks5://203.0.113.10:1080",
        })
      )
    ).toThrow(EgressConfigError);
  });

  it("fails closed on a malformed sources entry", () => {
    expect(() =>
      resolveEgressRoute(
        "rabobank",
        env({
          [EGRESS_PROXY_SOURCES_ENV]: "rabobank,,intermediair",
          [EGRESS_PROXY_URL_ENV]: PROXY_URL,
        })
      )
    ).toThrow(EgressConfigError);
    expect(() =>
      resolveEgressRoute(
        "rabobank",
        env({
          [EGRESS_PROXY_SOURCES_ENV]: "Rabobank",
          [EGRESS_PROXY_URL_ENV]: PROXY_URL,
        })
      )
    ).toThrow(EgressConfigError);
  });

  it("never embeds the proxy URL value in error messages", () => {
    const secret = "s3cret-passw0rd";
    try {
      resolveEgressRoute(
        "rabobank",
        env({ [EGRESS_PROXY_URL_ENV]: `not-a-url-${secret}` })
      );
    } catch (error) {
      expect(error).toBeInstanceOf(EgressConfigError);
      // SAFETY: instanceof was just asserted; the catch type is unknown.
      expect((error as Error).message).not.toContain(secret);
      return;
    }
    throw new Error("expected EgressConfigError");
  });
});

describe("resolveEgressFetch", () => {
  it("returns the base fetch for direct egress", () => {
    const base = spyFetch(() => {});
    expect(resolveEgressFetch("rabobank", env({}), base)).toBe(base);
    expect(
      resolveEgressFetch(
        "striive",
        env({
          [EGRESS_PROXY_SOURCES_ENV]: "rabobank",
          [EGRESS_PROXY_URL_ENV]: PROXY_URL,
        }),
        base
      )
    ).toBe(base);
  });

  it("wraps fetch with the proxy init for a routed source", async () => {
    const calls: { init?: RequestInit; input: string | URL | Request }[] = [];
    const base = spyFetch((input, init) => {
      calls.push({ init, input });
    });
    const proxied = resolveEgressFetch(
      "rabobank",
      env({
        [EGRESS_PROXY_SOURCES_ENV]: "rabobank",
        [EGRESS_PROXY_URL_ENV]: PROXY_URL,
      }),
      base
    );

    const controller = new AbortController();
    await proxied("https://rabobank.jobs/sitemap.xml", {
      headers: { Accept: "text/xml" },
      signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.input).toBe("https://rabobank.jobs/sitemap.xml");
    expect(call?.init?.signal).toBe(controller.signal);
    expect(call?.init?.headers).toEqual({ Accept: "text/xml" });
    // SAFETY: `proxy` is a Bun-only init field absent from DOM RequestInit.
    expect((call?.init as RequestInit & { proxy?: string })?.proxy).toBe(
      PROXY_URL
    );
  });

  it("reads process.env by default so poller env applies without wiring", () => {
    withProcessEnv(EGRESS_PROXY_SOURCES_ENV, "rabobank");
    withProcessEnv(EGRESS_PROXY_URL_ENV, PROXY_URL);
    const base = spyFetch(() => {});
    const direct = resolveEgressFetch("striive", undefined, base);
    expect(direct).toBe(base);
    const proxied = resolveEgressFetch("rabobank", undefined, base);
    expect(proxied).not.toBe(base);
  });
});

describe("describeEgressConfig", () => {
  it("reports an unconfigured egress", () => {
    expect(describeEgressConfig(env({}))).toEqual({
      proxiedSources: [],
      proxyConfigured: false,
    });
  });

  it("reports sorted proxied slugs without the URL", () => {
    const summary = describeEgressConfig(
      env({
        [EGRESS_PROXY_SOURCES_ENV]: "techniekwerkt,rabobank,intermediair",
        [EGRESS_PROXY_URL_ENV]: PROXY_URL,
      })
    );
    expect(summary).toEqual({
      proxiedSources: ["intermediair", "rabobank", "techniekwerkt"],
      proxyConfigured: true,
    });
    expect(JSON.stringify(summary)).not.toContain(PROXY_URL);
  });

  it("fails startup when sources are named but no endpoint is set", () => {
    expect(() =>
      describeEgressConfig(env({ [EGRESS_PROXY_SOURCES_ENV]: "rabobank" }))
    ).toThrow(EgressConfigError);
  });

  it("fails startup on a malformed proxy URL", () => {
    expect(() =>
      describeEgressConfig(env({ [EGRESS_PROXY_URL_ENV]: "not a url" }))
    ).toThrow(EgressConfigError);
  });
});

describe("client integration", () => {
  it("picks up the proxied fetch for a routed source when no fetchImpl is given", async () => {
    withProcessEnv(EGRESS_PROXY_SOURCES_ENV, "bluetrail");
    withProcessEnv(EGRESS_PROXY_URL_ENV, PROXY_URL);
    const calls: { init?: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = spyFetch((_input, init) => {
      calls.push({ init });
    });
    try {
      const client = createJsonLdClient({
        config: bluetrailConfig,
        liveEnabled: true,
        timeoutMs: 10,
      });
      await client.fetchListing();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls.length).toBeGreaterThan(0);
    const [firstCall] = calls;
    // SAFETY: `proxy` is a Bun-only init field absent from DOM RequestInit.
    expect((firstCall?.init as RequestInit & { proxy?: string })?.proxy).toBe(
      PROXY_URL
    );
  });

  it("keeps direct egress for an unrouted source on the same env", async () => {
    withProcessEnv(EGRESS_PROXY_SOURCES_ENV, "rabobank");
    withProcessEnv(EGRESS_PROXY_URL_ENV, PROXY_URL);
    const calls: { init?: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = spyFetch((_input, init) => {
      calls.push({ init });
    });
    try {
      const client = createJsonLdClient({
        config: bluetrailConfig,
        liveEnabled: true,
        timeoutMs: 10,
      });
      await client.fetchListing();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls.length).toBeGreaterThan(0);
    const [firstCall] = calls;
    // SAFETY: `proxy` is a Bun-only init field absent from DOM RequestInit.
    expect(
      (firstCall?.init as RequestInit & { proxy?: string })?.proxy
    ).toBeUndefined();
  });

  it("an explicit fetchImpl still wins over egress routing", async () => {
    withProcessEnv(EGRESS_PROXY_SOURCES_ENV, "*");
    withProcessEnv(EGRESS_PROXY_URL_ENV, PROXY_URL);
    const calls: { init?: RequestInit }[] = [];
    const injected = spyFetch((_input, init) => {
      calls.push({ init });
    });
    const client = createJsonLdClient({
      config: bluetrailConfig,
      fetchImpl: injected,
      liveEnabled: true,
      timeoutMs: 10,
    });
    await client.fetchListing();
    expect(calls.length).toBeGreaterThan(0);
    const [firstCall] = calls;
    // SAFETY: `proxy` is a Bun-only init field absent from DOM RequestInit.
    expect(
      (firstCall?.init as RequestInit & { proxy?: string })?.proxy
    ).toBeUndefined();
  });

  it("fails closed at client construction when routed without an endpoint", () => {
    withProcessEnv(EGRESS_PROXY_SOURCES_ENV, "bluetrail");
    withProcessEnv(EGRESS_PROXY_URL_ENV);
    expect(() => createJsonLdClient({ config: bluetrailConfig })).toThrow(
      EgressConfigError
    );
  });
});
