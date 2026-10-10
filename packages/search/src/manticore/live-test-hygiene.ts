import { z } from "zod";

import { SEARCH_PARTITIONS, partitionTable } from "../partition";
import type { SearchVersionStore } from "../version";
import {
  DEFAULT_DESCRIBE_TABLE_TIMEOUT_MS,
  describeManticoreTable,
  ManticoreTimeoutError,
} from "./client";
import { ManticoreSearchEngine } from "./engine";
import type { ManticoreSearchEngineOptions } from "./engine";
import { parseManticoreSearchPayload } from "./json";

interface DocumentCleanupEngine {
  deleteDocument: (id: string) => Promise<void>;
}

const MANTICORE_CONFLICT_MESSAGE = /\b409\b|\bconflict\b/iu;
const MANTICORE_DATA_VOLUME = "catapulze-job-intelligence_manticore_data";
const MANTICORE_NO_SUCH_TABLE_MESSAGE = /no such table/iu;

export const LIVE_TEST_REQUIRED_COLUMNS = [
  "beschrijving",
  "bron_id",
  "comparable_tarief",
  "contracttype",
  "document_id",
  "index_version",
  "laatst_gezien_op",
  "locatie",
  "locatie_land",
  "opdrachtgever_naam",
  "opdrachtgever_naam_keyword",
  "projection_hash",
  "provincie",
  "publicatiedatum",
  "skills",
  "sluitingsdatum",
  "status",
  "tarief_eenheid",
  "tarief_max",
  "tarief_min",
  "titel",
  "titel_keyword",
  "uren_per_week_max",
  "uren_per_week_min",
  "werkvorm",
] as const;

export interface LiveTableSchemaReader {
  describeTable: (table: string) => Promise<ReadonlySet<string> | null>;
}

const manticoreDescribePayloadSchema = z.array(
  z.object({
    data: z.array(z.object({ Field: z.string() })).optional(),
  })
);

const parseDescribeFields = (raw: string): ReadonlySet<string> => {
  const parsed = manticoreDescribePayloadSchema.parse(JSON.parse(raw));
  return new Set(parsed[0]?.data?.map(({ Field }) => Field));
};

const describeErrorMessage = (raw: string, statusText: string): string => {
  try {
    return parseManticoreSearchPayload(raw).error ?? statusText;
  } catch {
    return statusText;
  }
};

export const createSqlSchemaReader = (
  baseUrl: string
): LiveTableSchemaReader => ({
  describeTable: async (table: string): Promise<ReadonlySet<string> | null> => {
    const timeoutMs = DEFAULT_DESCRIBE_TABLE_TIMEOUT_MS;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/sql?mode=raw`, {
        body: `query=${encodeURIComponent(`DESCRIBE ${table}`)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const isAbortTimeout =
        error instanceof DOMException && error.name === "TimeoutError";
      if (isAbortTimeout) {
        throw new ManticoreTimeoutError(`${baseUrl}/sql?mode=raw`, timeoutMs);
      }
      throw error;
    }

    const raw = await response.text();
    if (!response.ok) {
      const message = describeErrorMessage(raw, response.statusText);
      if (MANTICORE_NO_SUCH_TABLE_MESSAGE.test(message)) {
        return null;
      }
      throw new Error(
        `Manticore DESCRIBE ${table} failed (${response.status}): ${message}`
      );
    }

    return parseDescribeFields(raw);
  },
});

export const requireLiveManticoreUrl = (
  url: string | undefined,
  required: boolean
): string | undefined => {
  const configured = url?.trim();
  if (!configured && required) {
    throw new Error(
      "MANTICORE_REQUIRE_LIVE=1 requires a non-empty MANTICORE_URL"
    );
  }
  return configured || undefined;
};

/**
 * Live MANTICORE_URL-gated specs must never write production `aanvragen*`
 * tables (RJC-400). Test suites provide a dedicated `aanvragen_test*` index.
 */
export const createLiveTestEngine = (
  baseUrl: string,
  versionStore: SearchVersionStore,
  indexName: string,
  clock: () => Date = () => new Date(),
  options: ManticoreSearchEngineOptions = {}
): ManticoreSearchEngine => {
  if (!indexName.startsWith("aanvragen_test") || indexName === "aanvragen") {
    throw new Error(
      `Live Manticore tests must use an index name starting with "aanvragen_test"; received "${indexName}"`
    );
  }

  return ManticoreSearchEngine.fromUrl(
    baseUrl,
    versionStore,
    indexName,
    clock,
    { ...options, retryReplaceOnConflict: true }
  );
};

/**
 * Preflight for the MANTICORE_URL-gated specs (CTP-604). searchd runs in
 * plain mode and reads tools/manticore/manticore.conf once at process start,
 * and a bind-mounted file's contents are not part of Compose's service
 * config hash, so `docker compose up -d manticore` leaves a container that
 * predates a newly declared table serving the old table set. Probing the
 * tables up front turns that into one failure naming every missing table and
 * the recreate command, instead of per-query `unknown local table(s)` errors
 * buried under the cleanup pass's 409 Conflicts.
 */
export const assertLiveTestTablesReady = async (
  baseUrl: string | undefined,
  indexName: string,
  reader?: LiveTableSchemaReader
): Promise<void> => {
  const configured = baseUrl?.trim();
  if (!configured) {
    throw new Error(
      "assertLiveTestTablesReady requires a live MANTICORE_URL; the live describe should have been skipped"
    );
  }

  const probes = await Promise.all(
    SEARCH_PARTITIONS.map(async (partition) => {
      const table = partitionTable(indexName, partition);
      const { exists } = await describeManticoreTable(configured, table);
      return { exists, table };
    })
  );
  const missing = probes
    .filter((probe) => !probe.exists)
    .map((probe) => probe.table);
  if (missing.length > 0) {
    throw new Error(
      `Live Manticore test table(s) not found in the searchd at ${baseUrl}: ${missing.join(", ")}. searchd reads tools/manticore/manticore.conf once at startup, so a container started before these tables were declared never serves them. Recreate it: docker compose rm -sf manticore && docker compose up -d manticore`
    );
  }

  const schemaReader = reader ?? createSqlSchemaReader(configured);
  const schemaProblems = await Promise.all(
    SEARCH_PARTITIONS.map(async (partition) => {
      const table = partitionTable(indexName, partition);
      const fields = await schemaReader.describeTable(table);
      if (fields === null) {
        return null;
      }

      const missingColumns = LIVE_TEST_REQUIRED_COLUMNS.filter(
        (column) => !fields.has(column)
      );
      if (missingColumns.length === 0) {
        return null;
      }

      return `Live Manticore table "${table}" is missing columns ${missingColumns.join(", ")}: RT tables keep the schema they were created with on the manticore_data volume. Recreate the volume: docker compose rm -sf manticore && docker volume rm ${MANTICORE_DATA_VOLUME} && docker compose up -d manticore`;
    })
  );
  const problems = schemaProblems.filter(
    (problem): problem is string => problem !== null
  );
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
};

/** Best-effort cleanup for live specs: every run-owned id is attempted. */
export const cleanupLiveDocuments = async (
  engine: DocumentCleanupEngine,
  documentIds: readonly string[]
): Promise<void> => {
  const failures: Error[] = [];
  for (const id of documentIds) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- serial cleanup avoids concurrent Manticore partition deletes
      await engine.deleteDocument(id);
    } catch (error) {
      if (
        error instanceof Error &&
        MANTICORE_CONFLICT_MESSAGE.test(error.message)
      ) {
        continue;
      }
      failures.push(
        new Error(`Failed to clean live fixture ${id}`, { cause: error })
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Manticore live fixture cleanup failed");
  }
};
