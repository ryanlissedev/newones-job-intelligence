import { describe, expect, it } from "bun:test";

import type postgres from "postgres";

import { curateObservation } from "../identity/curate";
import { InMemoryCurateStore } from "../identity/store";
import type { JsonValue } from "../normalise";
import {
  createMotianNeonV1Source,
  decodeMotianV1RawRow,
} from "./motian-neon-v1-source";
import { mapV1JobToDraft } from "./neon-v1";

interface MotianPrivileges {
  can_delete_jobs: boolean | null;
  can_insert_jobs: boolean | null;
  can_insert_jobs_columns: boolean | null;
  can_select_jobs: boolean | null;
  can_truncate_jobs: boolean | null;
  can_update_jobs: boolean | null;
  can_update_jobs_columns: boolean | null;
}

interface FakeMotianSqlClient {
  readonly beginOptions: string[];
  readonly events: string[];
  readonly jobParameters: readonly (readonly unknown[])[];
  readonly jobStatements: string[];
  readonly sql: postgres.Sql;
  endCalls: () => number;
  rootQueryCalls: () => number;
}

type FakeTransactionSql = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => Promise<readonly object[]>;

class FakeSqlFragment {
  readonly strings: TemplateStringsArray;
  readonly values: readonly unknown[];

  constructor(strings: TemplateStringsArray, values: readonly unknown[]) {
    this.strings = strings;
    this.values = values;
  }
}

interface RenderedQuery {
  readonly parameters: readonly unknown[];
  readonly statement: string;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- test SQL interpolation accepts the postgres.js value boundary.
const isFakeSqlFragment = (value: unknown): value is FakeSqlFragment =>
  value instanceof FakeSqlFragment;

const renderQuery = (
  strings: TemplateStringsArray,
  values: readonly unknown[]
): RenderedQuery => {
  const parameters: unknown[] = [];
  let statement = strings[0] ?? "";
  for (const [index, value] of values.entries()) {
    if (isFakeSqlFragment(value)) {
      const rendered = renderQuery(value.strings, value.values);
      statement += rendered.statement;
      parameters.push(...rendered.parameters);
    } else {
      statement += "?";
      parameters.push(value);
    }
    statement += strings[index + 1] ?? "";
  }
  return {
    parameters,
    statement: statement.replaceAll(/\s+/gu, " ").trim(),
  };
};

interface FakeSql {
  (
    strings?: TemplateStringsArray,
    ...values: readonly unknown[]
  ): FakeSqlFragment | Promise<never>;
  begin: <T>(
    options: string,
    callback: (readOnlySql: postgres.TransactionSql) => Promise<T>
  ) => Promise<T>;
  end: () => Promise<void>;
}

const readOnlyPrivileges = (): MotianPrivileges => ({
  can_delete_jobs: false,
  can_insert_jobs: false,
  can_insert_jobs_columns: false,
  can_select_jobs: true,
  can_truncate_jobs: false,
  can_update_jobs: false,
  can_update_jobs_columns: false,
});

const motianJobRow = (id: string) => ({
  application_deadline: null,
  archived_at: null,
  company: null,
  contract_type: null,
  deleted_at: null,
  description: null,
  end_client: null,
  external_id: `external-${id}`,
  external_url: null,
  id,
  location: null,
  platform: "werkzoeken",
  posted_at: null,
  province: null,
  rate_max: null,
  rate_min: null,
  scraped_at: null,
  source_row: { id },
  start_date: null,
  status: "open",
  title: `Job ${id}`,
});

type RawMotianV1Row = Record<string, JsonValue>;

const rawMotianV1Row = (overrides: Partial<RawMotianV1Row> = {}) =>
  ({
    application_deadline: null,
    archived_at: null,
    company: "Broker BV",
    contract_type: "detachering",
    deleted_at: null,
    description: "Historical platform engineer assignment.",
    end_client: "Ministry",
    external_id: "external-raw-1",
    external_url: "https://example.com/jobs/external-raw-1",
    id: "00000000-0000-4000-8000-000000000004",
    location: "Utrecht",
    platform: "nationalevacaturebank",
    posted_at: null,
    province: "Utrecht",
    rate_max: 120,
    rate_min: 90,
    scraped_at: null,
    start_date: null,
    status: "open",
    title: "Platform engineer Azure",
    ...overrides,
  }) satisfies RawMotianV1Row;

const encodeRawMotianV1Row = (row: RawMotianV1Row): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(row));

const asTransactionSql = (value: FakeTransactionSql): postgres.TransactionSql =>
  // SAFETY: the fake only receives tagged queries from the Motian source test.
  value as postgres.TransactionSql;

const asSql = (value: FakeSql | postgres.Sql): postgres.Sql =>
  // SAFETY: the fake implements the begin/end methods used by the source.
  value as postgres.Sql;

const createFakeMotianSqlClient = (
  input: {
    readonly endHeartbeatFails?: boolean;
    readonly jobBatches?: readonly (readonly object[])[];
    readonly privileges?: Partial<MotianPrivileges>;
    readonly transactionReadOnly?: string;
  } = {}
): FakeMotianSqlClient => {
  const beginOptions: string[] = [];
  const events: string[] = [];
  const jobParameters: (readonly unknown[])[] = [];
  const jobStatements: string[] = [];
  let endCalls = 0;
  let rootQueryCalls = 0;
  let jobBatchIndex = 0;
  const privileges = { ...readOnlyPrivileges(), ...input.privileges };
  const transactionReadOnly = input.transactionReadOnly ?? "on";

  const transactionQuery = (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly object[]> => {
    const { parameters, statement } = renderQuery(strings, values);
    if (statement.startsWith("SHOW transaction_read_only")) {
      events.push("transaction-state");
      return Promise.resolve([{ transaction_read_only: transactionReadOnly }]);
    }
    if (statement.includes("has_table_privilege")) {
      events.push("privileges");
      return Promise.resolve([privileges]);
    }
    if (statement.startsWith("SELECT transaction_timestamp()")) {
      events.push("snapshot-start");
      return Promise.resolve([
        { snapshot_started_at: "2026-09-02T10:00:00.000Z" },
      ]);
    }
    if (statement.startsWith("SELECT clock_timestamp()")) {
      events.push("snapshot-end");
      return input.endHeartbeatFails
        ? Promise.reject(new Error("source snapshot connection lost"))
        : Promise.resolve([
            { snapshot_completed_at: "2026-09-02T10:05:00.000Z" },
          ]);
    }
    if (statement.includes("FROM jobs")) {
      events.push("jobs");
      jobParameters.push(parameters);
      jobStatements.push(statement);
      const batch = input.jobBatches?.[jobBatchIndex] ?? [];
      jobBatchIndex += 1;
      return Promise.resolve(batch);
    }
    return Promise.reject(new Error(`Unexpected Motian query: ${statement}`));
  };
  const transaction = asTransactionSql(transactionQuery);
  const rootQuery = (
    strings?: TemplateStringsArray,
    ...values: readonly unknown[]
  ): FakeSqlFragment | Promise<never> => {
    if (strings) {
      return new FakeSqlFragment(strings, values);
    }
    rootQueryCalls += 1;
    return Promise.reject(
      new Error("Motian query escaped its read-only transaction")
    );
  };
  /* oxlint-disable promise/prefer-await-to-callbacks -- postgres.js reserves a transaction session through this callback API. */
  const fakeSql: FakeSql = Object.assign(rootQuery, {
    begin: async <T>(
      options: string,
      callback: (readOnlySql: postgres.TransactionSql) => Promise<T>
    ): Promise<T> => {
      beginOptions.push(options);
      return await callback(transaction);
    },
    end: (): Promise<void> => {
      endCalls += 1;
      return Promise.resolve();
    },
  });
  /* oxlint-enable promise/prefer-await-to-callbacks */
  const sql = asSql(fakeSql);

  return {
    beginOptions,
    endCalls: () => endCalls,
    events,
    jobParameters,
    jobStatements,
    rootQueryCalls: () => rootQueryCalls,
    sql,
  };
};

const sourceWithClient = (
  client: FakeMotianSqlClient,
  databaseUrl: string,
  factoryUrls: string[]
) =>
  createMotianNeonV1Source(
    { databaseUrl },
    {
      createSqlClient: (url) => {
        factoryUrls.push(url);
        return client.sql;
      },
    }
  );

describe("Motian Neon v1 raw decoding", () => {
  it("keeps only exact historical fields and drops nested or unrelated values", () => {
    const decoded = decodeMotianV1RawRow(
      encodeRawMotianV1Row(
        rawMotianV1Row({
          durationMonths: 99,
          duration_months: 6,
          endDate: "2099-01-01T00:00:00.000Z",
          end_date: "2027-03-31T00:00:00.000Z",
          hoursPerWeek: 99,
          hours_per_week: 40,
          minHoursPerWeek: 99,
          min_hours_per_week: 32,
          raw_payload: {
            duration_months: 99,
            end_date: "2099-01-01T00:00:00.000Z",
            hours_per_week: 99,
            min_hours_per_week: 99,
            work_arrangement: "remote",
          },
          unrelated_field: "ignored",
          workArrangement: "remote",
          work_arrangement: "hybride",
        })
      )
    );

    expect(decoded.sourceRow).toEqual({
      duration_months: 6,
      end_date: "2027-03-31T00:00:00.000Z",
      hours_per_week: 40,
      min_hours_per_week: 32,
      work_arrangement: "hybride",
    });
  });

  it("decodes the bounded parity fields with native null and zero semantics", () => {
    const decoded = decodeMotianV1RawRow(
      encodeRawMotianV1Row(
        rawMotianV1Row({
          allows_subcontracting: false,
          application_deadline: null,
          competences: [{ name: "TypeScript" }],
          end_date: null,
          extension_possible: true,
          hours_per_week: 0,
          min_hours_per_week: 0,
          positions_available: 0,
          posted_at: "2026-08-31T08:00:00.000Z",
          requirements: { education: ["HBO"], security: null },
          start_date: null,
          wishes: ["Azure"],
          work_arrangement: "remote",
          work_experience_years: 0,
        })
      )
    );

    expect(decoded).toMatchObject({
      allows_subcontracting: false,
      application_deadline: null,
      competences: [{ name: "TypeScript" }],
      end_date: null,
      extension_possible: true,
      hours_per_week: 0,
      min_hours_per_week: 0,
      positions_available: 0,
      posted_at: "2026-08-31T08:00:00.000Z",
      requirements: { education: ["HBO"], security: null },
      start_date: null,
      wishes: ["Azure"],
      work_arrangement: "remote",
      work_experience_years: 0,
    });

    const specific = mapV1JobToDraft(decoded).bronSpecifiek.value;
    expect(specific).toMatchObject({
      allows_subcontracting: false,
      application_deadline: null,
      competences: [{ name: "TypeScript" }],
      end_date: null,
      extension_possible: true,
      hours_per_week: 0,
      min_hours_per_week: 0,
      positions_available: 0,
      posted_at: "2026-08-31T08:00:00.000Z",
      requirements: { education: ["HBO"], security: null },
      start_date: null,
      wishes: ["Azure"],
      work_arrangement: "remote",
      work_experience_years: 0,
    });
  });

  it("drops an invalid optional end date without rejecting valid siblings", () => {
    const decoded = decodeMotianV1RawRow(
      encodeRawMotianV1Row(
        rawMotianV1Row({
          company: "Broker BV",
          end_date: "not-a-date",
          hours_per_week: 40,
        })
      )
    );

    expect(decoded).toMatchObject({
      company: "Broker BV",
      end_date: null,
      hours_per_week: 40,
    });
    const specific = mapV1JobToDraft(decoded).bronSpecifiek.value;
    expect(specific).toMatchObject({
      company: "Broker BV",
      eind_datum: null,
      end_date: null,
      hours_per_week: 40,
    });
  });

  it("turns malformed optional historical values into null independently", () => {
    const decoded = decodeMotianV1RawRow(
      encodeRawMotianV1Row(
        rawMotianV1Row({
          duration_months: "6",
          end_date: 2027,
          hours_per_week: "40",
          min_hours_per_week: -32,
          work_arrangement: { value: "hybride" },
        })
      )
    );

    expect(decoded.sourceRow).toEqual({
      duration_months: null,
      end_date: null,
      hours_per_week: null,
      min_hours_per_week: null,
      work_arrangement: null,
    });
  });

  it("carries decoded hours, end date, and work arrangement through curation", async () => {
    const decoded = decodeMotianV1RawRow(
      encodeRawMotianV1Row(
        rawMotianV1Row({
          end_date: "2027-03-31T00:00:00.000Z",
          hours_per_week: 40,
          min_hours_per_week: 32,
          work_arrangement: "hybride",
        })
      )
    );
    const draft = mapV1JobToDraft(decoded);
    const store = new InMemoryCurateStore();

    const result = await curateObservation(store, {
      bronId: "00000000-0000-4000-8000-000000000031",
      draft,
      observedAt: new Date("2026-09-10T12:00:00.000Z"),
      rawPayloadRef: "raw/motian/external-raw-1.json",
      scrapeRunId: "run-motian-raw-test",
    });

    expect(result.status).toBe("curated");
    const [record] = store.aanvragen;
    if (!record) {
      throw new Error("Expected curated aanvraag record");
    }
    expect(record).toMatchObject({
      eindDatum: "2027-03-31T00:00:00.000Z",
      urenPerWeek: "32–40",
      werkvorm: "hybride",
    });
    expect(record.bronSpecifiek).toMatchObject({
      eind_datum: "2027-03-31T00:00:00.000Z",
      uren_per_week: "32–40",
      werkvorm: "hybride",
    });
  });
});

describe("Motian Neon v1 source access", () => {
  it("uses the explicit URL and reads on the verified transaction session", async () => {
    const previousDatabaseUrl = process.env.MOTIAN_DATABASE_URL;
    process.env.MOTIAN_DATABASE_URL = "postgresql://ambient@motian.example/v1";
    const client = createFakeMotianSqlClient();
    const factoryUrls: string[] = [];
    const explicitUrl =
      "postgresql://admin-write-owner@explicit-motian.example/v1";

    try {
      const source = sourceWithClient(client, explicitUrl, factoryUrls);

      await expect(source.loadJobs()).resolves.toEqual([]);
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.MOTIAN_DATABASE_URL;
      } else {
        process.env.MOTIAN_DATABASE_URL = previousDatabaseUrl;
      }
    }

    expect(factoryUrls).toEqual([explicitUrl]);
    expect(client.beginOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
    expect(client.events).toEqual([
      "transaction-state",
      "privileges",
      "snapshot-start",
      "jobs",
      "snapshot-end",
    ]);
    expect(client.rootQueryCalls()).toBe(0);
    expect(client.endCalls()).toBe(1);
  });

  it("fails closed when the transaction is not read-only", async () => {
    const client = createFakeMotianSqlClient({ transactionReadOnly: "off" });
    const source = sourceWithClient(
      client,
      "postgresql://readonly@motian.example/v1",
      []
    );

    await expect(source.loadJobs()).rejects.toThrow(
      "Motian source transaction must be read-only"
    );

    expect(client.events).toEqual(["transaction-state"]);
    expect(client.endCalls()).toBe(1);
  });

  it("fails closed when the role cannot select jobs", async () => {
    const client = createFakeMotianSqlClient({
      privileges: { can_select_jobs: false },
    });
    const source = sourceWithClient(
      client,
      "postgresql://readonly@motian.example/v1",
      []
    );

    await expect(source.loadJobs()).rejects.toThrow(
      "Motian source role must have SELECT privilege on jobs"
    );

    expect(client.events).toEqual(["transaction-state", "privileges"]);
    expect(client.endCalls()).toBe(1);
  });

  for (const [key, privilege] of [
    ["can_insert_jobs", "INSERT"],
    ["can_insert_jobs_columns", "column INSERT"],
    ["can_update_jobs", "UPDATE"],
    ["can_update_jobs_columns", "column UPDATE"],
    ["can_delete_jobs", "DELETE"],
    ["can_truncate_jobs", "TRUNCATE"],
  ] as const) {
    it(`fails closed when the source role has ${privilege} on jobs`, async () => {
      const client = createFakeMotianSqlClient({
        privileges: { [key]: true },
      });
      const source = sourceWithClient(
        client,
        "postgresql://readonly@motian.example/v1",
        []
      );

      await expect(source.loadJobs()).rejects.toThrow(
        `Motian source role must not have ${privilege} privilege on jobs`
      );

      expect(client.events).toEqual(["transaction-state", "privileges"]);
      expect(client.endCalls()).toBe(1);
    });
  }

  it("fails closed when a write privilege check returns null", async () => {
    const client = createFakeMotianSqlClient({
      privileges: { can_update_jobs_columns: null },
    });
    const source = sourceWithClient(
      client,
      "postgresql://readonly@motian.example/v1",
      []
    );

    await expect(source.loadJobs()).rejects.toThrow(
      "Motian source role must not have column UPDATE privilege on jobs"
    );
  });

  it("walks every keyset batch inside one repeatable-read snapshot", async () => {
    const client = createFakeMotianSqlClient({
      jobBatches: [
        [motianJobRow("00000000-0000-0000-0000-000000000001")],
        [motianJobRow("00000000-0000-0000-0000-000000000002")],
        [],
      ],
    });
    const source = createMotianNeonV1Source(
      {
        batchSize: 1,
        databaseUrl: "postgresql://readonly@motian.example/v1",
      },
      { createSqlClient: () => client.sql }
    );

    const jobs = await source.loadJobs();

    expect(jobs.map((job) => job.id)).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(
      client.jobParameters.map((parameters) => parameters.slice(1))
    ).toEqual([
      [1],
      ["00000000-0000-0000-0000-000000000001", 1],
      ["00000000-0000-0000-0000-000000000002", 1],
    ]);
    expect(client.jobParameters[0]).not.toContain("");
    expect(client.jobStatements[0]).not.toContain("AND id >");
    expect(client.jobStatements[1]).toContain("AND id > ?");
    expect(client.jobStatements[2]).toContain("AND id > ?");
    expect(client.beginOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
    expect(client.events).toEqual([
      "transaction-state",
      "privileges",
      "snapshot-start",
      "jobs",
      "jobs",
      "jobs",
      "snapshot-end",
    ]);
  });

  it("selects and maps the real Motian timestamp columns in every scope", async () => {
    const scopes = [
      { scope: "full" as const },
      { includeClosed: true, scope: "active" as const },
      { scope: "active" as const },
    ];

    await Promise.all(
      scopes.map(async (options) => {
        const row = {
          ...motianJobRow("00000000-0000-0000-0000-000000000003"),
          allows_subcontracting: false,
          application_deadline: "2026-09-10 12:00:00",
          competences: [{ name: "TypeScript" }],
          end_date: "2027-03-31 00:00:00",
          extension_possible: true,
          hours_per_week: 40,
          min_hours_per_week: 32,
          positions_available: 2,
          posted_at: "2026-08-31 08:00:00",
          requirements: { education: ["HBO"] },
          scraped_at: "2026-09-03 09:00:00",
          start_date: "2026-10-01 00:00:00",
          wishes: ["Azure"],
          work_arrangement: "remote",
          work_experience_years: 5,
        };
        const client = createFakeMotianSqlClient({ jobBatches: [[row]] });
        const source = createMotianNeonV1Source(
          {
            ...options,
            databaseUrl: "postgresql://readonly@motian.example/v1",
          },
          { createSqlClient: () => client.sql }
        );

        const jobs = await source.loadJobs();
        const [statement] = client.jobStatements;
        const [parameters] = client.jobParameters;

        expect(jobs[0]).toMatchObject({
          allows_subcontracting: false,
          application_deadline: "2026-09-10T12:00:00.000Z",
          competences: [{ name: "TypeScript" }],
          end_date: "2027-03-31T00:00:00.000Z",
          extension_possible: true,
          hours_per_week: 40,
          min_hours_per_week: 32,
          positions_available: 2,
          posted_at: "2026-08-31T08:00:00.000Z",
          requirements: { education: ["HBO"] },
          scraped_at: "2026-09-03T09:00:00.000Z",
          start_date: "2026-10-01T00:00:00.000Z",
          wishes: ["Azure"],
          work_arrangement: "remote",
          work_experience_years: 5,
        });
        expect(statement).toContain(
          "application_deadline::text AS application_deadline"
        );
        expect(statement).toContain("start_date::text AS start_date");
        expect(statement).toContain("posted_at::text AS posted_at");
        expect(statement).toContain("scraped_at::text AS scraped_at");
        expect(statement).toContain("work_arrangement");
        expect(statement).toContain("hours_per_week");
        expect(statement).toContain("min_hours_per_week");
        expect(statement).toContain("requirements");
        expect(statement).toContain("wishes");
        expect(statement).toContain("competences");
        expect(statement).toContain("positions_available");
        expect(statement).toContain("work_experience_years");
        expect(statement).toContain("allows_subcontracting");
        expect(statement).toContain("extension_possible");
        expect(statement).toContain("end_date::text AS end_date");
        expect(statement).not.toContain("COLLATE");
        expect(statement).not.toContain("AND id >");
        expect(statement).toContain("ORDER BY id ASC");
        expect(parameters).not.toContain("");
        expect(statement).not.toContain("created_at");
        expect(statement).not.toContain("::uuid");
        expect(statement).not.toContain("updated_at");
      })
    );
  });

  it("keeps complete source evidence immutable while normalizing projected dates", async () => {
    const row = {
      ...motianJobRow("00000000-0000-0000-0000-000000000005"),
      end_date: "not-a-date",
      hours_per_week: 40,
      source_row: {
        end_date: "not-a-date",
        hours_per_week: 40,
      },
    };
    const client = createFakeMotianSqlClient({ jobBatches: [[row]] });
    const source = sourceWithClient(
      client,
      "postgresql://readonly@motian.example/v1",
      []
    );

    const [job] = await source.loadJobs();

    expect(job).toMatchObject({
      end_date: null,
      hours_per_week: 40,
    });
    expect(job?.sourceRow).toEqual({
      end_date: "not-a-date",
      hours_per_week: 40,
    });
  });

  it("fails closed when the source snapshot end heartbeat is lost", async () => {
    const client = createFakeMotianSqlClient({ endHeartbeatFails: true });
    const source = sourceWithClient(
      client,
      "postgresql://readonly@motian.example/v1",
      []
    );

    await expect(source.loadJobs()).rejects.toThrow(
      "source snapshot connection lost"
    );

    expect(client.events).toEqual([
      "transaction-state",
      "privileges",
      "snapshot-start",
      "jobs",
      "snapshot-end",
    ]);
    expect(client.endCalls()).toBe(1);
  });
});
