import {
  formatReconciliationRefusal,
  parseReconciliationArguments,
  parseReconciliationEnvironment,
  reconciliationFailureCode,
  RECONCILIATION_SCOPE_ID,
} from "./reconciliation";
import { createSpottReconciliationAuthorize } from "./transaction-auth";

const writeOutput = (output: string): void => {
  process.stdout.write(`${output}\n`);
};

const main = async (): Promise<void> => {
  const parsedArguments = parseReconciliationArguments(process.argv.slice(2));
  if (!parsedArguments.ok) {
    writeOutput(formatReconciliationRefusal(parsedArguments.code));
    process.exitCode = 1;
    return;
  }
  const environment = parseReconciliationEnvironment(process.env);
  if (!environment) {
    writeOutput(formatReconciliationRefusal("INVALID_ENVIRONMENT"));
    process.exitCode = 1;
    return;
  }

  let closeDatabase: (() => Promise<void>) | undefined;
  let operationSucceeded = false;
  try {
    const databaseModule = await import("@ji/db");
    closeDatabase = databaseModule.closeDb;
    const reconciliationModule = await import("@ji/db/export-reconciliation");

    const result = await reconciliationModule.reconcileSpottExportId(
      databaseModule.db,
      parsedArguments.input,
      createSpottReconciliationAuthorize(environment),
      { expectedScopeId: RECONCILIATION_SCOPE_ID }
    );
    operationSucceeded = true;
    process.exitCode = 0;
    try {
      writeOutput(JSON.stringify({ status: "ok", ...result }));
    } catch {
      process.stderr.write(
        `${JSON.stringify({ code: "OUTPUT_FAILED", status: "warning" })}\n`
      );
    }
  } catch (error) {
    const code =
      error instanceof Error
        ? reconciliationFailureCode(error)
        : "RECONCILIATION_FAILED";
    writeOutput(formatReconciliationRefusal(code));
    process.exitCode = 1;
  } finally {
    try {
      await closeDatabase?.();
    } catch {
      if (operationSucceeded) {
        process.stderr.write(
          `${JSON.stringify({ code: "DATABASE_CLOSE_FAILED", status: "warning" })}\n`
        );
      } else {
        process.exitCode = 1;
      }
    }
  }
};

if (import.meta.main) {
  await main();
}
