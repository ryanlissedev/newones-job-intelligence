import { describe, expect, it } from "bun:test";

import { loadConnectorFixture } from "../fixtures/load";
import { HttpTimeoutError } from "../http-timeout";
import { planetInterimConfig } from "../json-ld/configs/planet-interim";
import { createPlanetInterimClient } from "./client";
import {
  fetchPlanetInterimListingPages,
  PlanetInterimPaginationError,
} from "./pagination";

const LISTING_URL = "https://planetinterim.nl/opdrachten";
const NEXT_TARGET =
  "ctl00$ContentPlaceHolder1$ucProductListControl$DataListPagerControl$nextPostbackButton";

const listingPage = (id: number, hasNext: boolean): string => `
  <html><head><title>Planet Interim</title></head><body>
    <form method="post" action="./opdrachten?id=13&amp;pageid=13">
      <input type="hidden" name="__VIEWSTATE" value="state-${id}" />
      <input type="hidden" name="__EVENTTARGET" value="" />
      <input type="hidden" name="__EVENTARGUMENT" value="" />
      <a href="/role-${id}/${id}/p13/default.html">Assignment ${id}</a>
      <a id="nextPostbackButton" class="${hasNext ? "nexprev" : "nexprev disabled"}"
        href="javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions(&quot;${NEXT_TARGET}&quot;, &quot;&quot;, true, &quot;&quot;, &quot;&quot;, false, true))">Volgende</a>
    </form>
  </body></html>
`;

const response = (body: string, status = 200, cookie?: string): Response =>
  new Response(body, {
    headers: cookie ? { "set-cookie": cookie } : undefined,
    status,
  });

const recordedPage = async (name: string): Promise<string> => {
  const fixture = await loadConnectorFixture<string>(
    `planet-interim/${name}.json`
  );
  return fixture.payload;
};

describe("Planet Interim WebForms pagination", () => {
  it("carries hidden state and cookies to the next page", async () => {
    const requests: {
      body: string;
      cookie: string | null;
      method: string;
    }[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          body:
            init?.body instanceof URLSearchParams ? init.body.toString() : "",
          cookie: new Headers(init?.headers).get("Cookie"),
          method: init?.method ?? "GET",
        });
        return Promise.resolve(
          requests.length === 1
            ? response(listingPage(1, true), 200, "PI_SESSION=first; Path=/")
            : response(listingPage(2, false))
        );
      },
      { preconnect: () => {} }
    );

    const pages = await fetchPlanetInterimListingPages({
      fetchImpl,
      pageDelayMs: 0,
      timeoutMs: 1000,
      url: LISTING_URL,
    });

    expect(pages).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ method: "GET" });
    const [secondRequest] = requests.slice(1);
    if (!secondRequest) {
      throw new Error("expected a second pagination request");
    }
    expect(secondRequest).toMatchObject({
      cookie: "PI_SESSION=first",
      method: "POST",
    });
    expect(secondRequest.body).toContain(
      `${encodeURIComponent("__EVENTTARGET")}=${encodeURIComponent(
        NEXT_TARGET
      )}`
    );
    expect(secondRequest.body).toContain(
      `${encodeURIComponent("__VIEWSTATE")}=state-1`
    );
  });

  it("forwards only the cookie pair when getSetCookie is unavailable", async () => {
    const requests: { cookie: string | null; url: string }[] = [];
    const first = response(
      listingPage(1, true),
      200,
      "PI_SESSION=first; Path=/; SameSite=Lax"
    );
    Object.defineProperty(first.headers, "getSetCookie", {
      configurable: true,
      value: undefined,
    });
    const fetchImpl: typeof fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          cookie: new Headers(init?.headers).get("Cookie"),
          url: String(input),
        });
        return Promise.resolve(
          requests.length === 1 ? first : response(listingPage(2, false))
        );
      },
      { preconnect: () => {} }
    );

    const seen = await fetchPlanetInterimListingPages({
      fetchImpl,
      pageDelayMs: 0,
      timeoutMs: 1000,
      url: LISTING_URL,
    });

    expect(seen).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.cookie).toBe("PI_SESSION=first");
    expect(requests[1]?.cookie).not.toContain("Path");
    expect(requests[1]?.cookie).not.toContain("SameSite");
  });

  it("fails closed on an ambiguous combined Set-Cookie fallback", async () => {
    const first = response(
      listingPage(1, true),
      200,
      "PI_SESSION=first; Path=/, OTHER=second; Path=/"
    );
    Object.defineProperty(first.headers, "getSetCookie", {
      configurable: true,
      value: undefined,
    });

    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl: Object.assign(() => Promise.resolve(first), {
          preconnect: () => {},
        }),
        pageDelayMs: 0,
        timeoutMs: 1000,
        url: LISTING_URL,
      })
    ).rejects.toThrow("ambiguous combined Set-Cookie header");
  });

  it("feeds paged links through the existing JSON-LD client contract", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = Object.assign(
      () => {
        calls += 1;
        return Promise.resolve(response(listingPage(calls, calls === 1)));
      },
      { preconnect: () => {} }
    );
    const client = createPlanetInterimClient({
      config: planetInterimConfig,
      fetchImpl,
      liveEnabled: true,
      pageDelayMs: 0,
      timeoutMs: 1000,
    });

    const urls = await client.fetchListing();

    expect(urls.map(({ url }) => url)).toEqual([
      "https://planetinterim.nl/role-1/1/p13/default.html",
      "https://planetinterim.nl/role-2/2/p13/default.html",
    ]);
  });

  it("aborts an in-flight client listing request with the caller signal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) => {
        receivedSignal = init?.signal ?? undefined;
        // oxlint-disable-next-line promise/avoid-new -- keeps the request pending until the caller aborts it.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true }
          );
        });
      },
      { preconnect: () => {} }
    );
    const client = createPlanetInterimClient({
      config: planetInterimConfig,
      fetchImpl,
      liveEnabled: true,
      timeoutMs: 1000,
    });
    const pending = client.fetchListing(controller.signal);
    controller.abort(new Error("cancelled in-flight listing"));

    await expect(pending).rejects.toThrow("cancelled in-flight listing");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("replays the real first, next, and last page controls", async () => {
    const pages = await Promise.all([
      recordedPage("pagination-first"),
      recordedPage("pagination-next"),
      recordedPage("pagination-last"),
    ]);
    const requests: { body: string; method: string; url: string }[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const index = requests.length;
        requests.push({
          body:
            init?.body instanceof URLSearchParams ? init.body.toString() : "",
          method: init?.method ?? "GET",
          url: String(input),
        });
        return Promise.resolve(response(pages[index] ?? pages[2] ?? ""));
      },
      { preconnect: () => {} }
    );

    const replayed = await fetchPlanetInterimListingPages({
      fetchImpl,
      maxPages: 3,
      pageDelayMs: 0,
      timeoutMs: 1000,
      url: LISTING_URL,
    });

    expect(replayed).toHaveLength(3);
    expect(requests).toHaveLength(3);
    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "POST",
    ]);
    expect(requests[1]?.body).toContain("__EVENTTARGET=");
    expect(requests[1]?.body).toContain("__VIEWSTATE=");
    expect(requests[1]?.url).toBe(
      "https://planetinterim.nl/opdrachten?id=13&pageid=13"
    );
    expect(requests[2]?.body).toContain("__EVENTTARGET=");
  });

  it("fails closed when a page repeats", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = Object.assign(
      () => {
        calls += 1;
        return Promise.resolve(response(listingPage(1, true)));
      },
      { preconnect: () => {} }
    );

    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl,
        pageDelayMs: 0,
        timeoutMs: 1000,
        url: LISTING_URL,
      })
    ).rejects.toThrow("listing page repeated at page 2");
    expect(calls).toBe(2);
  });

  it("enforces the hard page cap before issuing another POST", async () => {
    let calls = 0;
    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl: Object.assign(
          () => {
            calls += 1;
            return Promise.resolve(response(listingPage(calls, true)));
          },
          { preconnect: () => {} }
        ),
        maxPages: 1,
        pageDelayMs: 0,
        timeoutMs: 1000,
        url: LISTING_URL,
      })
    ).rejects.toThrow("listing pagination exceeded maxPages=1");
    expect(calls).toBe(1);
  });

  it("cancels while waiting between WebForms pages", async () => {
    const controller = new AbortController();
    let calls = 0;
    const cancelTimer = setTimeout(
      () => controller.abort(new Error("cancelled during delay")),
      5
    );

    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl: Object.assign(
          () => {
            calls += 1;
            return Promise.resolve(response(listingPage(1, true)));
          },
          { preconnect: () => {} }
        ),
        pageDelayMs: 50,
        signal: controller.signal,
        timeoutMs: 1000,
        url: LISTING_URL,
      })
    ).rejects.toThrow("cancelled during delay");
    clearTimeout(cancelTimer);
    expect(calls).toBe(1);
  });

  it("fails closed when a present pager loses its next control", async () => {
    const lastPage = await recordedPage("pagination-last");
    const pageWithoutNext = lastPage.replace(
      /<a\b[^>]*DataListPagerControl_nextPostbackButton[^>]*>[\s\S]*?<\/a>/iu,
      ""
    );

    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl: Object.assign(
          () => Promise.resolve(response(pageWithoutNext)),
          { preconnect: () => {} }
        ),
        pageDelayMs: 0,
        timeoutMs: 1000,
        url: LISTING_URL,
      })
    ).rejects.toThrow("listing pager has no next WebForms control");
  });

  it("fails closed on malformed and block pages", async () => {
    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl: Object.assign(
          () =>
            Promise.resolve(response("<html><body>no listing</body></html>")),
          { preconnect: () => {} }
        ),
        pageDelayMs: 0,
        timeoutMs: 1000,
        url: LISTING_URL,
      })
    ).rejects.toBeInstanceOf(PlanetInterimPaginationError);

    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl: Object.assign(
          () =>
            Promise.resolve(
              response(
                "<html><head><title>Just a moment...</title></head></html>"
              )
            ),
          { preconnect: () => {} }
        ),
        pageDelayMs: 0,
        timeoutMs: 1000,
        url: LISTING_URL,
      })
    ).rejects.toThrow("block page");
  });

  it("honours cancellation before the first request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let calls = 0;

    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl: Object.assign(
          () => {
            calls += 1;
            return Promise.resolve(response(listingPage(1, false)));
          },
          { preconnect: () => {} }
        ),
        signal: controller.signal,
        url: LISTING_URL,
      })
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(0);
  });

  it("rejects a cross-origin WebForms action before forwarding cookies", async () => {
    const requests: string[] = [];
    const firstPage = listingPage(1, true).replace(
      "./opdrachten?id=13&amp;pageid=13",
      "https://evil.example/next"
    );
    const fetchImpl: typeof fetch = Object.assign(
      (input: string | URL | Request) => {
        requests.push(String(input));
        return Promise.resolve(response(firstPage, 200, "PI_SESSION=first"));
      },
      { preconnect: () => {} }
    );

    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl,
        pageDelayMs: 0,
        timeoutMs: 1000,
        url: LISTING_URL,
      })
    ).rejects.toThrow(
      "listing form action must stay on the Planet Interim origin"
    );
    expect(requests).toEqual([LISTING_URL]);
  });

  it("keeps the timeout active while reading a stalled response body", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) => {
        const stalledBody = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal?.reason),
              { once: true }
            );
          },
        });
        return Promise.resolve(new Response(stalledBody));
      },
      { preconnect: () => {} }
    );

    await expect(
      fetchPlanetInterimListingPages({
        fetchImpl,
        pageDelayMs: 0,
        timeoutMs: 20,
        url: LISTING_URL,
      })
    ).rejects.toBeInstanceOf(HttpTimeoutError);
  });
});
