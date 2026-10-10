import type { JsonValue } from "@ji/application/normalise";
import type {
  MartsColumnInfo,
  MartsQueryResult,
  MartsReader,
  MartsSqlOutcome,
  MartsTableInfo,
} from "@ji/application/registry";
import postgres from "postgres";

/**
 * PostgresMartsReader — read-only analytics port over the `marts` schema
 * (Marktvragen / JI-DSH-07).
 *
 * Two independent layers, deliberately:
 *
 * - {@link guardMartsSql} is a *feedback* layer: it rejects input the agent
 *   cannot possibly mean (multi-statement, non-SELECT verbs, non-marts schema
 *   qualification) with a readable reason so the model can rewrite. It is not
 *   the security boundary.
 * - The execution layer is: every statement runs inside `BEGIN READ ONLY`
 *   with `search_path=marts` and `statement_timeout`, rows stream through a
 *   cursor and stop at `rowCap`. A write-CTE that slips past the text guard
 *   still cannot execute inside a read-only transaction.
 */

export const MARTS_DEFAULT_ROW_CAP = 10_000 as const;
export const MARTS_DEFAULT_STATEMENT_TIMEOUT_MS = 10_000 as const;

const ALLOWED_HEAD = /^\s*(?:select|with|values|table)\b/iu;

/**
 * Words that can never legitimately appear in a read-only analytics query.
 * `INTO` (SELECT INTO creates a table) and locking clauses (`FOR UPDATE`,
 * `FOR KEY SHARE`, …) are rejected here rather than left to the read-only
 * transaction so the agent gets a precise reason back.
 */
const FORBIDDEN_KEYWORDS =
  /\b(?:insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|comment|copy|vacuum|analyze|reindex|cluster|refresh|listen|unlisten|notify|lock|prepare|deallocate|discard|checkpoint|load|do|call|execute|explain|begin|start|commit|rollback|abort|savepoint|release|declare|import|security|set|reset|show|into)\b/iu;

const FORBIDDEN_LOCKING =
  /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/iu;

/** Any non-marts schema qualification is off-limits — the reader owns search_path. */
const FORBIDDEN_QUALIFICATION =
  /\b(?:public|curated|staging|pg_catalog|pg_toast|information_schema)\s*\./iu;

const STRIP_SQL =
  /(?<literal>'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/|\$[a-zA-Z_]*\$[\s\S]*?\$[a-zA-Z_]*\$)/gu;

/**
 * Removes string literals, quoted identifiers and comments so keyword scans
 * cannot be hidden inside them (`'public.users'` as a filter value must not
 * false-positive) nor used to smuggle a second statement past detection.
 */
const stripLiterals = (sql: string): string =>
  sql.replace(STRIP_SQL, (match) =>
    match.startsWith("-") || match.startsWith("/") ? " " : "''"
  );

export type MartsSqlGuardResult =
  | { readonly ok: true; readonly sql: string }
  | { readonly ok: false; readonly reason: string };

export const guardMartsSql = (sql: string): MartsSqlGuardResult => {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "SQL is leeg" };
  }
  const stripped = stripLiterals(trimmed);
  // Exactly one statement: a semicolon may only appear as the final character.
  const withoutTerminator = stripped.replace(/;\s*$/u, "");
  if (withoutTerminator.includes(";")) {
    return {
      ok: false,
      reason: "Meerdere statements zijn niet toegestaan (statement chaining)",
    };
  }
  if (!ALLOWED_HEAD.test(stripped)) {
    return {
      ok: false,
      reason:
        "Alleen read-only SELECT/WITH/VALUES/TABLE statements zijn toegestaan",
    };
  }
  const forbiddenKeyword = FORBIDDEN_KEYWORDS.exec(stripped);
  if (forbiddenKeyword) {
    return {
      ok: false,
      reason: `Statement bevat niet-toegestaan keyword: ${forbiddenKeyword[0].toUpperCase()}`,
    };
  }
  if (FORBIDDEN_LOCKING.test(stripped)) {
    return {
      ok: false,
      reason: "Locking-clausules (FOR UPDATE/SHARE) zijn niet toegestaan",
    };
  }
  const qualification = FORBIDDEN_QUALIFICATION.exec(stripped);
  if (qualification) {
    return {
      ok: false,
      reason: `Schema-kwalificatie '${qualification[0].trim()}' is niet toegestaan; query's draaien in het marts-schema`,
    };
  }
  return { ok: true, sql: withoutTerminator.trim() };
};

/** Postgres error -> agent-safe reason. Never includes stack traces. */
const toSqlReason = (cause: unknown): string => {
  if (cause instanceof Error) {
    // postgres-js exposes err.message without credentials; keep the first line.
    return cause.message.split("\n")[0] ?? "SQL-fout";
  }
  return "SQL-fout";
};

/**
 * SQLSTATE-coded Postgres errors are agent feedback (parse errors, undefined
 * columns, statement_timeout cancels). Everything else — connection loss,
 * pool exhaustion — is infra and propagates so the caller fails closed.
 */
const isSqlStateError = (cause: unknown): boolean =>
  cause instanceof postgres.PostgresError && cause.code.length === 5;

/** Values a postgres-js driver cell can hold after its type parsers ran. */
type DriverCellValue =
  | bigint
  | boolean
  | number
  | string
  | Date
  | null
  | undefined
  | Uint8Array
  | readonly DriverCellValue[]
  | { readonly [key: string]: DriverCellValue };

const isBigIntCell = (cell: DriverCellValue): cell is bigint =>
  // SAFETY: postgres-js yields int8 as primitive bigint; its [[Class]] tag is
  // the only instanceof-free discriminator (project lint forbids typeof).
  Object.prototype.toString.call(cell) === "[object BigInt]";

const toJsonValue = (cell: DriverCellValue): JsonValue => {
  if (cell === null || cell === undefined) {
    return null;
  }
  if (isBigIntCell(cell)) {
    const asNumber = Number(cell);
    return Number.isSafeInteger(asNumber) ? asNumber : cell.toString();
  }
  if (cell instanceof Date) {
    return cell.toISOString();
  }
  if (cell instanceof Uint8Array) {
    return [...cell];
  }
  if (Array.isArray(cell)) {
    return cell.map(toJsonValue);
  }
  if (cell instanceof Object) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(cell)) {
      out[key] = toJsonValue(item);
    }
    return out;
  }
  return cell;
};

export interface PostgresMartsReaderOptions {
  readonly databaseUrl: string;
  readonly rowCap?: number;
  readonly statementTimeoutMs?: number;
}

export interface PostgresMartsReaderHandle {
  readonly close: () => Promise<void>;
  readonly reader: MartsReader;
}

const LIST_TABLES_SQL = `
  SELECT c.table_name AS name, c.column_name AS column_name,
         c.data_type AS data_type, c.is_nullable = 'YES' AS nullable
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.table_schema = 'marts' AND t.table_type = 'BASE TABLE'
  ORDER BY c.table_name, c.ordinal_position
`;

export const createPostgresMartsReader = (
  options: PostgresMartsReaderOptions
): PostgresMartsReaderHandle => {
  const rowCap = options.rowCap ?? MARTS_DEFAULT_ROW_CAP;
  const statementTimeoutMs =
    options.statementTimeoutMs ?? MARTS_DEFAULT_STATEMENT_TIMEOUT_MS;
  const sql = postgres(options.databaseUrl, {
    connect_timeout: 5,
    // All statements run unqualified against marts; the text guard blocks
    // explicit qualification of other schemas.
    connection: { search_path: "marts" },
    idle_timeout: 20,
    max: 4,
    max_lifetime: 30 * 60,
    // The reader never prepares user SQL and reuses no per-connection state.
    prepare: false,
  });

  const explain = async (
    input: string
  ): Promise<MartsSqlOutcome<readonly string[]>> => {
    const guard = guardMartsSql(input);
    if (!guard.ok) {
      return guard;
    }
    try {
      return await sql.begin("read only", async (tx) => {
        const rows = await tx.unsafe(`EXPLAIN (COSTS OFF) ${guard.sql}`);
        const plan = rows.map((row) =>
          String(row["QUERY PLAN"] ?? Object.values(row)[0] ?? "")
        );
        return { ok: true as const, value: plan };
      });
    } catch (error) {
      if (!isSqlStateError(error)) {
        throw error;
      }
      return { ok: false, reason: toSqlReason(error) };
    }
  };

  const query = async (
    input: string
  ): Promise<MartsSqlOutcome<MartsQueryResult>> => {
    const guard = guardMartsSql(input);
    if (!guard.ok) {
      return guard;
    }
    try {
      return await sql.begin("read only", async (tx) => {
        // set_config takes bind parameters where SET does not.
        await tx.unsafe(
          `SELECT set_config('statement_timeout', '${Math.trunc(statementTimeoutMs)}', true), set_config('search_path', 'marts', true)`
        );
        // Cap inside SQL: fetch rowCap+1 so `truncated` is exact, and the
        // subquery wrapper keeps the agent's statement semantically intact
        // (ORDER BY stays inside; only cardinality is bounded).
        const result = await tx.unsafe(
          `SELECT * FROM (${guard.sql}) AS __marts LIMIT ${rowCap + 1}`
        );
        const truncated = result.length > rowCap;
        const rows = result.slice(0, rowCap).map((row) => {
          const normalized: Record<string, JsonValue> = {};
          for (const [key, value] of Object.entries(row)) {
            // SAFETY: Row cells are driver-parser output — always within the
            // DriverCellValue union (scalar, Date, Uint8Array, or jsonb tree).
            normalized[key] = toJsonValue(value as DriverCellValue);
          }
          return normalized;
        });
        const columns =
          result.columns?.map((column) => column.name) ??
          (rows.length > 0 ? Object.keys(rows[0] ?? {}) : []);
        return {
          ok: true as const,
          value: { columns, rows, truncated },
        };
      });
    } catch (error) {
      if (!isSqlStateError(error)) {
        throw error;
      }
      return { ok: false, reason: toSqlReason(error) };
    }
  };

  const listTables = async (): Promise<readonly MartsTableInfo[]> => {
    const rows = await sql.unsafe(LIST_TABLES_SQL);
    const byTable = new Map<string, MartsColumnInfo[]>();
    const order: string[] = [];
    for (const row of rows) {
      let columns = byTable.get(row.name);
      if (!columns) {
        columns = [];
        byTable.set(row.name, columns);
        order.push(row.name);
      }
      columns.push({
        dataType: row.data_type,
        name: row.column_name,
        nullable: row.nullable,
      });
    }
    return order.map((name) => ({
      columns: byTable.get(name) ?? [],
      name,
    }));
  };

  return {
    close: () => sql.end({ timeout: 5 }),
    reader: { explain, listTables, query },
  };
};
