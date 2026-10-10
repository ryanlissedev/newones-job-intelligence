import type {
  MartsQueryResult,
  MartsReader,
  MartsSqlOutcome,
  MartsTableInfo,
} from "../types";

/**
 * In-memory MartsReader for handler/registry tests. It applies the same
 * minimal head/single-statement rules as the real text guard — enough for
 * contract tests without depending on @ji/db. The Postgres guard's full
 * keyword/qualification matrix is covered by marts-reader.spec.ts in @ji/db.
 */
const HEAD = /^\s*(?:select|with|values|table)\b/iu;

const guardHead = (sql: string): MartsSqlOutcome<string> => {
  const trimmed = sql.trim();
  if (!HEAD.test(trimmed)) {
    return { ok: false, reason: "Alleen SELECT is toegestaan" };
  }
  return { ok: true, value: trimmed };
};

export class MemoryMartsReader implements MartsReader {
  private tables: MartsTableInfo[] = [];
  private results = new Map<string, MartsQueryResult>();

  seedTable(table: MartsTableInfo): void {
    this.tables.push(table);
  }

  /** Keyed by exact SQL — tests assert the handler passes the statement through verbatim. */
  seedResult(sql: string, result: MartsQueryResult): void {
    this.results.set(sql, result);
  }

  // oxlint-disable-next-line eslint/class-methods-use-this -- the MartsReader port requires an instance method; the fake keeps no plan state.
  explain(sql: string): Promise<MartsSqlOutcome<readonly string[]>> {
    const guard = guardHead(sql);
    if (!guard.ok) {
      return Promise.resolve(guard);
    }
    return Promise.resolve({ ok: true, value: [`Seq Scan on ${guard.value}`] });
  }

  listTables(): Promise<readonly MartsTableInfo[]> {
    return Promise.resolve(this.tables);
  }

  query(sql: string): Promise<MartsSqlOutcome<MartsQueryResult>> {
    const guard = guardHead(sql);
    if (!guard.ok) {
      return Promise.resolve(guard);
    }
    const result = this.results.get(sql) ??
      this.results.get(sql.trim()) ?? {
        columns: [],
        rows: [],
        truncated: false,
      };
    return Promise.resolve({ ok: true, value: result });
  }
}
