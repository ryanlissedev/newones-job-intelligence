import { describe, expect, it } from "bun:test";

import { loadConnectorFixture } from "@ji/connectors";

import {
  canonicalLinkedinJobUrl,
  createLinkedinClient,
  createLinkedinConnector,
  parseLinkedinDetail,
  parseLinkedinListing,
} from "./index";

const BRON_ID = "bron-linkedin-fixture";
const FIRST_URL =
  "https://nl.linkedin.com/jobs/view/freelance-ai-multimedia-designer-433-at-433-4419416701";

const syntheticPage = (start: number) => ({
  items: Array.from({ length: 10 }, (_, index) => ({
    bronReferentie: `jobs/view/job-${start + index}`,
    jobId: String(start + index),
    titel: `Job ${start + index}`,
    url: `https://nl.linkedin.com/jobs/view/job-${start + index}`,
  })),
});

describe("LinkedIn guest-route connector", () => {
  it("canonicalises published hrefs by stripping per-request tracking params", () => {
    expect(
      canonicalLinkedinJobUrl(
        "https://nl.linkedin.com/jobs/view/some-job-at-acme-1234567?position=1&pageNum=0&refId=abc&trackingId=xyz"
      )
    ).toBe("https://nl.linkedin.com/jobs/view/some-job-at-acme-1234567");
    expect(
      canonicalLinkedinJobUrl("https://example.com/jobs/view/x-123")
    ).toBeUndefined();
    expect(
      canonicalLinkedinJobUrl("https://nl.linkedin.com/company/acme")
    ).toBeUndefined();
  });

  it("parses listing cards from the recorded fragment", async () => {
    const fixture = await loadConnectorFixture<string>(
      "linkedin/listing-page-0.json"
    );
    const listing = parseLinkedinListing(fixture.payload);

    expect(listing.items).toHaveLength(10);
    const [first] = listing.items;
    expect(first).toMatchObject({
      bronReferentie:
        "jobs/view/freelance-ai-multimedia-designer-433-at-433-4419416701",
      geplaatst: "2026-05-26",
      jobId: "4419416701",
      locatie: "Netherlands",
      opdrachtgever: "433",
      titel: "Freelance AI Multimedia Designer - 433",
      url: FIRST_URL,
    });
    for (const item of listing.items) {
      expect(item.url).not.toContain("?");
      expect(item.bronReferentie.startsWith("jobs/view/")).toBe(true);
    }
  });

  it("extracts the explicit JobPosting node plus Dutch criteria when ld+json is served", async () => {
    const url =
      "https://nl.linkedin.com/jobs/view/software-engineering-expert-ai-training-%E2%82%AC65%E2%80%9390-h-at-huzzle-com-4456662010";
    const fixture = await loadConnectorFixture<string>(
      "linkedin/detail-software-engineering-expert-4456662010.json"
    );
    const detail = parseLinkedinDetail(fixture.payload, url);

    expect(detail.jobPosting).not.toBeNull();
    expect(detail.jobPosting?.["@type"]).toBe("JobPosting");
    expect(detail.jobPosting?.title).toBe(
      "Software Engineering Expert (AI Training, €65–90/h)"
    );
    expect(detail.jobPosting?.employmentType).toBe("CONTRACTOR");
    expect(detail.labelBlock).toMatchObject({
      employment_type: "Contract",
      geplaatst: "3 weken geleden",
      industries: "Softwareontwikkeling",
      job_function: "Techniek en Informatietechniek",
      seniority_level: "Instapniveau",
    });
  });

  it("synthesises a JobPosting from topcard/criteria markup when ld+json is absent", async () => {
    const fixture = await loadConnectorFixture<string>(
      "linkedin/detail-freelance-ai-multimedia-designer-433-at-433-4419416701.json"
    );
    expect(fixture.payload).not.toContain("ld+json");
    const detail = parseLinkedinDetail(fixture.payload, FIRST_URL);

    expect(detail.jobPosting).toMatchObject({
      "@type": "JobPosting",
      employmentType: "OTHER",
      hiringOrganization: {
        name: "433",
        sameAs: "https://nl.linkedin.com/company/by433",
      },
      identifier: { name: "LinkedIn", value: "4419416701" },
      industry: "Designdiensten",
      jobLocation: {
        address: { addressCountry: "NL", addressLocality: "Nederland" },
      },
      title: "Freelance AI Multimedia Designer - 433",
      url: FIRST_URL,
    });
    expect(String(detail.jobPosting?.description)).toContain("design");
    expect(detail.labelBlock).toMatchObject({
      applicants: "Meer dan 200 sollicitanten",
      employment_type: "Ander",
      geplaatst: "3 maanden geleden",
      industries: "Designdiensten",
      job_function: "Design",
      seniority_level: "Senior medewerker",
    });
  });

  it("discovers the recorded listing and fetches a JSON-LD-shaped observation", async () => {
    const client = createLinkedinClient({ liveEnabled: false });
    const connector = createLinkedinConnector({ bronId: BRON_ID, client });

    const discovery = await connector.discover(null);
    expect(discovery.items).toHaveLength(10);
    // A full page under the page cap keeps paging; the fixture client then
    // serves an empty page for start > 0, which ends the run.
    expect(discovery.hasMore).toBe(true);
    const followUp = await connector.discover(discovery.checkpoint);
    expect(followUp.items).toHaveLength(0);
    expect(followUp.hasMore).toBe(false);
    const [item] = discovery.items;
    if (!item) {
      throw new Error("expected a discovered item");
    }
    const result = await connector.fetch(item);

    expect(result?.status).toBe("fetched");
    if (result?.status !== "fetched") {
      return;
    }
    // SAFETY: the fetched body is the connector's own JSON serialisation.
    const payload = JSON.parse(new TextDecoder().decode(result.body)) as {
      jobPosting: { "@type"?: string; title?: string };
      labelBlock: Record<string, string>;
      parserVersion: string;
      slug: string;
      url: string;
    };
    expect(payload).toMatchObject({
      jobPosting: { "@type": "JobPosting" },
      parserVersion: "linkedin/v1",
      slug: "linkedin",
      url: FIRST_URL,
    });
    expect(payload.labelBlock.seniority_level).toBe("Senior medewerker");
  });

  it("stops paging when a page adds no new items", async () => {
    const listingFixture = await loadConnectorFixture<string>(
      "linkedin/listing-page-0.json"
    );
    const page = parseLinkedinListing(listingFixture.payload);
    const client = createLinkedinClient({ liveEnabled: false });
    const connector = createLinkedinConnector({
      bronId: BRON_ID,
      client: {
        fetchDetail: client.fetchDetail,
        fetchListing: () => Promise.resolve(page),
      },
    });

    const first = await connector.discover(null);
    const second = await connector.discover(first.checkpoint);
    expect(second.items).toHaveLength(0);
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBe(false);
  });

  it("reports a still-full page at the page cap as truncated", async () => {
    const client = createLinkedinClient({ liveEnabled: false });
    const connector = createLinkedinConnector({
      bronId: BRON_ID,
      client: {
        fetchDetail: client.fetchDetail,
        fetchListing: (start) => Promise.resolve(syntheticPage(start)),
      },
    });

    let result = await connector.discover(null);
    while (result.hasMore) {
      // oxlint-disable-next-line no-await-in-loop -- pagination requests stay ordered and bounded by the page cap.
      result = await connector.discover(result.checkpoint);
    }
    expect(result.truncated).toBe(true);
  });
});
