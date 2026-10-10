import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  PostgresBronPersistence,
  PostgresObservationRecorder,
  PostgresRunStore,
} from "./bron-runtime";
import { PostgresKnownHashStore } from "./known-hash-store";
import { createPostgresLifecyclePorts } from "./missed-polls-store";
import { PostgresResumeOrderLookup } from "./resume-order-store";
import * as schema from "./schema";

export const createBronRuntimeClient = (
  databaseUrl: string,
  options: { now?: () => Date; pollRunStaleAfterMs?: number } = {}
) => {
  const sqlClient = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 20,
    max: 10,
    max_lifetime: 30 * 60,
  });
  const database = drizzle(sqlClient, { schema });

  return {
    bronPersistence: new PostgresBronPersistence(database),
    close: (): Promise<void> => sqlClient.end({ timeout: 5 }),
    database,
    /** Last fetch time per record; pass as `executeBronRun({ resumeOrder })` so budget-cut crawls resume. */
    fetchHistory: new PostgresResumeOrderLookup(database),
    knownHashStore: new PostgresKnownHashStore(database),
    /** RJC-397: pass as `executeBronRun({ lifecycle })` so poll runs count missed polls. */
    lifecycle: createPostgresLifecyclePorts(database),
    observationRecorder: new PostgresObservationRecorder(database),
    runLifecycleStore: new PostgresRunStore(database, options),
  };
};

export type BronRuntimeClient = ReturnType<typeof createBronRuntimeClient>;
