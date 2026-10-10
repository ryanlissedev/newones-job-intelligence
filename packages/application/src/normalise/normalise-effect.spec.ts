import { describe, expect, it } from "bun:test";

import { hashContent } from "@ji/connectors";
import type { InhuurdeskFetchedPayload } from "@ji/connectors/inhuurdesk";
import type { JsonLdFetchedPayload } from "@ji/connectors/json-ld";
import type { TenderNedFetchedPayload } from "@ji/connectors/tenderned";

import { UseCaseValidationFault } from "../effect";
import { normaliseInhuurdeskObservation } from "./inhuurdesk";
import { normaliseJsonLdObservation } from "./json-ld";
import {
  runNormaliseInhuurdeskObservation,
  runNormaliseJsonLdObservation,
  runNormaliseTenderNedObservation,
} from "./normalise-effect";
import { normaliseTenderNedObservation } from "./tenderned";

const encoder = new TextEncoder();

const tenderNedBody = (): Uint8Array => {
  const rawDetail = [
    '{"aanbestedingNaam":"Platform engineer Azure DAS"',
    '"aankondigingCode":{"code":"AAO"}',
    '"kenmerk":"k-1"',
    '"numberOfDaysBeforeAanmeldenInschrijven":14',
    '"opdrachtBeschrijving":"Volledige detailbeschrijving."',
    '"opdrachtgeverNaam":"Gemeente Amsterdam"',
    '"publicatieDatum":"2026-08-28T12:15:00+02:00"',
    '"publicatieId":"pub-001"}',
  ].join(",");
  // SAFETY: fixture JSON is hand-authored TenderNed detail shape for dual-path parity.
  const detail = JSON.parse(rawDetail) as TenderNedFetchedPayload["detail"];
  const payload: TenderNedFetchedPayload = {
    detail,
    listing: detail,
    publicatieId: "pub-001",
  };
  return encoder.encode(JSON.stringify(payload));
};

const inhuurdeskBody = (): Uint8Array => {
  const payload: InhuurdeskFetchedPayload = {
    assignment: {
      clientName: "Alliander",
      content: "<p>Rolomschrijving</p>",
      id: "ih-effect-001",
      location: "Duiven",
      startDate: "2026-09-01T00:00:00",
      title: "Senior Java Developer",
    },
  };
  return encoder.encode(JSON.stringify(payload));
};

const jsonLdBody = (): Uint8Array => {
  const payload: JsonLdFetchedPayload = {
    jobPosting: {
      "@type": "JobPosting",
      datePosted: "2026-08-24",
      description: "Testscenarios opstellen.",
      hiringOrganization: { "@type": "Organization", name: "Kadaster" },
      identifier: { "@type": "PropertyValue", value: "a0jMI00000Pn1z3YAB" },
      jobLocation: {
        "@type": "Place",
        address: { "@type": "PostalAddress", addressLocality: "Apeldoorn" },
      },
      title: "CIAM Tester",
    },
    labelBlock: {
      eindDatum: "31 december 2026",
      locatie: "Apeldoorn",
      referentienummer: "2026-08243",
      sluitingsDatum: "2 september 2026",
      startDatum: "1 september 2026",
      urenPerWeek: "32u p/w",
    },
    parserVersion: "bluetrail/v2",
    slug: "bluetrail",
    url: "https://www.bluetrail.nl/opdrachten/Interim/ciam-tester/",
  };
  return encoder.encode(JSON.stringify(payload));
};

describe("normalise Effect dual-path", () => {
  it("matches native TenderNed normalisation", async () => {
    const body = tenderNedBody();
    const hash = await hashContent(body);
    expect(await runNormaliseTenderNedObservation(body, hash)).toEqual(
      normaliseTenderNedObservation(body, hash)
    );
  });

  it("matches native Inhuurdesk normalisation", async () => {
    const body = inhuurdeskBody();
    const hash = await hashContent(body);
    expect(await runNormaliseInhuurdeskObservation(body, hash)).toEqual(
      normaliseInhuurdeskObservation(body, hash)
    );
  });

  it("matches native JSON-LD normalisation", async () => {
    const body = jsonLdBody();
    const hash = await hashContent(body);
    expect(await runNormaliseJsonLdObservation(body, hash)).toEqual(
      normaliseJsonLdObservation(body, hash)
    );
  });

  it("maps invalid TenderNed body to UseCaseValidationFault", async () => {
    await expect(
      runNormaliseTenderNedObservation(encoder.encode("not-json"), "hash")
    ).rejects.toBeInstanceOf(UseCaseValidationFault);
  });
});
