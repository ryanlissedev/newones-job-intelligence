import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { allianderConfig } from "./configs/alliander";
import { resolveDetailFetchUrl } from "./discovery";
import { synthesizeJobPostingFromAllianderVacancy } from "./extract";

describe("Alliander JSON-LD connector (JSON vacancy API)", () => {
  it("discovers only the public /vacatures/<slug>/jr<id> URLs", async () => {
    const urls = await createJsonLdClient({
      config: allianderConfig,
      liveEnabled: false,
    }).fetchListing();
    expect(urls).toHaveLength(3);
    expect(
      urls.every(({ url }) =>
        /^https:\/\/werkenbij\.alliander\.com\/vacatures\/[^/]+\/jr\d+$/u.test(
          url
        )
      )
    ).toBe(true);
  });

  it("rewrites the public detail URL onto the vacancy API for the fetch", () => {
    // The sitemap ids are lowercase jr<id>, but the recorded API path
    // segments are uppercase JR<id> — the rewrite must uppercase the id.
    expect(
      resolveDetailFetchUrl(
        allianderConfig,
        "https://werkenbij.alliander.com/vacatures/gasmonteur-in-opleiding/jr18244"
      )
    ).toBe("https://werkenbij.alliander.com/api/vacancy/JR18244");
    expect(
      resolveDetailFetchUrl(
        allianderConfig,
        "https://werkenbij.alliander.com/vacatures/inhuur"
      )
    ).toBe("https://werkenbij.alliander.com/vacatures/inhuur");
  });

  it("synthesises a JobPosting from each vacancy API record", async () => {
    const client = createJsonLdClient({
      config: allianderConfig,
      liveEnabled: false,
    });
    const cases = [
      [
        "https://werkenbij.alliander.com/vacatures/business-partner-veiligheid-milieu-en-kwaliteit/jr14092",
        "Business Partner Veiligheid, Milieu en Kwaliteit",
        "Alliander",
        "Arnhem",
        "JR14092",
        "Salarisschaal 11",
        "2026-10-09T07:00:00",
      ],
      [
        "https://werkenbij.alliander.com/vacatures/gasmonteur-in-opleiding/jr18244",
        "Gasmonteur in opleiding",
        "Liander",
        "Amsterdam",
        "JR18244",
        "Salarisschaal 04",
        "2026-10-20T07:00:00",
      ],
      [
        "https://werkenbij.alliander.com/vacatures/cloud-security-specialist/jr17461",
        "Cloud Security Specialist",
        "Alliander",
        "Haarlem",
        "JR17461",
        "Salarisschaal 10",
        "2026-12-15T08:00:00",
      ],
    ] as const;
    await Promise.all(
      cases.map(async ([url, title, employer, city, id, grade, endDate]) => {
        const detail = await client.fetchDetail(url);
        expect(detail.jobPosting).toMatchObject({
          "@type": "JobPosting",
          employmentType: "Fulltime",
          hiringOrganization: { name: employer },
          identifier: { name: "Alliander", value: id },
          jobLocation: {
            address: { addressCountry: "NL", addressLocality: city },
          },
          title,
          url,
          validThrough: endDate,
          workHours: "40 uur",
        });
        expect(detail.labelBlock.referentienummer).toBe(id);
        expect(detail.labelBlock.salarisschaal).toBe(grade);
        expect(detail.labelBlock.urenPerWeek).toBe("40 uur");
        // CTP-610: contact fields travel as `contactpersonen`, never inside
        // the JobPosting itself. The committed fixtures carry none (PII
        // stripped at capture), so the live-only path is unit-tested below.
        expect(JSON.stringify(detail.jobPosting)).not.toContain(
          "contactPerson"
        );
      })
    );
  });

  it("carries contactPerson fields over as contactpersonen (CTP-610)", () => {
    const synthesis = synthesizeJobPostingFromAllianderVacancy(
      JSON.stringify({
        contactPerson: "A. de Vries",
        contactPersonEmailAddress: "redacted@example.invalid",
        employer: "Alliander",
        id: "JR99999",
        jobTitle: "Spec title",
      }),
      "https://werkenbij.alliander.com/vacatures/spec-title/jr99999"
    );
    expect(synthesis?.contactpersonen).toEqual([
      { email: "redacted@example.invalid", naam: "A. de Vries" },
    ]);
  });
});
