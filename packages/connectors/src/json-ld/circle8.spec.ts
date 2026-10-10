import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { circle8Config } from "./configs/circle8";

const client = createJsonLdClient({
  config: circle8Config,
  liveEnabled: false,
});
const itRecruiterUrl = "https://werkenbij.circle8.nl/jobs/8338072-it-recruiter";
const bedrijfsjuristUrl =
  "https://werkenbij.circle8.nl/jobs/7851475-bedrijfsjurist";

describe("Circle8 JSON-LD connector", () => {
  it("discovers every /jobs/<id>-<slug> vacancy link on the recorded listing", async () => {
    const discovered = await client.fetchListing();
    expect(discovered).toHaveLength(2);
    expect(discovered.map(({ url }) => url)).toEqual(
      expect.arrayContaining([itRecruiterUrl, bedrijfsjuristUrl])
    );
  });

  it("parses the recorded IT Recruiter JobPosting and label block", async () => {
    const detail = await client.fetchDetail(itRecruiterUrl);
    expect(detail.jobPosting).toMatchObject({
      "@type": "JobPosting",
      datePosted: "2026-09-08T09:53:59+02:00",
      employmentType: "FULL_TIME",
      hiringOrganization: { name: "Circle8" },
      identifier: { value: "8338072" },
      jobLocation: [{ address: { addressLocality: "Nieuwegein" } }],
      title: "IT Recruiter",
    });
    expect(detail.labelBlock).toMatchObject({
      afdeling: "Recruitment",
      locaties: "Circle8 Nederland",
      rol: "Recruiter",
      statusWerkenOpAfstand: "Hybride",
      tarief: "salaris tussen de €3656 - €4500",
      urenPerWeek: "32 en 40 uur",
    });
  });

  it("parses the Bedrijfsjurist detail whose <dl> carries no Rol row", async () => {
    const detail = await client.fetchDetail(bedrijfsjuristUrl);
    expect(detail.jobPosting).toMatchObject({
      identifier: { value: "7851475" },
      title: "Bedrijfsjurist",
    });
    expect(detail.labelBlock).toMatchObject({
      afdeling: "HR",
      tarief: "salaris tussen de €4000 en €6500",
    });
    expect(detail.labelBlock.rol).toBeUndefined();
  });

  it("folds the Contact card into contactpersonen — naam and rol from the card, telefoon from the card-anchored closing line", async () => {
    const detail = await client.fetchDetail(itRecruiterUrl);
    expect(detail.contactpersonen).toEqual([
      {
        naam: "Monique Manger",
        rol: "Corporate Recruiter – HR",
        telefoon: "+31000000000",
      },
    ]);
  });
});
