import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { vattenfallConfig } from "./configs/vattenfall";

describe("Vattenfall JSON-LD connector", () => {
  it("discovers exactly the 20 Dutch detail URLs", async () => {
    const client = createJsonLdClient({
      config: vattenfallConfig,
      liveEnabled: false,
    });
    const urls = await client.fetchListing();
    expect(urls).toHaveLength(20);
    expect(
      urls.every(({ url }) =>
        /-in-(?:amsterdam|arnhem|diemen|ijmuiden|slootdorp)-jid-\d+$/u.test(url)
      )
    ).toBe(true);
  });

  it("parses the recorded detail fixtures' raw JobPosting node", async () => {
    const client = createJsonLdClient({
      config: vattenfallConfig,
      liveEnabled: false,
    });
    const urls = Object.keys(vattenfallConfig.detailFixtures ?? {});
    expect(urls).toHaveLength(3);

    const amsterdam = urls.find((url) => url.includes("analytics-engineer"));
    if (!amsterdam) {
      throw new Error("missing analytics-engineer fixture");
    }
    const detail = await client.fetchDetail(amsterdam);
    expect(detail.jobPosting).toMatchObject({
      datePosted: "2026-09-14T07:03:00+00:00",
      employmentType: ["Full-time"],
      hiringOrganization: { name: "Vattenfall" },
      jobLocation: [{ address: { addressLocality: "Amsterdam" } }],
      title: "Analytics Engineer",
      validThrough: "2126-09-14T07:03:00+00:00",
    });

    const arnhem = urls.find((url) => url.includes("monteur-stadswarmte"));
    if (!arnhem) {
      throw new Error("missing monteur-stadswarmte fixture");
    }
    const arnhemDetail = await client.fetchDetail(arnhem);
    expect(arnhemDetail.jobPosting).toMatchObject({
      hiringOrganization: { name: "Vattenfall" },
      jobLocation: [{ address: { addressLocality: "Arnhem" } }],
      title: "Monteur Stadswarmte",
    });

    const slootdorp = urls.find((url) => url.includes("slootdorp"));
    if (!slootdorp) {
      throw new Error("missing slootdorp fixture");
    }
    const slootdorpDetail = await client.fetchDetail(slootdorp);
    expect(slootdorpDetail.jobPosting).toMatchObject({
      hiringOrganization: { name: "Vattenfall" },
      jobLocation: [{ address: { addressLocality: "Slootdorp" } }],
      title: "Service Technician - Onshore Wind Turbines",
    });
  });
});
