import { describe, expect, it } from "bun:test";

import { createJsonLdClient } from "./client";
import { rijkswaterstaatConfig } from "./configs/rijkswaterstaat";
import { synthesizeContactsFromRijkswaterstaatPage } from "./extract";

const client = createJsonLdClient({
  config: rijkswaterstaatConfig,
  liveEnabled: false,
});

describe("Rijkswaterstaat JSON-LD connector", () => {
  it("keeps only the three recorded vacancy detail URLs", async () => {
    expect(await client.fetchListing()).toEqual([
      {
        lastmod: "2026-09-09",
        url: "https://werkenbij.rijkswaterstaat.nl/vacatures/adviseur-assetmanagement-rivierbodem/1330716",
      },
      {
        lastmod: "2026-07-27",
        url: "https://werkenbij.rijkswaterstaat.nl/vacatures/adviseur-waterveiligheid/1310882",
      },
      {
        lastmod: "2026-09-07",
        url: "https://werkenbij.rijkswaterstaat.nl/vacatures/jurist-handhaving/1318820",
      },
    ]);
  });

  it("parses the recorded direct-employer JobPosting fields", async () => {
    const url =
      "https://werkenbij.rijkswaterstaat.nl/vacatures/adviseur-assetmanagement-rivierbodem/1330716";
    const detail = await client.fetchDetail(url);
    expect(detail.jobPosting).toMatchObject({
      baseSalary: {
        currency: "EUR",
        value: { maxValue: 6275, minValue: 4132, unitText: "MONTH" },
      },
      datePosted: "2026-09-10T11:45:23Z",
      hiringOrganization: { name: "DG Rijkswaterstaat" },
      jobLocation: [{ address: { addressLocality: "Roermond" } }],
      title: "Adviseur assetmanagement rivierbodem",
    });
  });

  it("folds each .contact-person block (name, function in parens, tel + mailto) into contactpersonen (CTP-610)", async () => {
    const url =
      "https://werkenbij.rijkswaterstaat.nl/vacatures/adviseur-assetmanagement-rivierbodem/1330716";
    const detail = await client.fetchDetail(url);
    expect(detail.contactpersonen).toEqual([
      {
        email: "redacted@example.invalid",
        naam: "A. de Vries",
        rol: null,
        telefoon: "+31000000000",
      },
      {
        email: "redacted@example.invalid",
        naam: "B. Jansen",
        rol: "Expert Vastgoed en Infrastructuur",
        telefoon: "+31000000000",
      },
    ]);
  });

  it("keeps a contact-person block that publishes only a channel (CTP-610)", () => {
    // A block whose name span is absent but that still links a phone number
    // is a reachable contact — the merge must not require `naam`.
    const synthesis = synthesizeContactsFromRijkswaterstaatPage(
      `<div class="contact-person"><div class="contact-person__body">` +
        `<div class="contact-person__body__text">` +
        `<a href="tel:+31000000000">+31 00 000 00 00</a>` +
        `<a href="mailto:redacted@example.invalid">mail</a>` +
        `</div></div></div>`
    );
    expect(synthesis?.contactpersonen).toEqual([
      {
        email: "redacted@example.invalid",
        naam: null,
        rol: null,
        telefoon: "+31000000000",
      },
    ]);
  });
});
