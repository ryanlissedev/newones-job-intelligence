import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";

import { loadConnectorFixture } from "@ji/connectors";
import {
  buildProunityRawHtml,
  parseProunityDetail,
} from "@ji/connectors/prounity";
import type { ProunityFetchedPayload } from "@ji/connectors/prounity";
import { UNKNOWN } from "@ji/domain";

import { normaliseProunityObservation, parseProunityPayload } from "./prounity";

const UUID_FRONTEND = "2d7d21bd-840e-46e9-b43c-1e00dee5140e";
const UUID_HISTORICAL = "3469b088-d2f6-45cb-81cd-1b98c9558417";

/** Built from the real captures in fixtures/connectors/prounity/
 * (recorded 2026-09-18). */
const buildPayload = (
  overrides: Partial<ProunityFetchedPayload["detail"]> = {}
): ProunityFetchedPayload => ({
  detail: {
    applyUrl:
      "https://platform.pro-unity.com/Login/JobPosts/2d7d21bd-840e-46e9-b43c-1e00dee5140e/frontend-web-developer-k10127",
    duur: "2 months",
    land: "Belgium",
    periode: "12/10/2026 - 31/12/2026",
    referentie: "K10127",
    roles: [{ naam: "Application Developer", status: "Confirmed" }],
    skills: [
      { naam: "GIT", status: "Confirmed" },
      { naam: "Angular", status: "Confirmed" },
    ],
    talen: [
      { naam: "English", status: "Active knowledge" },
      { naam: "Dutch", status: "Active knowledge" },
    ],
    titel: "Frontend Web Developer (K10127)",
    uuid: UUID_FRONTEND,
    ...overrides,
  },
  listing: {
    lastmod: "2026-09-17T12:24:01+00:00",
    url: `https://www.pro-unity.com/job/${UUID_FRONTEND}/`,
    uuid: UUID_FRONTEND,
  },
  raw: {
    html: "<p><strong>Frontend Web Developer</strong> Police Fédérale</p>",
  },
});

/** A moment inside the fixture's capture window (recorded 2026-09-18, work
 * window 12/10/2026 - 31/12/2026). */
const PROUNITY_FIXTURE_NOW = new Date("2026-09-20T12:00:00.000Z");

describe("parseProunityPayload", () => {
  // Pin the clock to the capture window so the fixture's 2026-12-31 work
  // window stays in the future; the closed cases use 2023 dates.
  beforeEach(() => {
    setSystemTime(PROUNITY_FIXTURE_NOW);
  });
  afterEach(() => {
    setSystemTime();
  });

  it("maps a real open mission to a normalised draft", () => {
    const draft = parseProunityPayload(buildPayload(), "hash-1");

    expect(draft.titel.value).toBe("Frontend Web Developer (K10127)");
    expect(draft.bronReferentie.value).toBe(UUID_FRONTEND);
    expect(draft.bronUrl.value).toBe(
      `https://www.pro-unity.com/job/${UUID_FRONTEND}/`
    );
    expect(draft.beschrijving.value).toContain("Police Fédérale");
    expect(draft.locatieLand.value).toBe("BE");
    expect(draft.locatieTekst.value).toBe("Belgium");
    expect(draft.startDatum.value).toBe("2026-10-12");

    // Genuinely absent at this source (docs/sources/prounity.md) — never
    // inferred from prose: no rate and no client name are rendered anywhere.
    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.tarief.max).toBe(UNKNOWN);
    expect(draft.tarief.eenheid).toBe(UNKNOWN);
    expect(draft.opdrachtgeverNaam.value).toBe(UNKNOWN);
    expect(draft.opdrachtgeverNaam.provenance.sourcePath).toBe(
      "n/a (not published by source)"
    );

    expect(draft.bronSpecifiek.value).toMatchObject({
      duur: "2 months",
      eind_datum: "2026-12-31",
      land: "Belgium",
      periode: "12/10/2026 - 31/12/2026",
      referentie: "K10127",
      rollen: ["Application Developer"],
      skills: ["GIT", "Angular"],
      sollicitatie_url:
        "https://platform.pro-unity.com/Login/JobPosts/2d7d21bd-840e-46e9-b43c-1e00dee5140e/frontend-web-developer-k10127",
      talen: [
        { naam: "English", status: "Active knowledge" },
        { naam: "Dutch", status: "Active knowledge" },
      ],
    });

    // Work window ends 2026-12-31 (in the future) → the mission stays open.
    expect(draft.sluitingsdatum).toBeInstanceOf(Date);
    expect(draft.status).toBe("active");
  });

  it("marks a mission whose work window already ended as closed", () => {
    const draft = parseProunityPayload(
      buildPayload({ periode: "01/12/2023 - 31/12/2023" }),
      "hash-2"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      eind_datum: "2023-12-31",
    });
    expect(draft.startDatum.value).toBe("2023-12-01");
    expect(draft.status).toBe("closed");
    expect(draft.lifecycle).toBe("closed");
  });

  it("keeps start/sluiting honest when the infobar carries no period", () => {
    const draft = parseProunityPayload(
      buildPayload({ periode: undefined }),
      "hash-3"
    );
    expect(draft.startDatum.value).toBe(UNKNOWN);
    expect(draft.sluitingsdatum).toBeUndefined();
    expect(draft.status).toBe("active");
  });

  it("falls back beschrijving to the titel when richtext is empty", () => {
    const payload = buildPayload();
    payload.raw.html = "";
    const draft = parseProunityPayload(payload, "hash-4");
    expect(draft.beschrijving.value).toBe("Frontend Web Developer (K10127)");
  });

  it("normalises a full real-fixture chain (sitemap row → detail parse → draft)", async () => {
    const fixture = await loadConnectorFixture<string>(
      `prounity/detail-${UUID_FRONTEND}.json`
    );
    const detail = await parseProunityDetail(fixture.payload, UUID_FRONTEND);
    const payload: ProunityFetchedPayload = {
      detail,
      listing: {
        lastmod: "2026-09-17T12:24:01+00:00",
        url: `https://www.pro-unity.com/job/${UUID_FRONTEND}/`,
        uuid: UUID_FRONTEND,
      },
      raw: { html: buildProunityRawHtml(fixture.payload) },
    };
    const draft = parseProunityPayload(payload, "hash-5");
    expect(draft.titel.value).toBe("Frontend Web Developer (K10127)");
    expect(draft.beschrijving.value).toContain("Police Judiciaire Fédérale");
    expect(draft.status).toBe("active");
    expect(draft.bronSpecifiek.value).toMatchObject({
      duur: "2 months",
      eind_datum: "2026-12-31",
      referentie: "K10127",
    });
  });

  it("normalises the historical 2023 fixture chain to closed", async () => {
    const fixture = await loadConnectorFixture<string>(
      `prounity/detail-${UUID_HISTORICAL}.json`
    );
    const detail = await parseProunityDetail(fixture.payload, UUID_HISTORICAL);
    const draft = parseProunityPayload(
      {
        detail,
        listing: {
          url: `https://www.pro-unity.com/job/${UUID_HISTORICAL}/`,
          uuid: UUID_HISTORICAL,
        },
        raw: { html: buildProunityRawHtml(fixture.payload) },
      },
      "hash-6"
    );
    expect(draft.titel.value).toBe("Chef de projet (clé 203) (K07518)");
    expect(draft.bronSpecifiek.value).toMatchObject({
      duur: null,
      eind_datum: "2023-12-31",
    });
    expect(draft.status).toBe("closed");
  });

  it("decodes a stored observation body", () => {
    const body = new TextEncoder().encode(JSON.stringify(buildPayload()));
    const draft = normaliseProunityObservation(body, "hash-7");
    expect(draft.titel.value).toBe("Frontend Web Developer (K10127)");
    expect(draft.parserVersion).toBe("prounity/v1");
  });
});
