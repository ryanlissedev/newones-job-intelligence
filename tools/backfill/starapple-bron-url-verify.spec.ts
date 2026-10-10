import { describe, expect, it } from "bun:test";

import type { NeonV1JobRow } from "../../packages/application/src/backfill/neon-v1-types";
import {
  planStarappleBronVerification,
  verifyStarappleBronUrls,
} from "./starapple-bron-url-verify";

const liveIndex = (slugs: readonly string[]) => ({
  slugs: new Set(slugs),
});

const okResponse = (url: string, body = "<html></html>") => ({
  ok: true,
  redirected: false,
  status: 200,
  text: () => Promise.resolve(body),
  url,
});

const job = (overrides: Partial<NeonV1JobRow> = {}): NeonV1JobRow => ({
  external_id: "devops-platform-engineer",
  id: "job-1",
  platform: "starapple-nl",
  title: "DevOps Platform Engineer",
  ...overrides,
});

describe("planStarappleBronVerification", () => {
  it("plans the resolved URL and the previously stored URL per Starapple row", () => {
    const plan = planStarappleBronVerification({
      jobs: [
        job(),
        job({
          external_id: "next-gen-engineers",
          id: "job-2",
          title: "Next Gen Engineers",
        }),
        job({ id: "job-3", platform: "nationalevacaturebank" }),
      ],
      liveIndex: liveIndex(["devops-platform-engineer"]),
    });
    // Non-Starapple rows are out of scope for this tool.
    expect(plan).toHaveLength(2);
    const [exact, stale] = plan;
    expect(exact?.previousUrl).toBe(
      "https://www.starapple.nl/vacatures/devops-platform-engineer/"
    );
    expect(exact?.bronUrl).toBe(
      "https://www.starapple.nl/vacatures/devops-platform-engineer/"
    );
    expect(stale?.previousUrl).toBe(
      "https://www.starapple.nl/vacatures/next-gen-engineers/"
    );
    expect(stale?.bronUrl).toBe(
      "https://web.archive.org/web/https://www.starapple.nl/vacatures/next-gen-engineers/"
    );
  });
});

describe("verifyStarappleBronUrls", () => {
  it("runs the deterministic plan without any network when probe is off", async () => {
    const receipt = await verifyStarappleBronUrls({
      jobs: [
        job(),
        job({
          external_id: "gone-forever",
          id: "job-2",
          title: "Gone Forever",
        }),
      ],
      liveIndex: liveIndex(["devops-platform-engineer"]),
      probe: false,
    });
    expect(receipt.counts).toMatchObject({
      archive: 1,
      liveExact: 1,
      liveRematch: 0,
      probed: 0,
      unknown: 0,
    });
    expect(receipt.results[0]?.bronProbe).toBeUndefined();
  });

  it("probes the stale previous URL and the resolved bron URL within budget", async () => {
    const fetched: string[] = [];
    const receipt = await verifyStarappleBronUrls({
      fetchImpl: (url) => {
        fetched.push(url);
        return Promise.resolve(
          url.startsWith(
            "https://www.starapple.nl/vacatures/next-gen-engineers/"
          )
            ? { ...okResponse(url), ok: false, status: 404 }
            : okResponse(url)
        );
      },
      jobs: [
        job({
          external_id: "next-gen-engineers",
          title: "Next Gen Engineers",
        }),
      ],
      liveIndex: liveIndex(["devops-platform-engineer"]),
      probe: true,
      sleepImpl: () => Promise.resolve(),
    });
    // previousUrl (404 evidence) and bronUrl (wayback) both probed once.
    expect(fetched).toEqual([
      "https://www.starapple.nl/vacatures/next-gen-engineers/",
      "https://web.archive.org/web/https://www.starapple.nl/vacatures/next-gen-engineers/",
    ]);
    expect(receipt.results[0]?.previousProbe?.status).toBe(404);
    expect(receipt.results[0]?.bronProbe?.status).toBe(200);
    expect(receipt.counts.probed).toBe(2);
  });

  it("extracts page facts only for live pages that answered 200", async () => {
    const page =
      '<h1>Rol</h1><div>Utrecht</div><div class="vacancy-meta">40 uur · € 3.000-4.000</div>';
    const receipt = await verifyStarappleBronUrls({
      fetchImpl: (url) => Promise.resolve(okResponse(url, page)),
      jobs: [job()],
      liveIndex: liveIndex(["devops-platform-engineer"]),
      pages: true,
      probe: true,
      sleepImpl: () => Promise.resolve(),
    });
    const [result] = receipt.results;
    // previousUrl === bronUrl for an exact hit, so only one probe runs.
    expect(result?.pageFacts?.locatieTekst).toBe("Utrecht");
    expect(result?.pageFacts?.urenPerWeek).toBe("40");
  });

  it("never spends probe budget on a non-URL previous value", async () => {
    // A row without a derivable slug resolves `unknown` and stored
    // `unknown` — neither is a URL, so nothing may be fetched.
    const fetched: string[] = [];
    const receipt = await verifyStarappleBronUrls({
      fetchImpl: (url) => {
        fetched.push(url);
        return Promise.resolve(okResponse(url));
      },
      jobs: [job({ external_id: " ", external_url: null })],
      liveIndex: liveIndex(["devops-platform-engineer"]),
      probe: true,
      sleepImpl: () => Promise.resolve(),
    });
    expect(fetched).toEqual([]);
    expect(receipt.counts.probed).toBe(0);
    expect(receipt.counts.unknown).toBe(1);
  });

  it("respects the max-probes bound across rows", async () => {
    let fetched = 0;
    const receipt = await verifyStarappleBronUrls({
      fetchImpl: () => {
        fetched += 1;
        return Promise.resolve(okResponse("https://www.starapple.nl/x/"));
      },
      jobs: [
        job({
          external_id: "next-gen-engineers",
          id: "1",
          title: "Next Gen Engineers",
        }),
        job({ external_id: "gone-forever", id: "2", title: "Gone Forever" }),
        job({ external_id: "also-gone", id: "3", title: "Also Gone" }),
      ],
      liveIndex: liveIndex(["devops-platform-engineer"]),
      maxProbes: 2,
      probe: true,
      sleepImpl: () => Promise.resolve(),
    });
    expect(fetched).toBe(2);
    expect(receipt.counts.probed).toBe(2);
  });
});
