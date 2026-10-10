/**
 * Operator reconciliation for Postgres projection state versus real Manticore
 * contents (docs/runbooks/projection-repair.md).
 *
 *   MANTICORE_URL=http://127.0.0.1:9308 bun run search:reconcile-projection
 *   MANTICORE_URL=http://127.0.0.1:9308 bun run search:reconcile-projection --apply --projector-quiesced
 *
 * The default is report-only. `--apply` invalidates only proven bad current
 * projection state and emits durable repair/delete events. Physical rows that
 * cannot be reached by normal projector deletes are compare-and-deleted by
 * their complete observed fingerprint.
 */
import {
  closeDb,
  db,
  manticoreIdsForBoundedLookup,
  PostgresSearchDocumentLoader,
  PostgresSearchVersionStore,
  ProjectionRepairGenerationChangedError,
  ProjectionRepairInventorySafetyError,
  ProjectionRepairSchemaMismatchError,
  reconcileProjection,
} from "@ji/db";
import type {
  SearchProjectionInventoryPort,
  SearchProjectionInventoryRecord,
} from "@ji/db";
import { partitionTable, SEARCH_INDEX_NAME } from "@ji/search";
import type { SearchPartition } from "@ji/search";
import { z } from "zod";

import { hasProjectionDrift } from "./reconcile-projection-status";

const apply = process.argv.includes("--apply");
const failOnDrift = process.argv.includes("--fail-on-drift");
const projectorQuiesced = process.argv.includes("--projector-quiesced");
const MANTICORE_TIMEOUT_MS = 10_000;

const manticoreIntegerSchema = z.union([
  z.number().int().nonnegative().safe(),
  z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().nonnegative().safe()),
]);

const manticoreCountRowSchema = z.object({
  count: manticoreIntegerSchema.optional(),
  "count(*)": manticoreIntegerSchema.optional(),
});

const manticoreDocumentRowSchema = z.object({
  document_id: z.string(),
  id: manticoreIntegerSchema,
  projection_hash: z.string(),
});

const manticoreSqlEnvelopeSchema = z.object({
  data: z.array(z.unknown()).optional(),
  error: z.string().optional(),
  total: manticoreIntegerSchema.optional(),
});

const manticoreSqlResponseSchema = z.array(manticoreSqlEnvelopeSchema).min(1);
const manticoreUrlSchema = z.url();

const quoteManticoreString = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const parseManticoreSqlResponse = (
  raw: string,
  requireData = true
): readonly unknown[] => {
  const parsed: unknown = JSON.parse(raw);
  const response = manticoreSqlResponseSchema.safeParse(parsed);
  if (!response.success) {
    throw new Error("Manticore SQL response did not contain a result envelope");
  }
  const [envelope] = response.data;
  if (!envelope) {
    throw new Error("Manticore SQL response did not contain a result envelope");
  }
  if (envelope.error?.length) {
    throw new Error(`Manticore SQL error: ${envelope.error}`);
  }
  if (requireData && !envelope.data) {
    throw new Error("Manticore SQL response did not contain row data");
  }
  return envelope.data ?? [];
};

/** Minimal bounded raw-SQL inventory and observed-fingerprint cleanup adapter. */
class ManticoreInventory implements SearchProjectionInventoryPort {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/u, "");
  }

  async count(partition: SearchPartition): Promise<number> {
    const table = partitionTable(SEARCH_INDEX_NAME, partition);
    const [row] = await this.query(`SELECT COUNT(*) AS count FROM ${table}`);
    if (!row) {
      throw new Error(`Manticore ${table} count returned no row`);
    }
    const parsed = manticoreCountRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`Manticore ${table} count returned an invalid row`);
    }
    const count = parsed.data.count ?? parsed.data["count(*)"];
    if (count === undefined) {
      throw new Error(`Manticore ${table} count returned no count`);
    }
    return count;
  }

  async findByDocumentIds(
    partition: SearchPartition,
    documentIds: readonly string[],
    limit: number
  ): Promise<readonly SearchProjectionInventoryRecord[]> {
    if (documentIds.length === 0) {
      return [];
    }
    const table = partitionTable(SEARCH_INDEX_NAME, partition);
    const values = manticoreIdsForBoundedLookup(documentIds).join(", ");
    return ManticoreInventory.toInventoryRows(
      await this.query(
        `SELECT id, document_id, projection_hash FROM ${table} WHERE id IN (${values}) ORDER BY id ASC LIMIT ${limit}`
      ),
      table
    );
  }

  async listPage(
    partition: SearchPartition,
    afterManticoreId: number | null,
    limit: number
  ): Promise<readonly SearchProjectionInventoryRecord[]> {
    const table = partitionTable(SEARCH_INDEX_NAME, partition);
    const after =
      afterManticoreId === null ? "" : ` WHERE id > ${afterManticoreId}`;
    return ManticoreInventory.toInventoryRows(
      await this.query(
        `SELECT id, document_id, projection_hash FROM ${table}${after} ORDER BY id ASC LIMIT ${limit}`
      ),
      table
    );
  }

  async deleteObservedRows(
    partition: SearchPartition,
    rows: readonly SearchProjectionInventoryRecord[]
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const table = partitionTable(SEARCH_INDEX_NAME, partition);
    let deleted = 0;
    /* oxlint-disable no-await-in-loop -- each compare-and-delete keeps its own affected-row count */
    for (const row of rows) {
      deleted += await this.execute(
        `DELETE FROM ${table} WHERE id = ${row.manticoreId} AND document_id = ${quoteManticoreString(row.documentId)} AND projection_hash = ${quoteManticoreString(row.projectionHash)}`
      );
    }
    /* oxlint-enable no-await-in-loop */
    return deleted;
  }

  private async query(query: string): Promise<readonly unknown[]> {
    return parseManticoreSqlResponse(await this.request(query), true);
  }

  private async execute(query: string): Promise<number> {
    const parsed: unknown = JSON.parse(await this.request(query));
    const response = manticoreSqlResponseSchema.safeParse(parsed);
    const envelope = response.success ? response.data[0] : undefined;
    if (!envelope || envelope.error?.length || envelope.total === undefined) {
      throw new Error(
        "Manticore SQL delete did not return an affected-row count"
      );
    }
    return envelope.total;
  }

  private async request(query: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/sql?mode=raw`, {
        body: `query=${encodeURIComponent(query)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        signal: AbortSignal.timeout(MANTICORE_TIMEOUT_MS),
      });
    } catch (error) {
      const timeout =
        error instanceof DOMException && error.name === "TimeoutError";
      if (timeout) {
        throw new Error(
          `Manticore SQL request timed out after ${MANTICORE_TIMEOUT_MS}ms`,
          { cause: error }
        );
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(
        `Manticore SQL request failed (${response.status}): ${response.statusText}`
      );
    }
    return response.text();
  }

  private static toInventoryRows(
    rows: readonly unknown[],
    table: string
  ): SearchProjectionInventoryRecord[] {
    return rows.map((row) => {
      const parsed = manticoreDocumentRowSchema.safeParse(row);
      if (!parsed.success) {
        throw new Error(`Manticore ${table} inventory row is invalid`);
      }
      return {
        documentId: parsed.data.document_id,
        manticoreId: parsed.data.id,
        projectionHash: parsed.data.projection_hash,
      };
    });
  }
}

try {
  if (apply && !projectorQuiesced) {
    throw new Error(
      "--apply requires --projector-quiesced after stopping the projector and waiting for any in-flight drain to finish."
    );
  }
  const manticoreUrl = manticoreUrlSchema.safeParse(process.env.MANTICORE_URL);
  if (!manticoreUrl.success) {
    throw new Error(
      "MANTICORE_URL is required for actual Manticore reconciliation; no DB-only verdict is emitted."
    );
  }
  const result = await reconcileProjection({
    apply,
    database: db,
    inventory: new ManticoreInventory(manticoreUrl.data),
    loader: new PostgresSearchDocumentLoader(db),
    versionStore: new PostgresSearchVersionStore(db),
  });
  const mode = apply ? "repair" : "dry run";
  const activeInventoryCount = result.inventoryCounts?.active ?? 0;
  const archiveInventoryCount = result.inventoryCounts?.archive ?? 0;
  console.log(
    `${mode} against generation ${result.generation}: ` +
      `${result.checked} curated aanvragen checked; Manticore active=${activeInventoryCount}, ` +
      `archive=${archiveInventoryCount}; ${result.divergentCount} divergent, ` +
      `${result.orphanManticoreCount} valid orphan(s), ${result.invalidDocumentIdCount} invalid engine id(s), ` +
      `${result.physicalCorruptionCount} corrupt physical row(s), ${result.physicalCleanupCount} physically deleted, ` +
      `${result.staleManticoreHashCount} stale physical hash(es), ${result.skippedPending} already covered by a pending outbox event, ` +
      `${result.applied} durable event(s) inserted.`
  );
  for (const entry of result.divergent) {
    console.log(
      `  ${entry.aggregateId}  ${entry.reasons.join(", ")}  projected ${entry.projectedHash ?? "(missing)"} -> current ${entry.currentHash}`
    );
  }
  if (result.divergentCount > result.divergent.length) {
    console.log(
      `  Divergence output capped at ${result.divergent.length} samples; exact total above.`
    );
  }
  if (result.orphanManticore.length > 0) {
    console.log(
      `  Orphan Manticore UUID samples: ${result.orphanManticore.join(", ")}`
    );
  }
  if (result.physicalCorruption.length > 0) {
    console.error(
      `  Physical corruption samples: ${result.physicalCorruption
        .map((row) => `${row.partition}/${row.manticoreId}/${row.documentId}`)
        .join(", ")}`
    );
  }
  if (
    !apply &&
    (result.divergentCount > 0 ||
      result.orphanManticoreCount > 0 ||
      result.physicalCorruptionCount > 0)
  ) {
    console.log(
      "Stop the projector, wait for any in-flight drain, then re-run with --apply --projector-quiesced."
    );
  }
  if (!apply && failOnDrift && hasProjectionDrift(result)) {
    console.error(
      "Projection reconciliation found drift; failing closed (--fail-on-drift)."
    );
    process.exitCode = 1;
  }
} catch (error) {
  if (
    error instanceof ProjectionRepairSchemaMismatchError ||
    error instanceof ProjectionRepairGenerationChangedError ||
    error instanceof ProjectionRepairInventorySafetyError
  ) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await closeDb();
}
