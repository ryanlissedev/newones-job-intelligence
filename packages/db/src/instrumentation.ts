import {
  createCriticalPathSession,
  currentCriticalPathSession,
  digestQueryIdentity,
  isCriticalPathEnabled,
  monotonicNowMs,
  timeCriticalPathPhase,
} from "@ji/performance";
import type { Sql } from "postgres";

export interface TimedSqlOptions {
  queryIdentity: string;
}

export const timeSqlQuery = <Result>(
  options: TimedSqlOptions,
  operation: () => Promise<Result>
): Promise<Result> => {
  if (!isCriticalPathEnabled()) {
    return operation();
  }

  const poolWaitStarted = monotonicNowMs();
  return timeCriticalPathPhase("db-query", () => {
    currentCriticalPathSession()?.recordSample({
      durationMs: Math.round(monotonicNowMs() - poolWaitStarted),
      endedAt: new Date().toISOString(),
      label: "db-poolwait",
      startedAt: new Date().toISOString(),
      success: true,
    });
    currentCriticalPathSession()?.mergeMetadata({
      "query-identity": digestQueryIdentity(options.queryIdentity),
    });
    return timeCriticalPathPhase("db-transaction", operation);
  });
};

export interface PgStatStatementSummary {
  calls: number;
  meanExecMs: number;
  queryIdentity: string;
  totalExecMs: number;
}

/** Reads pg_stat_statements using queryid digests only — never query text. */
export const readPgStatStatementSummaries = async (
  sql: Sql
): Promise<PgStatStatementSummary[]> => {
  if (process.env.PERF_PG_STATEMENTS !== "1") {
    return [];
  }

  const rows = await sql<
    {
      calls: string;
      mean_exec_time: number;
      queryid: string;
      total_exec_time: number;
    }[]
  >`
    SELECT
      queryid::text AS queryid,
      calls::text AS calls,
      total_exec_time,
      mean_exec_time
    FROM pg_stat_statements
    ORDER BY total_exec_time DESC
    LIMIT 20
  `;

  return rows.map((row) => ({
    calls: Number(row.calls),
    meanExecMs: row.mean_exec_time,
    queryIdentity: digestQueryIdentity(row.queryid),
    totalExecMs: row.total_exec_time,
  }));
};

export const emitPgStatStatementRecords = async (sql: Sql): Promise<void> => {
  if (!isCriticalPathEnabled()) {
    return;
  }

  const summaries = await readPgStatStatementSummaries(sql);
  if (summaries.length === 0) {
    return;
  }

  const session = createCriticalPathSession();
  for (const summary of summaries) {
    session.recordSample({
      durationMs: Math.round(summary.meanExecMs),
      endedAt: new Date().toISOString(),
      label: "db-locks",
      startedAt: new Date().toISOString(),
      success: true,
    });
    session.mergeMetadata({
      "query-identity": summary.queryIdentity,
    });
  }
  await session.flush();
};
