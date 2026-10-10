import { describe, expect, it } from "bun:test";

import { loadConnectorFixture } from "../fixtures/load";
import { createIndeedClient } from "./client";
import type { IndeedClient } from "./client";
import { createIndeedConnector } from "./connector";
import { isIndeedBlockedPage, parseIndeedSearchPage } from "./extract";
import { hashIndeedListingItem } from "./hash";
import type { IndeedFetchedPayload, IndeedJobCard } from "./types";

const BRON_ID = "00000000-0000-4000-8000-000000000044";

const fixtureClient = (): IndeedClient =>
  createIndeedClient({ liveEnabled: false });

const fixtureConnector = () =>
  createIndeedConnector({ bronId: BRON_ID, client: fixtureClient() });

const decodeBody = (body: Uint8Array): IndeedFetchedPayload =>
  // SAFETY: connector.fetch() serialises IndeedFetchedPayload as JSON.
  JSON.parse(new TextDecoder().decode(body)) as IndeedFetchedPayload;

describe("indeed connector (fixture mode, real 2026-09-18 capture)", () => {
  it("discovers the 15 real cards and paginates on the SERP's own pageLinks", async () => {
    const discovery = await fixtureConnector().discover(null);
    expect(discovery.items).toHaveLength(15);
    expect(discovery.items[0]?.bronReferentie).toBe("12c9e91e86a09037");
    expect(discovery.items.map((item) => item.bronReferentie)).toContain(
      "7ed578a3b2f4449d"
    );
    // pageLinks label 2 carries start=10 upstream (stride 10, 15 cards/page).
    expect(discovery.hasMore).toBe(true);
    expect(discovery.checkpoint.cursor).toBe('indeed:{"n":1,"start":10}');
  });

  it("ends the sweep when the page carries no further pageLink", async () => {
    const discovery = await fixtureConnector().discover({
      cursor: 'indeed:{"n":1,"start":10}',
    });
    expect(discovery.items).toEqual([]);
    expect(discovery.hasMore).toBe(false);
  });

  it("marks a page-capped sweep truncated instead of clean", async () => {
    const discovery = await createIndeedConnector({
      bronId: BRON_ID,
      client: fixtureClient(),
      pageLimit: 1,
    }).discover(null);
    expect(discovery.hasMore).toBe(false);
    expect(discovery.truncated).toBe(true);
  });

  it("fetches the embedded viewjob payload for the auto-opened card", async () => {
    const connector = fixtureConnector();
    const discovery = await connector.discover(null);
    const [first] = discovery.items;
    if (!first) {
      throw new Error("expected fixture items");
    }
    const result = await connector.fetch(first);
    expect(result?.status).toBe("fetched");
    if (result?.status !== "fetched") {
      throw new Error("expected a fetched result");
    }
    const payload = decodeBody(result.body);
    expect(payload.jobkey).toBe("12c9e91e86a09037");
    expect(payload.detail.jobKey).toBe("12c9e91e86a09037");
    expect(payload.detail.jobTitle).toBe(
      "Business Developer / Adviseur Energie"
    );
    expect(payload.detail.companyName).toBe("CloudCrest B.V.");
    expect(payload.detail.formattedLocation).toBe("Utrecht");
    expect(payload.detail.salaryInfoModel?.salaryMin).toBe(5500);
    expect(payload.detail.salaryInfoModel?.salaryType).toBe("MONTHLY");
    expect(payload.detail.sanitizedJobDescription?.length ?? 0).toBeGreaterThan(
      1000
    );
    expect(payload.card?.company).toBe("CloudCrest B.V.");
  });

  it("rejects cards whose viewjob body is not anonymously published", async () => {
    const connector = fixtureConnector();
    const discovery = await connector.discover(null);
    const [, second] = discovery.items;
    if (!second) {
      throw new Error("expected a second fixture item");
    }
    const result = await connector.fetch(second);
    if (result?.status !== "rejected") {
      throw new Error("expected a rejected result");
    }
    expect(result.reason).toContain("474a2dc2a0156618");
  });

  it("rejects a bronReferentie that is not a jobkey", async () => {
    const result = await fixtureConnector().fetch({
      bronReferentie: "not-a-jobkey",
      contentHash: "x",
    });
    expect(result?.status).toBe("rejected");
  });
});

describe("indeed DEC-008 whitelist", () => {
  it("drops tracking/encrypted upstream card fields", async () => {
    const connector = fixtureConnector();
    const discovery = await connector.discover(null);
    const [first] = discovery.items;
    if (!first) {
      throw new Error("expected fixture items");
    }
    // SAFETY: discover() attaches IndeedJobCard rows as listingPayload.
    const card = first.listingPayload as IndeedJobCard;
    const keys = Object.keys(card);
    for (const dropped of [
      "adBlob",
      "adId",
      "advn",
      "blobKey",
      "encryptedFccompanyId",
      "encryptedResultData",
      "extractTrackingUrls",
      "link",
      "mobtk",
      "mouseDownHandlerOption",
      "rankingScoresModel",
      "screenerQuestionsURL",
      "searchUID",
      "thirdPartyApplyUrl",
    ]) {
      expect(keys).not.toContain(dropped);
    }
  });

  it("drops session/tracking models from the viewjob body", async () => {
    const connector = fixtureConnector();
    const discovery = await connector.discover(null);
    const [first] = discovery.items;
    if (!first) {
      throw new Error("expected fixture items");
    }
    const result = await connector.fetch(first);
    if (result?.status !== "fetched") {
      throw new Error("expected a fetched result");
    }
    const payload = decodeBody(result.body);
    const keys = Object.keys(payload.detail);
    for (const dropped of [
      "accountKey",
      "ctk",
      "deploymentGroupToken",
      "mobtk",
      "oneGraphApiKey",
      "segmentId",
    ]) {
      expect(keys).not.toContain(dropped);
    }
  });
});

describe("indeed block detection (real recorded block pages)", () => {
  const blockedFixtures = [
    "indeed/blocked-search-challenge.json",
    "indeed/blocked-viewjob-authenticating.json",
    "indeed/blocked-security-check.json",
  ];

  it("flags every recorded block page as blocked, never as an empty listing", async () => {
    const fixtures = await Promise.all(
      blockedFixtures.map((path) => loadConnectorFixture<string>(path))
    );
    for (const fixture of fixtures) {
      expect(isIndeedBlockedPage(fixture.payload)).toBe(true);
      expect(parseIndeedSearchPage(fixture.payload)).toBeNull();
    }
  });

  it("throws instead of returning an empty listing when live is challenged", async () => {
    const fixture = await loadConnectorFixture<string>(
      "indeed/blocked-search-challenge.json"
    );
    const fetchImpl: typeof fetch = Object.assign(
      () =>
        Promise.resolve(
          new Response(fixture.payload, {
            headers: { "cf-mitigated": "challenge" },
            status: 403,
          })
        ),
      { preconnect: fetch.preconnect }
    );
    const client = createIndeedClient({ fetchImpl, liveEnabled: true });
    await expect(client.fetchListing(0)).rejects.toThrow(/challenge|blocked/iu);
  });
});

describe("indeed listing hash coverage (RJC-357 / RJC-401)", () => {
  const baseCard: IndeedJobCard = {
    company: null,
    companyRating: null,
    companyReviewCount: null,
    country: null,
    createDate: null,
    displayTitle: null,
    expired: false,
    extractedSalary: null,
    formattedLocation: null,
    formattedRelativeTime: null,
    hiresNeededExact: null,
    indeedApplyable: false,
    jobLocationCity: null,
    jobLocationState: null,
    jobTypes: [],
    jobkey: "12c9e91e86a09037",
    newJob: false,
    normTitle: null,
    pubDate: null,
    redirectToThirdPartySite: false,
    remoteWorkModel: null,
    requirementLabels: [],
    salarySnippet: null,
    snippet: null,
    sponsored: false,
    title: null,
    truncatedCompany: null,
    urgentlyHiring: false,
    viewJobLink: null,
  };

  it("covers every whitelisted IndeedJobCard field", async () => {
    const variants: Partial<IndeedJobCard>[] = [
      { company: "Andere werkgever" },
      { companyRating: 4.1 },
      { companyReviewCount: 37 },
      { country: "NL" },
      { createDate: 1_782_204_876_229 },
      { displayTitle: "Andere titel" },
      { expired: true },
      { extractedSalary: { max: 100, min: 80, type: "YEARLY" } },
      { formattedLocation: "Amsterdam" },
      { formattedRelativeTime: "Zojuist geplaatst" },
      { hiresNeededExact: "5" },
      { indeedApplyable: true },
      { jobkey: "ffffffffffffffff" },
      { jobLocationCity: "Amsterdam" },
      { jobLocationState: "NH" },
      { jobTypes: ["Fulltime"] },
      { newJob: true },
      { normTitle: "Developer" },
      { pubDate: 1_789_707_600_001 },
      { redirectToThirdPartySite: true },
      { remoteWorkModel: { text: "Hybride werken", type: "REMOTE_HYBRID" } },
      { requirementLabels: ["Bachelor"] },
      {
        salarySnippet: {
          currency: "EUR",
          source: "EXTRACTION",
          text: "€ 4.000 per maand",
        },
      },
      { snippet: "<ul><li>anders</li></ul>" },
      { sponsored: true },
      { title: "Andere functietitel" },
      { truncatedCompany: "Andere B.V." },
      { urgentlyHiring: true },
      { viewJobLink: "/viewjob?jk=ffffffffffffffff" },
    ];
    const projectedKeys = Object.keys(baseCard).toSorted();
    expect(
      variants.flatMap((variant) => Object.keys(variant)).toSorted()
    ).toEqual(projectedKeys);
    const base = await hashIndeedListingItem(baseCard);
    for (const variant of variants) {
      // oxlint-disable-next-line no-await-in-loop -- sequential hash comparisons keep the failure message per-field
      const changed = await hashIndeedListingItem({ ...baseCard, ...variant });
      expect(changed).not.toBe(base);
    }
  });
});
