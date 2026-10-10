import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { readAanvraagBronFacts } from "../../packages/db/src/aanvraag-read-mapping";
import * as schema from "../../packages/db/src/schema";
import { PostgresAuditStore } from "../../packages/db/src/user-write-stores";
import {
  applyZzpNegationLabel,
  hasRestorableAliasConflict,
  isFreelanceFallback,
  MAX_MANIFEST_ENTRIES,
  MAX_MATCHED_PHRASE_LENGTH,
  readFreelanceAliases,
  parseArguments,
  parseManifest,
  planCorrection,
  redactCredentials,
  rollbackZzpNegationLabel,
  summariseResults,
  ZZP_NEGATION_ACTOR_ID,
  ZZP_NEGATION_APPLY_ACTION,
  ZZP_NEGATION_EVENT_TYPE,
  ZZP_NEGATION_ROLLBACK_ACTION,
  ZZP_NEGATION_SCOPE_ID,
} from "./apply-zzp-negation-labels";
import type {
  CurrentAanvraagRow,
  ZzpNegationManifestEntry,
} from "./apply-zzp-negation-labels";

const AANVRAAG_ID = "11111111-1111-4111-8111-111111111111";

const manifestEntry = (
  overrides: Partial<ZzpNegationManifestEntry> = {}
): ZzpNegationManifestEntry => ({
  bron: "Inhuurdesk",
  id: AANVRAAG_ID,
  matchedPhrase: "Geen ZZP mogelijk",
  titel: "Adviseur A",
  versie: 3,
  ...overrides,
});

const currentRow = (
  overrides: Partial<CurrentAanvraagRow> = {}
): CurrentAanvraagRow => ({
  aanvraagId: AANVRAAG_ID,
  beschrijving: "Geen ZZP mogelijk.",
  bronSpecifiek: {},
  contentHash: "a".repeat(64),
  contracttype: "freelance",
  titel: "Adviseur A",
  versie: 3,
  ...overrides,
});

/** The report tool's shape, plus the one stray field a rejection test needs. */
interface ManifestCandidateFixture extends ZzpNegationManifestEntry {
  readonly beschrijving?: string;
}

interface ManifestFixture {
  readonly byBron?: Record<string, number>;
  readonly candidates: readonly ManifestCandidateFixture[];
  readonly mislabelled?: number;
  readonly scanned?: number;
}

type TestBronSpecifiek =
  | Readonly<Record<string, string | number | null>>
  | readonly (string | number | null)[];

const encode = (value: ManifestFixture): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

describe("parseArguments", () => {
  it("defaults to a dry run", () => {
    expect(
      parseArguments(["--manifest", "/tmp/m.json", "--limit", "5"])
    ).toEqual({
      ingestQuiesced: false,
      limit: 5,
      manifestPath: "/tmp/m.json",
      operation: "report",
    });
  });

  it("accepts apply only with an explicit quiescence acknowledgement", () => {
    expect(() =>
      parseArguments(["--manifest", "/tmp/m.json", "--limit", "5", "--apply"])
    ).toThrow("--apply and --rollback require --ingest-quiesced");
    expect(
      parseArguments([
        "--manifest",
        "/tmp/m.json",
        "--limit",
        "5",
        "--apply",
        "--ingest-quiesced",
      ])
    ).toEqual({
      ingestQuiesced: true,
      limit: 5,
      manifestPath: "/tmp/m.json",
      operation: "apply",
    });
  });

  it("rejects a quiescence acknowledgement in dry-run mode", () => {
    expect(() =>
      parseArguments([
        "--manifest",
        "/tmp/m.json",
        "--limit",
        "5",
        "--ingest-quiesced",
      ])
    ).toThrow("report mode rejects it");
  });

  it("accepts rollback only with an audit id and quiescence", () => {
    expect(
      parseArguments(["--rollback", "--audit-id", "abc", "--ingest-quiesced"])
    ).toEqual({
      auditId: "abc",
      ingestQuiesced: true,
      operation: "rollback",
    });
    expect(() =>
      parseArguments([
        "--rollback",
        "--audit-id",
        "abc",
        "--manifest",
        "/tmp/m.json",
        "--ingest-quiesced",
      ])
    ).toThrow("--rollback accepts only --audit-id and --ingest-quiesced");
  });

  it("refuses apply together with rollback", () => {
    expect(() =>
      parseArguments(["--apply", "--rollback", "--ingest-quiesced"])
    ).toThrow("--apply and --rollback are mutually exclusive");
  });

  it("requires a bounded limit", () => {
    for (const limit of ["0", "101", "abc", "-1"]) {
      expect(() =>
        parseArguments(["--manifest", "/tmp/m.json", "--limit", limit])
      ).toThrow("--limit must be an integer");
    }
  });

  it("requires a manifest", () => {
    expect(() => parseArguments(["--limit", "5"])).toThrow(
      "--manifest is required"
    );
  });

  it("refuses unknown and duplicated options", () => {
    expect(() => parseArguments(["--force"])).toThrow("Unsupported option");
    expect(() => parseArguments(["--limit", "1", "--limit", "2"])).toThrow(
      "Duplicate option"
    );
  });
});

describe("parseManifest", () => {
  it("reads the report tool's own output and ignores its summary", () => {
    const manifest = parseManifest(
      encode({
        byBron: { Inhuurdesk: 1 },
        candidates: [manifestEntry()],
        mislabelled: 1,
        scanned: 6221,
      })
    );
    expect(manifest.candidates).toHaveLength(1);
    expect(manifest.candidates[0]?.id).toBe(AANVRAAG_ID);
  });

  it("refuses duplicate rows", () => {
    expect(() =>
      parseManifest(encode({ candidates: [manifestEntry(), manifestEntry()] }))
    ).toThrow("duplicate aanvraag ids");
  });

  it("refuses an empty or oversized manifest", () => {
    expect(() => parseManifest(encode({ candidates: [] }))).toThrow();
    const tooMany = Array.from({ length: MAX_MANIFEST_ENTRIES + 1 }, () =>
      manifestEntry({ id: randomUUID() })
    );
    expect(() => parseManifest(encode({ candidates: tooMany }))).toThrow();
  });

  it("accepts a phrase longer than the audit cap", () => {
    // The report emits the whole regex match, and a coordinated list can run
    // past the cap. The manifest must not reject what the report produced; the
    // writer truncates for the audit and records that it did.
    const manifest = parseManifest(
      encode({
        candidates: [
          manifestEntry({
            matchedPhrase: `Geen zzp${", detachering".repeat(20)} of interim toegestaan`,
          }),
        ],
      })
    );
    expect(manifest.candidates[0]?.matchedPhrase.length).toBeGreaterThan(
      MAX_MATCHED_PHRASE_LENGTH
    );
  });

  it("refuses an unexpected field on a candidate", () => {
    expect(() =>
      parseManifest(
        encode({
          candidates: [{ ...manifestEntry(), beschrijving: "leaked" }],
        })
      )
    ).toThrow();
  });
});

describe("planCorrection", () => {
  it("corrects a row whose current text still refuses freelance work", () => {
    const plan = planCorrection({
      current: currentRow(),
      manifest: manifestEntry(),
    });
    expect(plan.kind).toBe("correct");
    expect(plan.nextContracttype).toBeNull();
    expect(plan.matchedPhrase).toBe("Geen ZZP mogelijk");
  });

  it("keeps the alternative the text proves", () => {
    const plan = planCorrection({
      current: currentRow({
        beschrijving: "Geen ZZP mogelijk. Uitsluitend detachering.",
      }),
      manifest: manifestEntry(),
    });
    expect(plan.kind).toBe("correct");
    expect(plan.nextContracttype).toBe("detachering");
  });

  it("rejects a missing row", () => {
    expect(
      planCorrection({ current: null, manifest: manifestEntry() })
    ).toEqual({ kind: "rejected", reason: "current_row_missing" });
  });

  it("rejects a row whose id is not the one approved", () => {
    expect(
      planCorrection({
        current: currentRow({ aanvraagId: randomUUID() }),
        manifest: manifestEntry(),
      }).reason
    ).toBe("current_row_missing");
  });

  it("rejects a label this lane does not correct", () => {
    for (const contracttype of ["detachering", "interim", "vast", null]) {
      expect(
        planCorrection({
          current: currentRow({ contracttype }),
          manifest: manifestEntry(),
        }).reason
      ).toBe("contracttype_not_freelance");
    }
  });

  it("rejects a row that moved on since the report", () => {
    expect(
      planCorrection({
        current: currentRow({ versie: 4 }),
        manifest: manifestEntry(),
      }).reason
    ).toBe("versie_mismatch");
  });

  it("rejects a row whose text no longer refuses freelance work", () => {
    expect(
      planCorrection({
        current: currentRow({
          beschrijving: "ZZP mogelijk, tarief in overleg.",
        }),
        manifest: manifestEntry(),
      }).reason
    ).toBe("text_no_longer_excludes");
  });

  it("re-reads the text rather than trusting the manifest phrase", () => {
    // The manifest says the row was excluded; the row says otherwise. The row
    // wins, because the manifest is an approval, not evidence.
    const plan = planCorrection({
      current: currentRow({ beschrijving: "Geschikt voor zzp'ers." }),
      manifest: manifestEntry({ matchedPhrase: "Geen ZZP mogelijk" }),
    });
    expect(plan.kind).toBe("rejected");
    expect(plan.reason).toBe("text_no_longer_excludes");
  });
});

describe("readFreelanceAliases", () => {
  it("names only the aliases that would still read as freelance", () => {
    expect(readFreelanceAliases({ contracttype: "freelance" })).toEqual({
      contracttype: "freelance",
    });
    expect(
      readFreelanceAliases({ contract_type: "ZZP", contracttype: "Freelance" })
    ).toEqual({ contract_type: "ZZP", contracttype: "Freelance" });
  });

  it("leaves a different contract form alone", () => {
    // This lane has evidence against freelance, not against detachering.
    expect(readFreelanceAliases({ contracttype: "detachering" })).toEqual({});
    expect(
      readFreelanceAliases({ contracttype: "vast dienstverband" })
    ).toEqual({});
  });

  it("keeps a valid alias when its sibling is null or malformed", () => {
    expect(
      readFreelanceAliases({ contract_type: null, contracttype: "freelance" })
    ).toEqual({ contracttype: "freelance" });
    expect(
      readFreelanceAliases({ contract_type: 42, contracttype: "zzp" })
    ).toEqual({ contracttype: "zzp" });
  });

  it("survives a missing or malformed column", () => {
    for (const value of [null, undefined, {}, "freelance", 7]) {
      expect(readFreelanceAliases(value)).toEqual({});
    }
  });

  it("ignores unrelated keys", () => {
    expect(
      readFreelanceAliases({ contracttype: "zzp", tarief: "freelance" })
    ).toEqual({ contracttype: "zzp" });
  });
});

describe("isFreelanceFallback", () => {
  it("accepts the spellings that would resurface the label", () => {
    for (const value of [
      "freelance",
      "freelancer",
      "freelancers",
      " Freelance ",
      "ZZP",
      "zzp'ers",
    ]) {
      expect(isFreelanceFallback(value)).toBe(true);
    }
  });

  it("rejects other forms and non-strings", () => {
    for (const value of ["detachering", "interim", "", null, undefined]) {
      expect(isFreelanceFallback(value)).toBe(false);
    }
  });
});

describe("hasRestorableAliasConflict", () => {
  const restoredAliases = { contracttype: "freelance" } as const;

  it("treats a present null or non-string alias as a conflict", () => {
    expect(
      hasRestorableAliasConflict({ contracttype: null }, restoredAliases)
    ).toBe(true);
    expect(
      hasRestorableAliasConflict({ contracttype: 42 }, restoredAliases)
    ).toBe(true);
  });

  it("ignores absent aliases and unrelated keys", () => {
    expect(
      hasRestorableAliasConflict({ tarief_eenheid: "uur" }, restoredAliases)
    ).toBe(false);
    expect(hasRestorableAliasConflict({}, restoredAliases)).toBe(false);
    expect(hasRestorableAliasConflict(null, {})).toBe(false);
  });

  it("fails closed for an unknown JSON shape when an alias must be restored", () => {
    expect(hasRestorableAliasConflict(null, restoredAliases)).toBe(true);
    expect(hasRestorableAliasConflict("freelance", restoredAliases)).toBe(true);
    expect(hasRestorableAliasConflict([], restoredAliases)).toBe(true);
  });
});

describe("summariseResults", () => {
  it("counts every outcome and the projection events required", () => {
    const report = summariseResults({
      manifestSha256: "b".repeat(64),
      results: [
        { aanvraagId: "a", auditId: "x", status: "applied" },
        { aanvraagId: "b", auditId: "y", status: "applied" },
        { aanvraagId: "c", status: "unchanged" },
        { aanvraagId: "d", reason: "versie_mismatch", status: "rejected" },
        { aanvraagId: "e", reason: "versie_mismatch", status: "rejected" },
        {
          aanvraagId: "f",
          reason: "contracttype_not_freelance",
          status: "rejected",
        },
      ],
    });
    expect(report.applied).toBe(2);
    expect(report.unchanged).toBe(1);
    expect(report.projectionEventsRequired).toBe(2);
    expect(report.selected).toBe(6);
    expect(report.rejected).toEqual({
      contracttype_not_freelance: 1,
      versie_mismatch: 2,
    });
  });

  it("carries no vacancy text in its output", () => {
    const report = summariseResults({
      manifestSha256: "b".repeat(64),
      results: [{ aanvraagId: "a", auditId: "x", status: "applied" }],
    });
    const serialised = JSON.stringify(report);
    for (const forbidden of ["beschrijving", "titel", "opdrachtgever", "url"]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("redactCredentials", () => {
  it("strips a connection string password", () => {
    expect(
      redactCredentials(
        "failed on postgres://ji_app:sekrit@db.internal:5432/ji"
      )
    ).toBe("failed on <redacted>@db.internal:5432/ji");
  });

  it("leaves an ordinary message alone", () => {
    expect(redactCredentials("DATABASE_URL is required")).toBe(
      "DATABASE_URL is required"
    );
  });
});

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(
  import.meta.dir,
  "../../packages/db/src/migrations"
);
const BRON_ID = "00000000-0000-4000-8000-000000000041";
const NOW = new Date("2026-09-13T00:00:00.000Z");

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {
      /* the probe failed to close; the database is unavailable either way */
    });
    return false;
  }
};

const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && databaseRequired) {
  throw new Error("Required test database is unavailable");
}

describe
  .skipIf(!postgresAvailable)
  .serial("freelance-label correction apply and rollback", () => {
    let migratorClient: ReturnType<typeof postgres>;
    let applicationClient: ReturnType<typeof postgres>;

    beforeAll(async () => {
      migratorClient = postgres(migratorUrl, { max: 1 });
      await migrate(drizzle(migratorClient, { schema }), { migrationsFolder });
      applicationClient = postgres(applicationUrl, { max: 2 });
      await migratorClient`
        INSERT INTO curated.bron (id, naam, categorie, actief, status)
        VALUES (${BRON_ID}, 'CTP491 fixture', 'msp_broker', false, 'blocked')
        ON CONFLICT (id) DO NOTHING
      `;
    });

    afterAll(async () => {
      await applicationClient?.end({ timeout: 5 });
      await migratorClient?.end({ timeout: 5 });
    });

    const seedRow = async (input: {
      readonly beschrijving?: string;
      readonly bronSpecifiek?: TestBronSpecifiek;
      readonly contracttype?: string | null;
      readonly versie?: number;
    }): Promise<{
      readonly aanvraagId: string;
      readonly contentHash: string;
      readonly manifest: ZzpNegationManifestEntry;
    }> => {
      const aanvraagId = randomUUID();
      const runId = randomUUID();
      const contentHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
      const versie = input.versie ?? 3;
      await migratorClient`
        INSERT INTO curated.scrape_run (id, bron_id, status, gestart)
        VALUES (${runId}, ${BRON_ID}, 'running', ${NOW.toISOString()})
      `;
      await migratorClient`
        INSERT INTO curated.aanvraag (
          id, beschrijving, bron_id, bron_referentie, bron_specifiek,
          content_hash,
          contracttype, eerste_gezien_op, extractie_methode, laatst_gezien_op,
          raw_payload_ref, scrape_run_id, status, titel, versie
        ) VALUES (
          ${aanvraagId},
          ${input.beschrijving ?? "Geen ZZP mogelijk."},
          ${BRON_ID},
          ${`ref-${aanvraagId}`},
          ${JSON.stringify(input.bronSpecifiek ?? {})}::text::jsonb,
          ${contentHash},
          ${input.contracttype === undefined ? "freelance" : input.contracttype},
          ${NOW.toISOString()},
          'spec',
          ${NOW.toISOString()},
          ${`raw/ctp491/${contentHash}.json`},
          ${runId},
          'active',
          'Adviseur A',
          ${versie}
        )
      `;
      return {
        aanvraagId,
        contentHash,
        manifest: {
          bron: "CTP491 fixture",
          id: aanvraagId,
          matchedPhrase: "Geen ZZP mogelijk",
          titel: "Adviseur A",
          versie,
        },
      };
    };

    const readContracttype = async (
      aanvraagId: string
    ): Promise<string | null> => {
      const rows = await migratorClient<{ contracttype: string | null }[]>`
        SELECT contracttype FROM curated.aanvraag WHERE id = ${aanvraagId}
      `;
      return rows[0]?.contracttype ?? null;
    };

    const readBronSpecifiek = async (
      aanvraagId: string
    ): Promise<TestBronSpecifiek> => {
      const rows = await migratorClient<{ bronSpecifiek: TestBronSpecifiek }[]>`
        SELECT bron_specifiek AS "bronSpecifiek"
        FROM curated.aanvraag WHERE id = ${aanvraagId}
      `;
      return rows[0]?.bronSpecifiek ?? {};
    };

    it("clears the label and writes one audit and one outbox event", async () => {
      const seeded = await seedRow({});
      const result = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "c".repeat(64),
      });

      expect(result.status).toBe("applied");
      expect(await readContracttype(seeded.aanvraagId)).toBeNull();

      const audits = await migratorClient<
        { action: string; actorId: string; metadata: unknown }[]
      >`
        SELECT action, actor_id AS "actorId", metadata
        FROM curated.audit_event
        WHERE entity_id = ${seeded.aanvraagId}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe(ZZP_NEGATION_APPLY_ACTION);
      expect(audits[0]?.actorId).toBe(ZZP_NEGATION_ACTOR_ID);
      expect(audits[0]?.metadata).toMatchObject({
        afterimage: { contracttype: null },
        matchedPhrase: "Geen ZZP mogelijk",
        preimage: { contracttype: "freelance" },
      });

      const outbox = await migratorClient<{ eventType: string }[]>`
        SELECT event_type AS "eventType"
        FROM curated.outbox_event
        WHERE aggregate_id = ${seeded.aanvraagId}
      `;
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.eventType).toBe(ZZP_NEGATION_EVENT_TYPE);
    });

    it("keeps the alternative the text proves", async () => {
      const seeded = await seedRow({
        beschrijving: "Geen ZZP mogelijk. Uitsluitend detachering.",
      });
      const result = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "c".repeat(64),
      });
      expect(result.status).toBe("applied");
      expect(await readContracttype(seeded.aanvraagId)).toBe("detachering");
    });

    it("is idempotent for the same manifest", async () => {
      const seeded = await seedRow({});
      const manifestSha256 = "d".repeat(64);
      const first = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256,
      });
      const second = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256,
      });
      expect(first.status).toBe("applied");
      expect(second.status).toBe("unchanged");
      expect(second.auditId).toBe(first.auditId);

      const audits = await migratorClient<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM curated.audit_event
        WHERE entity_id = ${seeded.aanvraagId}
      `;
      expect(audits[0]?.count).toBe("1");
    });

    it("refuses a row whose versie moved on, and writes nothing", async () => {
      const seeded = await seedRow({ versie: 9 });
      const result = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: { ...seeded.manifest, versie: 3 },
        manifestSha256: "c".repeat(64),
      });
      expect(result).toEqual({
        aanvraagId: seeded.aanvraagId,
        reason: "versie_mismatch",
        status: "rejected",
      });
      expect(await readContracttype(seeded.aanvraagId)).toBe("freelance");

      const audits = await migratorClient<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM curated.audit_event
        WHERE entity_id = ${seeded.aanvraagId}
      `;
      expect(audits[0]?.count).toBe("0");
    });

    it("refuses a row whose text no longer refuses freelance work", async () => {
      const seeded = await seedRow({ beschrijving: "ZZP mogelijk." });
      const result = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "c".repeat(64),
      });
      expect(result.reason).toBe("text_no_longer_excludes");
      expect(await readContracttype(seeded.aanvraagId)).toBe("freelance");
    });

    it("refuses a row that is no longer labelled freelance", async () => {
      const seeded = await seedRow({ contracttype: "detachering" });
      const result = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "c".repeat(64),
      });
      expect(result.reason).toBe("contracttype_not_freelance");
      expect(await readContracttype(seeded.aanvraagId)).toBe("detachering");
    });

    it("clears the bron_specifiek fallback and restores it on rollback", async () => {
      // Clearing only the promoted column leaves readAanvraagBronFacts to
      // resurface the same label in both the API record and the search
      // document, so the correction would be invisible to users.
      const bronSpecifiek = {
        contracttype: "freelance",
        tarief_eenheid: "uur",
      };
      const seeded = await seedRow({ bronSpecifiek });
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "1".repeat(64),
      });

      expect(applied.status).toBe("applied");
      expect(await readContracttype(seeded.aanvraagId)).toBeNull();
      expect(await readBronSpecifiek(seeded.aanvraagId)).toEqual({
        tarief_eenheid: "uur",
      });

      const rolledBack = await rollbackZzpNegationLabel({
        auditId: applied.auditId ?? "",
        database: applicationClient,
      });
      expect(rolledBack.status).toBe("rolled_back");
      expect(await readContracttype(seeded.aanvraagId)).toBe("freelance");
      expect(await readBronSpecifiek(seeded.aanvraagId)).toEqual(bronSpecifiek);
    });

    it.each(["freelancer", "freelancers"])(
      "clears the %s alias with a null sibling on apply",
      async (alias) => {
        const seeded = await seedRow({
          bronSpecifiek: { contract_type: null, contracttype: alias },
        });
        expect(
          readAanvraagBronFacts(await readBronSpecifiek(seeded.aanvraagId))
            .contracttype
        ).toBe(alias);
        const applied = await applyZzpNegationLabel({
          database: applicationClient,
          manifest: seeded.manifest,
          manifestSha256: "7".repeat(64),
        });
        expect(applied.status).toBe("applied");
        expect(await readContracttype(seeded.aanvraagId)).toBeNull();
        const stored = await readBronSpecifiek(seeded.aanvraagId);
        expect(stored).toEqual({ contract_type: null });
        expect(readAanvraagBronFacts(stored).contracttype).toBeNull();
      }
    );

    it("leaves a fallback naming a different contract form alone", async () => {
      const bronSpecifiek = { contracttype: "detachering" };
      const seeded = await seedRow({ bronSpecifiek });
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "2".repeat(64),
      });
      expect(applied.status).toBe("applied");
      expect(await readBronSpecifiek(seeded.aanvraagId)).toEqual(bronSpecifiek);
    });

    it("reapplies after a rollback rather than reporting unchanged", async () => {
      const seeded = await seedRow({});
      const manifestSha256 = "3".repeat(64);
      const first = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256,
      });
      expect(first.status).toBe("applied");

      const rolledBack = await rollbackZzpNegationLabel({
        auditId: first.auditId ?? "",
        database: applicationClient,
      });
      expect(rolledBack.status).toBe("rolled_back");
      expect(await readContracttype(seeded.aanvraagId)).toBe("freelance");

      // The first apply audit still exists, but a rollback reversed it, so the
      // row is mislabelled again and the manifest must be able to correct it.
      const second = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256,
      });
      expect(second.status).toBe("applied");
      expect(second.auditId).not.toBe(first.auditId);
      expect(await readContracttype(seeded.aanvraagId)).toBeNull();
    });

    it("records a truncated phrase as truncated", async () => {
      // A real coordinated list the classifier matches whole: 290 characters,
      // which is what the report would put in the manifest.
      const longExclusion = `Geen zzp${", detachering".repeat(20)} of interim toegestaan.`;
      const seeded = await seedRow({ beschrijving: longExclusion });
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "4".repeat(64),
      });
      expect(applied.status).toBe("applied");

      const audits = await migratorClient<{ metadata: unknown }[]>`
        SELECT metadata FROM curated.audit_event
        WHERE entity_id = ${seeded.aanvraagId}
      `;
      // SAFETY: this row is the audit event the apply above just inserted, so
      // its metadata is the shape applyAuditMetadataSchema wrote.
      const metadata = audits[0]?.metadata as {
        matchedPhrase: string;
        matchedPhraseTruncated: boolean;
      };
      expect(metadata.matchedPhraseTruncated).toBe(true);
      expect(metadata.matchedPhrase.length).toBe(MAX_MATCHED_PHRASE_LENGTH);
    });

    it("refuses an audit event from another scope", async () => {
      const seeded = await seedRow({});
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "5".repeat(64),
      });
      await migratorClient`
        UPDATE curated.audit_event
        SET scope_id = 'other-tenant'
        WHERE id::text = ${applied.auditId ?? ""}
      `;
      const result = await rollbackZzpNegationLabel({
        auditId: applied.auditId ?? "",
        database: applicationClient,
      });
      expect(result.reason).toBe("audit_not_apply");
      expect(await readContracttype(seeded.aanvraagId)).toBeNull();
    });

    it("reads back its own audit trail through the store decoder", async () => {
      const seeded = await seedRow({ bronSpecifiek: { contracttype: "zzp" } });
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "6".repeat(64),
      });
      await rollbackZzpNegationLabel({
        auditId: applied.auditId ?? "",
        database: applicationClient,
      });
      const store = new PostgresAuditStore(
        drizzle(applicationClient, { schema })
      );
      const events = await store.listByActorId(
        ZZP_NEGATION_ACTOR_ID,
        ZZP_NEGATION_SCOPE_ID
      );
      expect(events.length).toBeGreaterThanOrEqual(2);
    });

    it("restores the previous label on rollback", async () => {
      const seeded = await seedRow({});
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "e".repeat(64),
      });
      expect(applied.status).toBe("applied");
      const auditId = applied.auditId ?? "";

      const rolledBack = await rollbackZzpNegationLabel({
        auditId,
        database: applicationClient,
      });
      expect(rolledBack.status).toBe("rolled_back");
      expect(await readContracttype(seeded.aanvraagId)).toBe("freelance");

      const audits = await migratorClient<{ action: string }[]>`
        SELECT action
        FROM curated.audit_event
        WHERE entity_id = ${seeded.aanvraagId}
        ORDER BY created_at ASC, id ASC
      `;
      expect(audits.map((audit) => audit.action)).toEqual([
        ZZP_NEGATION_APPLY_ACTION,
        ZZP_NEGATION_ROLLBACK_ACTION,
      ]);
    });

    it("preserves array bron_specifiek when rollback has no aliases", async () => {
      const bronSpecifiek = ["legacy-contract-label", "second-entry"] as const;
      const seeded = await seedRow({ bronSpecifiek });
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "8".repeat(64),
      });
      expect(applied.status).toBe("applied");
      expect(await readBronSpecifiek(seeded.aanvraagId)).toEqual(bronSpecifiek);

      const rolledBack = await rollbackZzpNegationLabel({
        auditId: applied.auditId ?? "",
        database: applicationClient,
      });
      expect(rolledBack.status).toBe("rolled_back");
      expect(await readContracttype(seeded.aanvraagId)).toBe("freelance");
      expect(await readBronSpecifiek(seeded.aanvraagId)).toEqual(bronSpecifiek);
    });

    it("refuses rollback when a removed alias is repopulated", async () => {
      for (const [aliasKey, foreignAliasValue] of [
        ["contracttype", null],
        ["contract_type", 42],
      ] as const) {
        /* oxlint-disable no-await-in-loop -- each scenario uses its own serial fixture row */
        const seeded = await seedRow({
          bronSpecifiek: {
            [aliasKey]: "freelance",
            tarief_eenheid: "uur",
          },
        });
        const applied = await applyZzpNegationLabel({
          database: applicationClient,
          manifest: seeded.manifest,
          manifestSha256: "9".repeat(64),
        });
        expect(applied.status).toBe("applied");

        // Simulate a foreign writer that changes only the alias JSON. The
        // content hash and promoted contracttype remain exactly as applied.
        await migratorClient`
          UPDATE curated.aanvraag
          SET bron_specifiek = bron_specifiek || ${JSON.stringify({
            [aliasKey]: foreignAliasValue,
          })}::text::jsonb
          WHERE id = ${seeded.aanvraagId}
        `;

        const result = await rollbackZzpNegationLabel({
          auditId: applied.auditId ?? "",
          database: applicationClient,
        });
        expect(result).toEqual({
          aanvraagId: seeded.aanvraagId,
          reason: "current_row_mismatch",
          status: "rejected",
        });
        expect(await readContracttype(seeded.aanvraagId)).toBeNull();
        expect(await readBronSpecifiek(seeded.aanvraagId)).toEqual({
          [aliasKey]: foreignAliasValue,
          tarief_eenheid: "uur",
        });

        const hashes = await migratorClient<{ contentHash: string }[]>`
          SELECT content_hash AS "contentHash"
          FROM curated.aanvraag
          WHERE id = ${seeded.aanvraagId}
        `;
        expect(hashes[0]?.contentHash).toBe(seeded.contentHash);
        /* oxlint-enable no-await-in-loop */
      }
    });

    it("rolls back only once", async () => {
      const seeded = await seedRow({});
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "f".repeat(64),
      });
      const auditId = applied.auditId ?? "";
      const first = await rollbackZzpNegationLabel({
        auditId,
        database: applicationClient,
      });
      const second = await rollbackZzpNegationLabel({
        auditId,
        database: applicationClient,
      });
      expect(first.status).toBe("rolled_back");
      expect(second.status).toBe("unchanged");
      expect(second.auditId).toBe(first.auditId);
    });

    it("refuses rollback after a version-only advance", async () => {
      const seeded = await seedRow({});
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "a".repeat(64),
      });
      expect(applied.status).toBe("applied");

      await migratorClient`
        UPDATE curated.aanvraag
        SET versie = versie + 1
        WHERE id = ${seeded.aanvraagId}
      `;

      const result = await rollbackZzpNegationLabel({
        auditId: applied.auditId ?? "",
        database: applicationClient,
      });
      expect(result).toEqual({
        aanvraagId: seeded.aanvraagId,
        reason: "versie_mismatch",
        status: "rejected",
      });

      const row = await migratorClient<
        { contentHash: string; contracttype: string | null; versie: number }[]
      >`
        SELECT
          content_hash AS "contentHash",
          contracttype,
          versie
        FROM curated.aanvraag
        WHERE id = ${seeded.aanvraagId}
      `;
      expect(row[0]).toEqual({
        contentHash: seeded.contentHash,
        contracttype: null,
        versie: seeded.manifest.versie + 1,
      });

      const audits = await migratorClient<{ action: string }[]>`
        SELECT action
        FROM curated.audit_event
        WHERE entity_id = ${seeded.aanvraagId}
        ORDER BY created_at ASC, id ASC
      `;
      expect(audits.map((audit) => audit.action)).toEqual([
        ZZP_NEGATION_APPLY_ACTION,
      ]);

      const outbox = await migratorClient<{ eventType: string }[]>`
        SELECT event_type AS "eventType"
        FROM curated.outbox_event
        WHERE aggregate_id = ${seeded.aanvraagId}
      `;
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.eventType).toBe(ZZP_NEGATION_EVENT_TYPE);
    });

    it("refuses to roll back a row something else has since written", async () => {
      const seeded = await seedRow({});
      const applied = await applyZzpNegationLabel({
        database: applicationClient,
        manifest: seeded.manifest,
        manifestSha256: "0".repeat(64),
      });
      await migratorClient`
        UPDATE curated.aanvraag
        SET contracttype = 'interim'
        WHERE id = ${seeded.aanvraagId}
      `;
      const result = await rollbackZzpNegationLabel({
        auditId: applied.auditId ?? "",
        database: applicationClient,
      });
      expect(result.reason).toBe("current_row_mismatch");
      expect(await readContracttype(seeded.aanvraagId)).toBe("interim");
    });

    it("refuses an audit event this tool did not write", async () => {
      const rows = await migratorClient<{ id: string }[]>`
        INSERT INTO curated.audit_event (
          action, actor_id, actor_type, audit_class,
          entity_id, entity_type, metadata, scope_id
        ) VALUES (
          'something_else', 'other-actor', 'service', 'effect',
          ${AANVRAAG_ID}, 'aanvraag', '{}'::jsonb, 'catapulze'
        )
        RETURNING id::text AS id
      `;
      const result = await rollbackZzpNegationLabel({
        auditId: rows[0]?.id ?? "",
        database: applicationClient,
      });
      expect(result.reason).toBe("audit_not_apply");
    });
  });
