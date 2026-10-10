import { describe, expect, it } from "bun:test";

import type { BronId, ScrapeRunId } from "@ji/domain";
import { CLEARED, CLEARED_BRON_MARKER_KEY, UNKNOWN } from "@ji/domain";

import type { NormalisedAanvraagDraft } from "../normalise";
import type { CurateStore } from "./curate";
import { curateObservation } from "./curate";
import { InMemoryCurateStore } from "./store";

const BRON: BronId = "bron-hero";
const RUN: ScrapeRunId = "run-1";
const OBSERVED_AT = new Date("2026-09-01T06:00:00.000Z");
const provenance = { parserVersion: "spec", sourcePath: "n/a" };

const draft = (
  bronReferentie: string,
  contentHash: string
): NormalisedAanvraagDraft => ({
  beschrijving: { provenance, value: `beschrijving ${bronReferentie}` },
  bronReferentie: { provenance, value: bronReferentie },
  bronSpecifiek: { provenance, value: {} },
  bronUrl: { provenance, value: UNKNOWN },
  contentHash,
  extractieMethode: "html_parser",
  lifecycle: "active",
  locatieLand: { provenance, value: "NL" },
  locatieTekst: { provenance, value: UNKNOWN },
  opdrachtgeverNaam: { provenance, value: UNKNOWN },
  parserVersion: "spec",
  startDatum: { provenance, value: UNKNOWN },
  status: "active",
  tarief: { eenheid: UNKNOWN, max: UNKNOWN, min: UNKNOWN, valuta: "EUR" },
  titel: { provenance, value: `titel ${bronReferentie}` },
});

const observation = (bronReferentie: string, contentHash: string) => ({
  bronId: BRON,
  draft: draft(bronReferentie, contentHash),
  observedAt: OBSERVED_AT,
  rawPayloadRef: `raw/hero/${bronReferentie}.html`,
  scrapeRunId: RUN,
});

/**
 * Injects the failure through the port: every method delegates to the real
 * store except insertOutboxEvent, and the transactional store handed to the
 * callback is wrapped the same way — the shape a flaky outbox insert has in
 * production.
 */
const withFailingOutbox = (base: CurateStore): CurateStore => ({
  closeOpenVersie: (aanvraagId, closedAt) =>
    base.closeOpenVersie(aanvraagId, closedAt),
  ensureDedupGroep: (input) => base.ensureDedupGroep(input),
  findAanvraagByIdentity: (bronId, bronReferentie) =>
    base.findAanvraagByIdentity(bronId, bronReferentie),
  findDedupGroepByKey: (dedupKey) => base.findDedupGroepByKey(dedupKey),
  insertAanvraag: (input) => base.insertAanvraag(input),
  insertOutboxEvent: () =>
    Promise.reject(new Error("forced outbox insert failure")),
  insertVersie: (input) => base.insertVersie(input),
  linkAanvraagToDedupGroep: (aanvraagId, dedupGroepId) =>
    base.linkAanvraagToDedupGroep(aanvraagId, dedupGroepId),
  splitDedupGroep: (dedupGroepId) => base.splitDedupGroep(dedupGroepId),
  updateAanvraag: (aanvraagId, patch) => base.updateAanvraag(aanvraagId, patch),
  withTransaction: (fn) =>
    base.withTransaction((tx) => fn(withFailingOutbox(tx))),
});

describe("curateObservation transaction semantics (RJC-399)", () => {
  it("writes aanvraag, versie and outbox event together on success", async () => {
    const store = new InMemoryCurateStore();
    const result = await curateObservation(store, observation("A", "hash-1"));
    expect(result.status).toBe("curated");
    expect(store.aanvragen).toHaveLength(1);
    expect(store.versies).toHaveLength(1);
    expect(store.outboxEvents).toHaveLength(1);
  });

  it("rolls back the create path entirely when the outbox insert fails", async () => {
    const store = new InMemoryCurateStore();
    await expect(
      curateObservation(withFailingOutbox(store), observation("A", "hash-1"))
    ).rejects.toThrow("forced outbox insert failure");
    expect(store.aanvragen).toHaveLength(0);
    expect(store.dedupGroepen).toHaveLength(0);
    expect(store.versies).toHaveLength(0);
    expect(store.outboxEvents).toHaveLength(0);
  });

  it("rolls back the update path entirely when the outbox insert fails", async () => {
    const store = new InMemoryCurateStore();
    await curateObservation(store, observation("A", "hash-1"));

    await expect(
      curateObservation(withFailingOutbox(store), observation("A", "hash-2"))
    ).rejects.toThrow("forced outbox insert failure");

    const [aanvraag] = store.aanvragen;
    expect(aanvraag).toMatchObject({ contentHash: "hash-1", versie: 1 });
    // The versie write before the failure is gone with the rest.
    expect(store.versies).toHaveLength(1);
    expect(store.versies[0]).toMatchObject({ geldigTot: null, versie: 1 });
    expect(store.outboxEvents).toHaveLength(1);
  });
});

describe("curateObservation dedup grouping", () => {
  const sharedTitle = (bronReferentie: string, contentHash: string) => {
    const base = observation(bronReferentie, contentHash);
    return {
      ...base,
      draft: {
        ...base.draft,
        opdrachtgeverNaam: { provenance, value: "Gemeente Amsterdam" },
        startDatum: { provenance, value: "2026-10-01" },
        titel: { provenance, value: "Senior Java Developer" },
      },
    };
  };

  it("links two listings with the same dedup key to one group", async () => {
    const store = new InMemoryCurateStore();
    const first = await curateObservation(store, sharedTitle("A", "hash-a"));
    const second = await curateObservation(store, sharedTitle("B", "hash-b"));

    const groepId = first.dedupGroepId ?? null;
    expect(groepId).not.toBeNull();
    expect(second.dedupGroepId).toBe(groepId ?? undefined);
    expect(store.dedupGroepen).toHaveLength(1);
    expect(store.aanvragen.map((row) => row.dedupGroepId)).toEqual([
      groepId,
      groepId,
    ]);
  });

  it("gives listings with different keys their own groups", async () => {
    const store = new InMemoryCurateStore();
    const first = await curateObservation(store, observation("A", "hash-a"));
    const second = await curateObservation(store, observation("B", "hash-b"));

    expect(second.dedupGroepId).not.toBe(first.dedupGroepId);
    expect(store.dedupGroepen).toHaveLength(2);
  });
});

describe("curateObservation commercial columns and coalesce tombstones", () => {
  it("writes first-class commercial columns on create", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("COL-1", "hash-col-1");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        opdrachtgeverNaam: { provenance, value: "Gemeente Utrecht" },
        startDatum: { provenance, value: "2026-11-01" },
        titel: { provenance, value: "Detachering Java developer op locatie" },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag?.opdrachtgeverNaam).toBe("Gemeente Utrecht");
    expect(aanvraag?.startDatum).toBe("2026-11-01");
    expect(aanvraag?.contracttype).toBeTruthy();
  });

  it("stores only publication dates the UI can format", async () => {
    const store = new InMemoryCurateStore();
    const valid = observation("COL-DATE-VALID", "hash-date-valid");
    const invalid = observation("COL-DATE-INVALID", "hash-date-invalid");

    await curateObservation(store, {
      ...valid,
      draft: {
        ...valid.draft,
        bronSpecifiek: {
          provenance,
          value: { publicatiedatum: "2026-09-20T08:30:00+02:00" },
        },
      },
    });
    await curateObservation(store, {
      ...invalid,
      draft: {
        ...invalid.draft,
        bronSpecifiek: {
          provenance,
          value: { publicatiedatum: "20 september 2026" },
        },
      },
    });

    expect(store.aanvragen.map((aanvraag) => aanvraag.publicatiedatum)).toEqual(
      ["2026-09-20T08:30:00+02:00", null]
    );
  });

  it("canonicalizes a raw 'temporary' contract_type token to interim (CTP-514/CTP-526)", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("COL-CONTRACT-1", "hash-contract-1");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: { provenance, value: { contract_type: "temporary" } },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag?.contracttype).toBe("interim");
    // SAFETY: test fixture set bronSpecifiek.value to a literal with contract_type above
    const bronSpecifiek = aanvraag?.bronSpecifiek as { contract_type?: string };
    expect(bronSpecifiek.contract_type).toBe("temporary");
  });

  it("canonicalizes a raw 'CONTRACTOR' contract_type token to freelance (CTP-514/CTP-526)", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("COL-CONTRACT-2", "hash-contract-2");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: { provenance, value: { contract_type: "CONTRACTOR" } },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag?.contracttype).toBe("freelance");
    // SAFETY: test fixture set bronSpecifiek.value to a literal with contract_type above
    const bronSpecifiek = aanvraag?.bronSpecifiek as { contract_type?: string };
    expect(bronSpecifiek.contract_type).toBe("CONTRACTOR");
  });

  it("canonicalizes a raw 'CONTRACTOR' employment_type alias (JSON-LD old rows) to freelance (CTP-514)", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("COL-CONTRACT-EMP", "hash-contract-emp");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: { provenance, value: { employment_type: "CONTRACTOR" } },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag?.contracttype).toBe("freelance");
  });

  it("canonicalizes a comma-separated employment_type list", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("COL-CONTRACT-EMP-LIST", "hash-contract-emp-list");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: {
          provenance,
          value: { employment_type: "TEMPORARY, FULL_TIME" },
        },
      },
    });
    expect(store.aanvragen[0]?.contracttype).toBe("interim");
  });

  it("uses first-live contract alias precedence", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("COL-CONTRACT-PRECEDENCE", "hash-precedence");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: {
          provenance,
          value: { contract_type: "CONTRACTOR", contracttype: "FULL_TIME" },
        },
      },
    });
    expect(store.aanvragen[0]?.contracttype).toBeNull();
  });

  it("backfills contracttype from employment_type on a later observation", async () => {
    const store = new InMemoryCurateStore();
    const initial = observation("COL-CONTRACT-BACKFILL", "hash-initial");
    await curateObservation(store, initial);
    const updated = observation("COL-CONTRACT-BACKFILL", "hash-updated");
    await curateObservation(store, {
      ...updated,
      draft: {
        ...updated.draft,
        bronSpecifiek: { provenance, value: { employment_type: "CONTRACTOR" } },
      },
    });
    expect(store.aanvragen[0]?.contracttype).toBe("freelance");
  });

  it("backfills contracttype from employment_type when content is unchanged", async () => {
    const store = new InMemoryCurateStore();
    const initial = observation("COL-CONTRACT-SAME-HASH", "hash-same");
    await curateObservation(store, initial);
    await curateObservation(store, {
      ...initial,
      draft: {
        ...initial.draft,
        bronSpecifiek: { provenance, value: { employment_type: "CONTRACTOR" } },
      },
    });
    expect(store.aanvragen[0]?.contracttype).toBe("freelance");
  });

  it("leaves the column null for an hours/employment token like 'FULL_TIME' that isn't a contract form (CTP-514/CTP-526)", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("COL-CONTRACT-3", "hash-contract-3");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: { provenance, value: { contract_type: "FULL_TIME" } },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag?.contracttype).toBeNull();
    // SAFETY: test fixture set bronSpecifiek.value to a literal with contract_type above
    const bronSpecifiek = aanvraag?.bronSpecifiek as { contract_type?: string };
    expect(bronSpecifiek.contract_type).toBe("FULL_TIME");
  });

  it("falls back to prose classification when employment_type only describes hours", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("COL-CONTRACT-HOURS", "hash-contract-hours");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: { provenance, value: { employment_type: "FULL_TIME" } },
        titel: { provenance, value: "Freelance Java developer" },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag?.contracttype).toBe("freelance");
    expect(aanvraag?.bronSpecifiek).toMatchObject({
      contracttype: "freelance",
      employment_type: "FULL_TIME",
    });
  });

  it("does not replace conflicting explicit employment contract forms with prose classification", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("COL-CONTRACT-CONFLICT", "hash-contract-conflict");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: {
          provenance,
          value: { employment_type: "TEMPORARY, CONTRACTOR" },
        },
        titel: { provenance, value: "Freelance Java developer" },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag?.contracttype).toBeNull();
    expect(aanvraag?.bronSpecifiek).not.toHaveProperty("contracttype");
  });

  it("preserves commercial fields when a sparse re-scrape sends UNKNOWN", async () => {
    const store = new InMemoryCurateStore();
    const rich = observation("COL-2", "hash-rich");
    await curateObservation(store, {
      ...rich,
      draft: {
        ...rich.draft,
        bronUrl: { provenance, value: "https://example.com/rich" },
        locatieTekst: { provenance, value: "Utrecht" },
        opdrachtgeverNaam: { provenance, value: "Provincie Utrecht" },
        startDatum: { provenance, value: "2026-12-01" },
        tarief: { eenheid: "uur", max: "110", min: "90", valuta: "EUR" },
      },
    });
    const sparse = observation("COL-2", "hash-sparse");
    await curateObservation(store, sparse);
    const [aanvraag] = store.aanvragen;
    expect(aanvraag).toMatchObject({
      bronUrl: "https://example.com/rich",
      contentHash: "hash-sparse",
      locatieTekst: "Utrecht",
      opdrachtgeverNaam: "Provincie Utrecht",
      startDatum: "2026-12-01",
      tariefMax: "110",
      tariefMin: "90",
      versie: 2,
    });
  });

  it("clears commercial fields when the draft sends CLEARED", async () => {
    const store = new InMemoryCurateStore();
    const rich = observation("COL-3", "hash-rich-clear");
    await curateObservation(store, {
      ...rich,
      draft: {
        ...rich.draft,
        bronUrl: { provenance, value: "https://example.com/clear-me" },
        opdrachtgeverNaam: { provenance, value: "Gemeente Tilburg" },
        startDatum: { provenance, value: "2027-01-15" },
        tarief: { eenheid: "uur", max: "120", min: "100", valuta: "EUR" },
      },
    });
    const cleared = observation("COL-3", "hash-cleared");
    await curateObservation(store, {
      ...cleared,
      draft: {
        ...cleared.draft,
        bronUrl: { provenance, value: CLEARED },
        opdrachtgeverNaam: { provenance, value: CLEARED },
        startDatum: { provenance, value: CLEARED },
        tarief: {
          eenheid: CLEARED,
          max: CLEARED,
          min: CLEARED,
          valuta: "EUR",
        },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag).toMatchObject({
      bronUrl: null,
      contentHash: "hash-cleared",
      opdrachtgeverNaam: null,
      startDatum: null,
      tariefEenheid: null,
      tariefMax: null,
      tariefMin: null,
      versie: 2,
    });
    // CLEARED must drop prior commercial keys from bron_specifiek so the
    // column ?? JSON read path cannot resurrect them. Marker key *names*
    // may still appear under `_cleared` — assert top-level absence.
    expect(aanvraag?.bronSpecifiek).not.toHaveProperty("opdrachtgever_naam");
    expect(aanvraag?.bronSpecifiek).not.toHaveProperty("opdrachtgeverNaam");
    expect(aanvraag?.bronSpecifiek).not.toHaveProperty("start_datum");
    expect(aanvraag?.bronSpecifiek).not.toHaveProperty("startDatum");
    expect(aanvraag?.bronSpecifiek).not.toHaveProperty("tarief_min");
    // Sentinel string itself must never persist as a commercial value.
    expect(JSON.stringify(aanvraag?.bronSpecifiek ?? {})).not.toContain(
      `"${CLEARED}"`
    );
    // Durable markers survive strip so enrichment cannot resurrect gaps.
    expect(aanvraag?.bronSpecifiek).toMatchObject({
      [CLEARED_BRON_MARKER_KEY]: {
        opdrachtgeverNaam: true,
        opdrachtgever_naam: true,
        startDatum: true,
        start_datum: true,
        tarief: true,
        tariefEenheid: true,
        tariefMax: true,
        tariefMin: true,
        tarief_eenheid: true,
        tarief_max: true,
        tarief_min: true,
      },
    });
  });

  it("records durable CLEARED markers for locatie after strip", async () => {
    const store = new InMemoryCurateStore();
    const rich = observation("COL-4", "hash-rich-loc");
    await curateObservation(store, {
      ...rich,
      draft: {
        ...rich.draft,
        locatieTekst: { provenance, value: "Utrecht" },
      },
    });
    const cleared = observation("COL-4", "hash-cleared-loc");
    await curateObservation(store, {
      ...cleared,
      draft: {
        ...cleared.draft,
        locatieTekst: { provenance, value: CLEARED },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag).toMatchObject({
      locatieTekst: null,
      versie: 2,
    });
    expect(aanvraag?.bronSpecifiek).not.toHaveProperty("locatie_tekst");
    expect(JSON.stringify(aanvraag?.bronSpecifiek ?? {})).not.toContain(
      `"${CLEARED}"`
    );
    expect(aanvraag?.bronSpecifiek).toMatchObject({
      [CLEARED_BRON_MARKER_KEY]: {
        locatie: true,
        locatieTekst: true,
        locatie_tekst: true,
      },
    });
  });

  it("lifts durable CLEARED markers when a later draft sets a real value", async () => {
    const store = new InMemoryCurateStore();
    const cleared = observation("COL-5", "hash-clear-then-set");
    await curateObservation(store, {
      ...cleared,
      draft: {
        ...cleared.draft,
        locatieTekst: { provenance, value: CLEARED },
      },
    });
    const restored = observation("COL-5", "hash-restored-loc");
    await curateObservation(store, {
      ...restored,
      draft: {
        ...restored.draft,
        locatieTekst: { provenance, value: "Rotterdam" },
      },
    });
    const [aanvraag] = store.aanvragen;
    expect(aanvraag).toMatchObject({
      locatieTekst: "Rotterdam",
      versie: 2,
    });
    expect(aanvraag?.bronSpecifiek).not.toMatchObject({
      [CLEARED_BRON_MARKER_KEY]: {
        locatie: true,
      },
    });
    expect(aanvraag?.bronSpecifiek).not.toMatchObject({
      [CLEARED_BRON_MARKER_KEY]: {
        locatie_tekst: true,
      },
    });
    expect(aanvraag?.bronSpecifiek).not.toMatchObject({
      [CLEARED_BRON_MARKER_KEY]: {
        locatieTekst: true,
      },
    });
  });
});

/**
 * CTP-498: every write on the unchanged-content path moves a field the search
 * document (and so the projection hash) contains, and the projector skips a
 * later same-content event. Each such write therefore has to carry its own
 * outbox event, or the index keeps a closed aanvraag active and a stale
 * last-seen date until the content changes.
 */
describe("curateObservation unchanged content enqueues its own events (CTP-498)", () => {
  const later = new Date("2026-09-02T06:00:00.000Z");

  const seedActive = async (store: InMemoryCurateStore) => {
    await curateObservation(store, observation("SEEN-1", "hash-stable"));
    expect(store.outboxEvents).toHaveLength(1);
    return store;
  };

  it("enqueues a status event and a new versie when the status flips", async () => {
    const store = await seedActive(new InMemoryCurateStore());
    const base = observation("SEEN-1", "hash-stable");

    const result = await curateObservation(store, {
      ...base,
      draft: { ...base.draft, status: "closed" },
      observedAt: later,
    });

    expect(result.status).toBe("unchanged");
    expect(result.outboxEventId).toBeTruthy();
    expect(result.versie).toBe(2);
    expect(store.outboxEvents).toHaveLength(2);
    expect(store.outboxEvents[1]).toMatchObject({
      aggregateType: "aanvraag",
      eventType: "aanvraag.status_gewijzigd",
    });
    // The projector pins the status from the payload, so a row that moved on
    // between the write and the drain is still indexed as closed.
    expect(store.outboxEvents[1]?.payload).toMatchObject({ status: "closed" });
    // status is the one field here that buildSnapshot records, so SCD2 needs
    // a new version whose snapshot agrees with the row.
    expect(store.aanvragen[0]).toMatchObject({ status: "closed", versie: 2 });
    expect(store.versies).toHaveLength(2);
    expect(store.versies[0]?.geldigTot).not.toBeNull();
    expect(store.versies[1]).toMatchObject({ geldigTot: null, versie: 2 });
    expect(store.versies[1]?.snapshot).toMatchObject({ status: "closed" });
  });

  it("overwrites a wrong non-null startDatum on an unchanged observation", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("START-DATUM-1", "hash-stable");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        startDatum: { provenance, value: "2026-10-04" },
      },
    });

    const result = await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        startDatum: { provenance, value: "2026-10-05" },
      },
      observedAt: later,
    });

    expect(result.status).toBe("unchanged");
    expect(result.outboxEventId).toBeTruthy();
    expect(store.aanvragen[0]).toMatchObject({
      startDatum: "2026-10-05",
      versie: 1,
    });
    expect(store.versies).toHaveLength(1);
    expect(store.outboxEvents).toHaveLength(2);
  });

  it('treats curated urenPerWeek "0" as absent and overwrites from draft (CTP-599)', async () => {
    const store = new InMemoryCurateStore();
    const base = observation("UREN-ZERO-1", "hash-uren-stable");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: {
          provenance,
          value: {
            tender_hours_week: "32",
            uren_max: "0",
            uren_min: "0",
            uren_per_week: "0",
          },
        },
      },
    });
    expect(store.aanvragen[0]?.urenPerWeek).toBeNull();

    // Simulate a legacy curated row that still has column "0" (pre-heal).
    const [legacy] = store.aanvragen;
    expect(legacy).toBeDefined();
    if (legacy === undefined) {
      throw new Error("expected curated row");
    }
    store.aanvragen[0] = {
      ...legacy,
      bronSpecifiek: {
        tender_hours_week: "32",
        uren_max: "0",
        uren_min: "0",
        uren_per_week: "0",
      },
      urenPerWeek: "0",
    };

    const result = await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: {
          provenance,
          value: {
            tender_hours_week: "32",
            uren_per_week: "32",
          },
        },
      },
      observedAt: later,
    });

    expect(result.status).toBe("unchanged");
    expect(store.aanvragen[0]).toMatchObject({
      urenPerWeek: "32",
      versie: 1,
    });
  });

  it("keeps present numeric uren_min/uren_max while stripping hours 0 (CTP-599)", async () => {
    const store = new InMemoryCurateStore();
    const base = observation("UREN-NUM-1", "hash-uren-numeric");
    await curateObservation(store, {
      ...base,
      draft: {
        ...base.draft,
        bronSpecifiek: {
          provenance,
          value: {
            uren_max: 36,
            uren_min: 36,
            uren_per_week: "36",
          },
        },
      },
    });

    expect(store.aanvragen[0]).toMatchObject({
      bronSpecifiek: {
        uren_max: 36,
        uren_min: 36,
        uren_per_week: "36",
      },
      urenPerWeek: "36",
    });

    // Numeric 0 is absent and must not persist (parity with string "0").
    const zeroStore = new InMemoryCurateStore();
    await curateObservation(zeroStore, {
      ...observation("UREN-NUM-0", "hash-uren-numeric-zero"),
      draft: {
        ...base.draft,
        bronSpecifiek: {
          provenance,
          value: {
            uren_max: 0,
            uren_min: 0,
            uren_per_week: "0",
          },
        },
      },
    });
    expect(zeroStore.aanvragen[0]?.urenPerWeek).toBeNull();
    expect(zeroStore.aanvragen[0]?.bronSpecifiek).not.toHaveProperty(
      "uren_min"
    );
    expect(zeroStore.aanvragen[0]?.bronSpecifiek).not.toHaveProperty(
      "uren_max"
    );
    expect(zeroStore.aanvragen[0]?.bronSpecifiek).not.toHaveProperty(
      "uren_per_week"
    );
  });

  it("enqueues an upsert event and no new versie when only laatstGezienOp moves", async () => {
    const store = await seedActive(new InMemoryCurateStore());

    const result = await curateObservation(store, {
      ...observation("SEEN-1", "hash-stable"),
      observedAt: later,
    });

    expect(result.status).toBe("unchanged");
    expect(result.outboxEventId).toBeTruthy();
    expect(result.versie).toBeUndefined();
    expect(store.outboxEvents).toHaveLength(2);
    expect(store.outboxEvents[1]).toMatchObject({
      eventType: "aanvraag.gewijzigd",
    });
    expect(store.aanvragen[0]).toMatchObject({
      laatstGezienOp: later,
      versie: 1,
    });
    // laatst_gezien_op is absent from buildSnapshot, so a version row here
    // would duplicate the open one without carrying new information.
    expect(store.versies).toHaveLength(1);
  });

  it("enqueues nothing when the same observation is seen again", async () => {
    const store = await seedActive(new InMemoryCurateStore());

    const result = await curateObservation(
      store,
      observation("SEEN-1", "hash-stable")
    );

    expect(result.status).toBe("unchanged");
    expect(result.outboxEventId).toBeUndefined();
    expect(store.outboxEvents).toHaveLength(1);
    expect(store.versies).toHaveLength(1);
    expect(store.aanvragen[0]).toMatchObject({
      laatstGezienOp: OBSERVED_AT,
      versie: 1,
    });
  });

  it("enqueues nothing and keeps laatstGezienOp when an older observation replays", async () => {
    const store = await seedActive(new InMemoryCurateStore());

    const result = await curateObservation(store, {
      ...observation("SEEN-1", "hash-stable"),
      observedAt: new Date(OBSERVED_AT.getTime() - 60_000),
    });

    expect(result.status).toBe("unchanged");
    expect(result.outboxEventId).toBeUndefined();
    expect(store.outboxEvents).toHaveLength(1);
    expect(store.aanvragen[0]).toMatchObject({
      laatstGezienOp: OBSERVED_AT,
      versie: 1,
    });
  });

  it("rolls the seen write back entirely when the outbox insert fails", async () => {
    const store = await seedActive(new InMemoryCurateStore());

    await expect(
      curateObservation(withFailingOutbox(store), {
        ...observation("SEEN-1", "hash-stable"),
        observedAt: later,
      })
    ).rejects.toThrow("forced outbox insert failure");

    // Without the join, the row would carry a last-seen date the index can
    // never learn about: the next same-content event is skipped by the hash.
    expect(store.aanvragen[0]).toMatchObject({ laatstGezienOp: OBSERVED_AT });
    expect(store.outboxEvents).toHaveLength(1);
  });
});

describe("curateObservation contactpersonen pipeline fields (CTP-610)", () => {
  const sourceContact = {
    email: "redacted@example.invalid",
    geinformeerdOp: null,
    naam: "A. de Vries",
    notificatieKanaal: null,
    rol: "recruiter",
    telefoon: "+31000000000",
  };

  const withContactpersonen = (
    bronReferentie: string,
    contentHash: string,
    contactpersonen: (typeof sourceContact)[]
  ) => {
    const base = observation(bronReferentie, contentHash);
    return {
      ...base,
      draft: {
        ...base.draft,
        contactpersonen: { provenance, value: contactpersonen },
      },
    };
  };

  it("carries geinformeerdOp/notificatieKanaal forward on a re-published contact", async () => {
    const store = new InMemoryCurateStore();
    await curateObservation(
      store,
      withContactpersonen("CP-1", "hash-cp-1", [sourceContact])
    );

    // The disclosure pipeline writes the art. 14 fields on the stored row.
    const [aanvraag] = store.aanvragen;
    const [contact] = aanvraag?.contactpersonen ?? [];
    if (!(aanvraag && contact)) {
      throw new Error("expected one stored contactpersoon");
    }
    store.aanvragen[0] = {
      ...aanvraag,
      contactpersonen: [
        {
          ...contact,
          geinformeerdOp: "2026-09-02T00:00:00.000Z",
          notificatieKanaal: "email",
        },
      ],
    };

    // The source republishes the same contact (null-emitting pipeline fields)
    // plus one newcomer; a third stored contact is dropped upstream.
    const newcomer = {
      ...sourceContact,
      naam: "R. Cruiter",
      telefoon: "+31000000001",
    };
    await curateObservation(
      store,
      withContactpersonen("CP-1", "hash-cp-2", [sourceContact, newcomer])
    );

    const [kept, added] = store.aanvragen[0]?.contactpersonen ?? [];
    expect(kept).toMatchObject({
      geinformeerdOp: "2026-09-02T00:00:00.000Z",
      naam: "A. de Vries",
      notificatieKanaal: "email",
    });
    // A contact the source never published before starts its own trail.
    expect(added).toMatchObject({
      geinformeerdOp: null,
      naam: "R. Cruiter",
      notificatieKanaal: null,
    });
    expect(store.aanvragen[0]?.contactpersonen).toHaveLength(2);
  });
});
