import { describe, expect, it } from "bun:test";

import { buildDedupKey } from "@ji/application/normalise";
import type { OpdrachtoverheidFetchedPayload } from "@ji/connectors/opdrachtoverheid";
import type { TenderNedFetchedPayload } from "@ji/connectors/tenderned";
import { UNKNOWN } from "@ji/domain";

import { parseOpdrachtoverheidPayload } from "./opdrachtoverheid";
import { parseTenderNedPayload } from "./tenderned";

const buildTenderNedPayload = (
  publicatieDatum?: string
): TenderNedFetchedPayload => ({
  detail: {
    aanbestedingNaam: "Platform engineer Azure DAS",
    aankondigingCode: { code: "AAO" },
    kenmerk: "TN-432",
    numberOfDaysBeforeAanmeldenInschrijven: 14,
    opdrachtBeschrijving: "Volledige detailbeschrijving.",
    opdrachtgeverNaam: "Gemeente Amsterdam",
    publicatieDatum,
    publicatieId: "PUB-432",
  },
  listing: {
    aanbestedingNaam: "Platform engineer Azure DAS",
    aankondigingCode: { code: "AAO" },
    kenmerk: "TN-432",
    numberOfDaysBeforeAanmeldenInschrijven: 14,
    opdrachtBeschrijving: "Volledige detailbeschrijving.",
    opdrachtgeverNaam: "Gemeente Amsterdam",
    publicatieDatum,
    publicatieId: "PUB-432",
  },
  publicatieId: "PUB-432",
});

const buildOpdrachtoverheidPayload = (
  overrides: Partial<OpdrachtoverheidFetchedPayload["tender"]> = {}
): OpdrachtoverheidFetchedPayload => ({
  jobPosting: null,
  tender: {
    opdracht_overheid_url:
      "https://www.opdrachtoverheid.nl/inhuuropdracht/gemeente/platform-engineer/432",
    tender_buying_organization: "Gemeente Amsterdam",
    tender_first_seen: "2026-08-20T09:15:00Z",
    tender_id: "bron-432",
    tender_name: "Platform engineer Azure DAS",
    web_key: "432",
    ...overrides,
  },
});

const dedupKeyFor = (
  draft: ReturnType<
    typeof parseTenderNedPayload | typeof parseOpdrachtoverheidPayload
  >
): string =>
  buildDedupKey({
    opdrachtgeverNaam: draft.opdrachtgeverNaam.value,
    startDatum: draft.startDatum.value,
    titel: draft.titel.value,
  });

describe("contract-start provenance (RJC-432)", () => {
  it("keeps TenderNed publication date as metadata and contract start UNKNOWN", () => {
    const draft = parseTenderNedPayload(
      buildTenderNedPayload("2026-08-28T12:15:00+02:00"),
      "hash-tenderned"
    );

    expect(draft.parserVersion).toBe("tenderned/v3");
    expect(draft.startDatum.value).toBe(UNKNOWN);
    expect(draft.startDatum.provenance.sourcePath).toBe(
      "n/a (not published by source)"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      publicatiedatum: "2026-08-28T12:15:00+02:00",
    });
  });

  it("does not let TenderNed publication changes split dedup identity", () => {
    const first = parseTenderNedPayload(
      buildTenderNedPayload("2026-08-28T12:15:00+02:00"),
      "hash-first"
    );
    const rectification = parseTenderNedPayload(
      buildTenderNedPayload("2026-08-29T12:15:00+02:00"),
      "hash-rectification"
    );

    expect(dedupKeyFor(first)).toBe(dedupKeyFor(rectification));
    expect(dedupKeyFor(first)).toEndWith(`\u001F${UNKNOWN}`);
  });

  it("keeps contract start UNKNOWN when TenderNed publication date is missing", () => {
    const draft = parseTenderNedPayload(
      buildTenderNedPayload(),
      "hash-no-publication"
    );

    expect(draft.startDatum.value).toBe(UNKNOWN);
    expect(draft.startDatum.provenance.sourcePath).toBe(
      "n/a (not published by source)"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      publicatiedatum: null,
    });
  });

  it("uses only a real Opdrachtoverheid contract start with exact provenance", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_start_date: "2026-09-15T00:00:00Z",
      }),
      "hash-actual-start"
    );

    expect(draft.parserVersion).toBe("opdrachtoverheid/v3");
    expect(draft.startDatum.value).toBe("2026-09-15");
    expect(draft.startDatum.provenance.sourcePath).toBe(
      "tender.tender_start_date"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      tender_first_seen: "2026-08-20T09:15:00Z",
    });
  });

  it.each([undefined, null, "", "   "])(
    "keeps missing or empty Opdrachtoverheid start %p UNKNOWN",
    (tenderStartDate) => {
      const draft = parseOpdrachtoverheidPayload(
        buildOpdrachtoverheidPayload({
          tender_first_seen: "2026-08-20T09:15:00Z",
          tender_start_date: tenderStartDate,
        }),
        "hash-no-actual-start"
      );

      expect(draft.startDatum.value).toBe(UNKNOWN);
      expect(draft.startDatum.provenance.sourcePath).toBe(
        "tender.tender_start_date"
      );
    }
  );

  it("does not let Opdrachtoverheid first-seen changes split dedup identity", () => {
    const first = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_first_seen: "2026-08-20T09:15:00Z",
        tender_start_date: undefined,
      }),
      "hash-first-seen-a"
    );
    const laterObservation = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_first_seen: "2026-08-22T09:15:00Z",
        tender_start_date: undefined,
      }),
      "hash-first-seen-b"
    );

    expect(dedupKeyFor(first)).toBe(dedupKeyFor(laterObservation));
    expect(dedupKeyFor(first)).toEndWith(`\u001F${UNKNOWN}`);
  });

  it("keeps distinct real contract starts distinct in dedup identity", () => {
    const september = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_start_date: "2026-09-15",
      }),
      "hash-september"
    );
    const october = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_start_date: "2026-10-15",
      }),
      "hash-october"
    );

    expect(dedupKeyFor(september)).not.toBe(dedupKeyFor(october));
    expect(dedupKeyFor(september)).toEndWith("\u001F2026-09-15");
    expect(dedupKeyFor(october)).toEndWith("\u001F2026-10-15");
  });
});
