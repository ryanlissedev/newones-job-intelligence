import { describe, expect, it } from "bun:test";

import {
  buildContentAddressedRawObjectPath,
  hashContent,
  RawObjectDigestMismatchError,
} from "@ji/connectors";

import { planMotianV1DerivedFieldRepair } from "./motian-v1-derived-field-repair";
import type {
  CurrentMotianDerivedFieldRow,
  MotianDerivedFieldRepairManifestEntry,
} from "./motian-v1-derived-field-repair";
import {
  MAX_MANIFEST_ENTRIES,
  parseArguments,
  planReportCandidate,
} from "./repair-motian-v1-derived-fields";

const V1_ID = "motian-001";
const BRON_ID = "00000000-0000-4000-8000-000000000030";
const AANVRAAG_ID = "00000000-0000-4000-8000-000000000901";

interface MotianRawFixture {
  readonly application_deadline?: string | null;
  readonly competences?: unknown;
  readonly company?: string | null;
  readonly contract_type?: string | null;
  readonly external_id: string;
  readonly id: string;
  readonly platform: string;
  readonly posted_at?: string | null;
  readonly province?: string | null;
  readonly start_date?: string | null;
  readonly title: string;
}

const rawBody = (overrides: Partial<MotianRawFixture> = {}): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      application_deadline: "2026-09-15 09:30:00",
      archived_at: null,
      company: "NVB opdrachtgever",
      contract_type: "detachering",
      deleted_at: null,
      description: null,
      end_client: null,
      external_id: "external-001",
      external_url: null,
      id: V1_ID,
      location: null,
      platform: "nationalevacaturebank",
      posted_at: "2026-09-10 08:10:11",
      province: null,
      rate_max: null,
      rate_min: null,
      scraped_at: null,
      start_date: "2026-10-01 00:00:00",
      status: null,
      title: "Data engineer",
      ...overrides,
    })
  );

const candidate = async (
  input: {
    readonly body?: Uint8Array;
    readonly current?: Partial<CurrentMotianDerivedFieldRow>;
    readonly manifest?: Partial<MotianDerivedFieldRepairManifestEntry>;
  } = {}
): Promise<{
  readonly current: CurrentMotianDerivedFieldRow;
  readonly manifest: MotianDerivedFieldRepairManifestEntry;
  readonly raw: { readonly body: Uint8Array; readonly contentType: "json" };
}> => {
  const body = input.body ?? rawBody();
  const contentHash = await hashContent(body);
  const rawPayloadRef = buildContentAddressedRawObjectPath({
    bronSlug: "nationalevacaturebank",
    contentHash,
    contentType: "json",
    startedAt: new Date("2026-09-10T00:00:00.000Z"),
  });
  const manifest = {
    aanvraagId: AANVRAAG_ID,
    bronId: BRON_ID,
    bronReferentie: "external-001",
    contentHash,
    rawPayloadRef,
    v1Id: V1_ID,
    ...input.manifest,
  };
  return {
    current: {
      ...manifest,
      contracttype: null,
      opdrachtgeverNaam: null,
      opleidingsniveau: null,
      provincie: null,
      publicatiedatum: null,
      skills: null,
      sluitingsdatum: null,
      startDatum: null,
      tariefEenheid: null,
      tariefMax: null,
      tariefMin: null,
      urenPerWeek: null,
      ...input.current,
    },
    manifest,
    raw: { body, contentType: "json" },
  };
};

describe("planMotianV1DerivedFieldRepair", () => {
  it("fills null bron_specifiek provincie and skills from the raw Motian row", async () => {
    const input = await candidate({
      body: rawBody({
        competences: [{ name: "TypeScript" }, { name: "typescript" }],
        province: "zuid-holland",
      }),
    });

    const plan = await planMotianV1DerivedFieldRepair(input);

    expect(plan).toMatchObject({
      kind: "patch",
      patch: { provincie: "Zuid-Holland", skills: '["TypeScript"]' },
    });
  });

  it("leaves an already filled provincie untouched", async () => {
    const input = await candidate({
      body: rawBody({ province: "utrecht" }),
      current: { provincie: "Flevoland" },
    });

    const plan = await planMotianV1DerivedFieldRepair(input);

    expect(plan).toMatchObject({ kind: "patch" });
    expect(
      plan.kind === "patch" ? plan.patch.provincie : "unreachable"
    ).toBeUndefined();
  });

  it("reports provincie and skills absent when the source publishes neither", async () => {
    const plan = await planMotianV1DerivedFieldRepair(await candidate());

    expect(plan.kind === "patch" ? plan.sourceAbsentFields : []).toContain(
      "provincie"
    );
    expect(plan.kind === "patch" ? plan.sourceAbsentFields : []).toContain(
      "skills"
    );
  });

  it("plans only null fields and keeps Motian legacy timestamps in UTC", async () => {
    const input = await candidate();

    await expect(planMotianV1DerivedFieldRepair(input)).resolves.toEqual({
      kind: "patch",
      patch: {
        contracttype: "detachering",
        opdrachtgeverNaam: "NVB opdrachtgever",
        publicatiedatum: "2026-09-10T08:10:11.000Z",
        sluitingsdatum: new Date("2026-09-15T09:30:00.000Z"),
        startDatum: "2026-10-01",
      },
      sourceAbsentFields: [
        "urenPerWeek",
        "opleidingsniveau",
        "provincie",
        "skills",
        "tariefMin",
        "tariefMax",
        "tariefEenheid",
      ],
      v1Id: V1_ID,
    });
  });

  it("keeps a contract proposal when the publication date is absent", async () => {
    const input = await candidate({
      body: rawBody({
        application_deadline: null,
        contract_type: "vast",
        posted_at: null,
        start_date: null,
      }),
    });

    await expect(planMotianV1DerivedFieldRepair(input)).resolves.toEqual({
      kind: "patch",
      patch: {
        contracttype: "vast",
        opdrachtgeverNaam: "NVB opdrachtgever",
      },
      sourceAbsentFields: [
        "publicatiedatum",
        "startDatum",
        "sluitingsdatum",
        "urenPerWeek",
        "opleidingsniveau",
        "provincie",
        "skills",
        "tariefMin",
        "tariefMax",
        "tariefEenheid",
      ],
      v1Id: V1_ID,
    });
  });

  it("keeps a publication date proposal when the contract is absent", async () => {
    const input = await candidate({
      body: rawBody({
        application_deadline: null,
        contract_type: null,
        start_date: null,
      }),
    });

    await expect(planMotianV1DerivedFieldRepair(input)).resolves.toEqual({
      kind: "patch",
      patch: {
        opdrachtgeverNaam: "NVB opdrachtgever",
        publicatiedatum: "2026-09-10T08:10:11.000Z",
      },
      sourceAbsentFields: [
        "contracttype",
        "startDatum",
        "sluitingsdatum",
        "urenPerWeek",
        "opleidingsniveau",
        "provincie",
        "skills",
        "tariefMin",
        "tariefMax",
        "tariefEenheid",
      ],
      v1Id: V1_ID,
    });
  });

  it("rejects a body whose digest no longer matches the current raw pointer", async () => {
    const input = await candidate();
    const tampered = new TextEncoder().encode("tampered");

    await expect(
      planMotianV1DerivedFieldRepair({
        ...input,
        raw: { body: tampered, contentType: "json" },
      })
    ).resolves.toEqual({
      kind: "rejected",
      reason: "raw_hash_mismatch",
      v1Id: V1_ID,
    });
  });

  it("rejects a content-addressed raw ref with a non-JSON suffix", async () => {
    const input = await candidate();
    const rawPayloadRef = input.current.rawPayloadRef.replace(
      /\.json$/u,
      ".html"
    );

    await expect(
      planMotianV1DerivedFieldRepair({
        ...input,
        current: { ...input.current, rawPayloadRef },
        manifest: { ...input.manifest, rawPayloadRef },
      })
    ).resolves.toEqual({
      kind: "rejected",
      reason: "raw_ref_not_content_addressed",
      v1Id: V1_ID,
    });
  });

  it("rejects a content-addressed raw ref for another Motian platform", async () => {
    const input = await candidate();
    const rawPayloadRef = input.current.rawPayloadRef.replace(
      "raw/nationalevacaturebank/",
      "raw/striive/"
    );

    await expect(
      planMotianV1DerivedFieldRepair({
        ...input,
        current: { ...input.current, rawPayloadRef },
        manifest: { ...input.manifest, rawPayloadRef },
      })
    ).resolves.toEqual({
      kind: "rejected",
      reason: "raw_ref_not_content_addressed",
      v1Id: V1_ID,
    });
  });

  it("rejects a native Striive payload even when its raw hash is valid", async () => {
    const input = await candidate({
      body: new TextEncoder().encode(
        JSON.stringify({ job: { clientName: "Stichting ICTU", id: V1_ID } })
      ),
    });

    await expect(planMotianV1DerivedFieldRepair(input)).resolves.toEqual({
      kind: "rejected",
      reason: "raw_schema_not_motian",
      v1Id: V1_ID,
    });
  });

  it("rejects a Striive envelope even when it mimics the Motian root fields", async () => {
    const motianRoot = JSON.parse(new TextDecoder().decode(rawBody()));
    const input = await candidate({
      body: new TextEncoder().encode(
        JSON.stringify({ ...motianRoot, job: { id: V1_ID } })
      ),
    });

    await expect(planMotianV1DerivedFieldRepair(input)).resolves.toEqual({
      kind: "rejected",
      reason: "raw_schema_not_motian",
      v1Id: V1_ID,
    });
  });

  it("does not overwrite a populated curated field", async () => {
    const input = await candidate({
      body: rawBody({
        application_deadline: null,
        contract_type: null,
        posted_at: null,
        start_date: null,
      }),
      current: { opdrachtgeverNaam: "existing value" },
    });

    await expect(planMotianV1DerivedFieldRepair(input)).resolves.toEqual({
      kind: "unchanged",
      sourceAbsentFields: [
        "contracttype",
        "publicatiedatum",
        "startDatum",
        "sluitingsdatum",
        "urenPerWeek",
        "opleidingsniveau",
        "provincie",
        "skills",
        "tariefMin",
        "tariefMax",
        "tariefEenheid",
      ],
      v1Id: V1_ID,
    });
  });

  it("reports source absence without guessing a field value", async () => {
    const input = await candidate({
      body: rawBody({
        application_deadline: null,
        company: null,
        contract_type: null,
        posted_at: null,
        start_date: null,
      }),
    });

    await expect(planMotianV1DerivedFieldRepair(input)).resolves.toEqual({
      kind: "unchanged",
      sourceAbsentFields: [
        "opdrachtgeverNaam",
        "contracttype",
        "publicatiedatum",
        "startDatum",
        "sluitingsdatum",
        "urenPerWeek",
        "opleidingsniveau",
        "provincie",
        "skills",
        "tariefMin",
        "tariefMax",
        "tariefEenheid",
      ],
      v1Id: V1_ID,
    });
  });

  it("rejects a raw root whose identity is not the current curated identity", async () => {
    const input = await candidate({ body: rawBody({ external_id: "other" }) });

    await expect(planMotianV1DerivedFieldRepair(input)).resolves.toEqual({
      kind: "rejected",
      reason: "source_identity_mismatch",
      v1Id: V1_ID,
    });
  });

  it("is idempotent because planning has no writes", async () => {
    const input = await candidate();

    const [first, second] = await Promise.all([
      planMotianV1DerivedFieldRepair(input),
      planMotianV1DerivedFieldRepair(input),
    ]);

    expect(first).toEqual(second);
  });
});

describe("planReportCandidate", () => {
  it("does not read S3 when any current identity field differs from its manifest", async () => {
    const input = await candidate();
    let rawReads = 0;
    const mismatchedCurrentRows = [
      { ...input.current, aanvraagId: "another-aanvraag" },
      { ...input.current, bronId: "another-bron" },
      { ...input.current, bronReferentie: "another-reference" },
      { ...input.current, contentHash: "a".repeat(64) },
      { ...input.current, rawPayloadRef: "raw/other/2026/09/ref.json" },
      { ...input.current, v1Id: "another-v1-id" },
    ];

    const reports = await Promise.all(
      mismatchedCurrentRows.map((current) =>
        planReportCandidate({
          current,
          manifest: input.manifest,
          readRawObject: () => {
            rawReads += 1;
            return Promise.resolve(input.raw);
          },
        })
      )
    );

    expect(reports).toEqual(
      mismatchedCurrentRows.map(() => ({
        reason: "current_row_mismatch",
        status: "rejected",
        v1Id: V1_ID,
      }))
    );
    expect(rawReads).toBe(0);
  });

  it("reports a raw hash mismatch when the object store detects digest corruption", async () => {
    const input = await candidate();

    await expect(
      planReportCandidate({
        current: input.current,
        manifest: input.manifest,
        readRawObject: () =>
          Promise.reject(
            new RawObjectDigestMismatchError(
              input.current.rawPayloadRef,
              input.manifest.contentHash,
              "b".repeat(64)
            )
          ),
      })
    ).resolves.toEqual({
      reason: "raw_hash_mismatch",
      status: "rejected",
      v1Id: V1_ID,
    });
  });

  it("keeps unrelated raw object read failures as raw_read_failed", async () => {
    const input = await candidate();

    await expect(
      planReportCandidate({
        current: input.current,
        manifest: input.manifest,
        readRawObject: () => Promise.reject(new Error("S3 unavailable")),
      })
    ).resolves.toEqual({
      reason: "raw_read_failed",
      status: "rejected",
      v1Id: V1_ID,
    });
  });
});

describe("repair CLI arguments", () => {
  const manifestPath = "motian-manifest.json";

  it("defaults to report mode when no mutating flag is present", () => {
    expect(
      parseArguments(["--manifest", manifestPath, "--limit", "3"])
    ).toEqual({
      ingestQuiesced: false,
      limit: 3,
      manifestPath,
      operation: "report",
    });
  });

  it("accepts apply only with an explicit quiescence acknowledgement", () => {
    expect(() =>
      parseArguments(["--apply", "--limit", "1", "--manifest", manifestPath])
    ).toThrow("--apply and --rollback require --ingest-quiesced");
    expect(
      parseArguments([
        "--apply",
        "--ingest-quiesced",
        "--limit",
        "1",
        "--manifest",
        manifestPath,
      ])
    ).toEqual({
      ingestQuiesced: true,
      limit: 1,
      manifestPath,
      operation: "apply",
    });
  });

  it("requires a bounded limit and manifest for report and apply", () => {
    expect(() => parseArguments(["--manifest", manifestPath])).toThrow(
      "--limit is required"
    );
    expect(() => parseArguments(["--limit", "1"])).toThrow(
      "--manifest is required"
    );
    expect(() =>
      parseArguments([
        "--apply",
        "--ingest-quiesced",
        "--limit",
        String(MAX_MANIFEST_ENTRIES + 1),
        "--manifest",
        manifestPath,
      ])
    ).toThrow("--limit must be an integer from 1 through");
  });

  it("rejects quiescence acknowledgement in report mode", () => {
    expect(() =>
      parseArguments([
        "--ingest-quiesced",
        "--limit",
        "1",
        "--manifest",
        manifestPath,
      ])
    ).toThrow("report mode rejects it");
  });

  it("accepts rollback only with an audit id and quiescence acknowledgement", () => {
    expect(() =>
      parseArguments(["--rollback", "--audit-id", "audit-1"])
    ).toThrow("--apply and --rollback require --ingest-quiesced");
    expect(
      parseArguments([
        "--rollback",
        "--audit-id",
        "audit-1",
        "--ingest-quiesced",
      ])
    ).toEqual({
      auditId: "audit-1",
      ingestQuiesced: true,
      operation: "rollback",
    });
    expect(() =>
      parseArguments([
        "--rollback",
        "--audit-id",
        "audit-1",
        "--ingest-quiesced",
        "--limit",
        "1",
      ])
    ).toThrow("--rollback accepts only --audit-id and --ingest-quiesced");
    expect(() =>
      parseArguments([
        "--rollback",
        "--audit-id",
        "audit-1",
        "--ingest-quiesced",
        "--manifest",
        manifestPath,
      ])
    ).toThrow("--rollback accepts only --audit-id and --ingest-quiesced");
  });

  it("rejects mutually exclusive operations and misplaced audit ids", () => {
    expect(() =>
      parseArguments([
        "--apply",
        "--rollback",
        "--ingest-quiesced",
        "--audit-id",
        "audit-1",
      ])
    ).toThrow("--apply and --rollback are mutually exclusive");
    expect(() =>
      parseArguments([
        "--audit-id",
        "audit-1",
        "--manifest",
        manifestPath,
        "--limit",
        "1",
      ])
    ).toThrow("--audit-id requires --rollback");
  });
});
