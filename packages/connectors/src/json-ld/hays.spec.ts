import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { haysConfig } from "./configs/hays";

const client = createJsonLdClient({ config: haysConfig, liveEnabled: false });
const scrumUrl =
  "https://www.hays.nl/vacature-details/scrum-master-provincie-utrecht_1049921?q=&location=&applyId=JOB_5377570&jobSource=HaysGCJ&isSponsored=N&specialismId=&subSpecialismId=&jobName=projects/mineral-balm-174308/tenants/ab5d683d-f9a5-4b85-bfe0-eb74881e24cf/jobs/103039416380859078&lang=nl";
const buyerUrl =
  "https://www.hays.nl/vacature-details/buyer-sports-and-outdoor-amsterdam_1050471?q=&location=&applyId=JOB_5411289&jobSource=HaysGCJ&isSponsored=N&specialismId=&subSpecialismId=&jobName=projects/mineral-balm-174308/tenants/ab5d683d-f9a5-4b85-bfe0-eb74881e24cf/jobs/134360935685857990&lang=nl";
const financeUrl =
  "https://www.hays.nl/vacature-details/finance-business-partner-rotterdam_1050462?q=&location=&applyId=JOB_5412125&jobSource=HaysGCJ&isSponsored=N&specialismId=&subSpecialismId=&jobName=projects/mineral-balm-174308/tenants/ab5d683d-f9a5-4b85-bfe0-eb74881e24cf/jobs/96725423613715142&lang=nl";

describe("Hays JSON-LD connector", () => {
  it("discovers the recorded tracking URLs by pathname", async () => {
    const discovered = await client.fetchListing();
    expect(discovered).toHaveLength(10);
    expect(discovered.map(({ url }) => url)).toContain(scrumUrl);
    expect(discovered.map(({ url }) => url)).toContain(buyerUrl);
    expect(discovered.map(({ url }) => url)).toContain(financeUrl);
  });

  it("parses the recorded Scrum Master JobPosting fields", async () => {
    const detail = await client.fetchDetail(scrumUrl);
    expect(detail.jobPosting).toMatchObject({
      baseSalary: {
        currency: "euro",
        value: { unitText: "YEAR", value: "In consultation" },
      },
      datePosted: "2026-09-09",
      hiringOrganization: { name: "Hays" },
      jobLocation: { address: { addressLocality: "Provincie Utrecht" } },
      title: "Scrum Master",
      validThrough: "2026-12-07",
    });
  });

  it("folds the consultant card (gtm_jobowner_name + jd_telephone) into contactpersonen (CTP-610)", async () => {
    const detail = await client.fetchDetail(buyerUrl);
    expect(detail.contactpersonen).toEqual([
      {
        naam: "A. de Vries",
        rol: "jobowner",
        telefoon: "+31000000000",
      },
    ]);
  });

  it("yields no contactpersonen when the page carries no consultant card", async () => {
    const detail = await client.fetchDetail(scrumUrl);
    expect(detail.contactpersonen).toEqual([]);
  });
});
