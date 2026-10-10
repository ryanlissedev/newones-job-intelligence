import {
  NEON_V1_DEFAULT_CONCURRENCY,
  NEON_V1_MAX_CONCURRENCY,
  getBackfillFailureDiagnostic,
} from "@ji/application/backfill";
import type {
  BackfillFailureDiagnostic,
  BackfillFailureEvidence,
} from "@ji/application/backfill";
import { createRawObjectStore } from "@ji/connectors/s3-object-client";

// oxlint-disable-next-line eslint/prefer-named-capture-group -- production contract requires this exact redaction regex
const POSTGRES_URL_PATTERN = /postgres(ql)?:\/\/\S+/gu;
const UNKNOWN_CAUSE_CLASS = "UnknownError";
const UNKNOWN_CAUSE_MESSAGE = "No underlying error";

interface CauseDetails {
  readonly className: string;
  readonly message: string;
}

const replaceControlCharacters = (value: string): string =>
  [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("");

const sanitizeDiagnosticValue = (value: string): string =>
  replaceControlCharacters(value.replace(POSTGRES_URL_PATTERN, "<url>")).trim();

const causeDetails = (cause: unknown): CauseDetails => {
  if (!(cause instanceof Error)) {
    return {
      className: UNKNOWN_CAUSE_CLASS,
      message: UNKNOWN_CAUSE_MESSAGE,
    };
  }
  return {
    className: sanitizeDiagnosticValue(
      cause.constructor.name || cause.name || "Error"
    ),
    message: sanitizeDiagnosticValue(cause.message) || UNKNOWN_CAUSE_MESSAGE,
  };
};

const quoted = (value: string): string =>
  JSON.stringify(sanitizeDiagnosticValue(value));

export const formatBackfillFailureDiagnostic = (
  failure: BackfillFailureEvidence,
  diagnostic: BackfillFailureDiagnostic | undefined
): string => {
  const cause = causeDetails(diagnostic?.error.cause);
  return [
    "backfill failure",
    `code=${failure.code}`,
    `phase=${failure.phase}`,
    `platform=${quoted(diagnostic?.platform ?? "unknown")}`,
    `sourceJobId=${quoted(diagnostic?.sourceJobId ?? "unknown")}`,
    `cause=${quoted(cause.className)}`,
    `message=${quoted(cause.message)}`,
  ].join(" ");
};

const resolveExecutionMode = (): "fixture" | "production" => {
  const value = process.env.NEON_V1_EXECUTION_MODE?.trim();
  if (!value || value === "fixture") {
    return "fixture";
  }
  if (value === "production") {
    return "production";
  }
  throw new Error("NEON_V1_EXECUTION_MODE must be fixture or production");
};

const resolveScope = (
  executionMode: "fixture" | "production"
): "active" | "full" => {
  const value = process.env.NEON_V1_SCOPE?.trim();
  if (!value) {
    return executionMode === "production" ? "full" : "active";
  }
  if (value === "active" || value === "full") {
    return value;
  }
  throw new Error("NEON_V1_SCOPE must be active or full");
};

const resolveBatchSize = (): number => {
  const batchSize = Number(process.env.NEON_V1_BATCH_SIZE ?? 1000);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error("NEON_V1_BATCH_SIZE must be an integer between 1 and 5000");
  }
  return batchSize;
};

export const resolveConcurrency = (): number => {
  const concurrency = Number(
    process.env.NEON_V1_CONCURRENCY ?? NEON_V1_DEFAULT_CONCURRENCY
  );
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > NEON_V1_MAX_CONCURRENCY
  ) {
    throw new Error(
      `NEON_V1_CONCURRENCY must be an integer between 1 and ${NEON_V1_MAX_CONCURRENCY}`
    );
  }
  return concurrency;
};

const main = async (): Promise<void> => {
  const { runMotianV1Backfill } = await import("@ji/db");
  const executionMode = resolveExecutionMode();
  const scope = resolveScope(executionMode);
  const rawObjectStore = createRawObjectStore({
    RAW_OBJECT_STORE_PATH: process.env.RAW_OBJECT_STORE_PATH,
    RAW_S3_ACCESS_KEY_ID: process.env.RAW_S3_ACCESS_KEY_ID,
    RAW_S3_BUCKET: process.env.RAW_S3_BUCKET,
    RAW_S3_ENDPOINT: process.env.RAW_S3_ENDPOINT,
    RAW_S3_REGION: process.env.RAW_S3_REGION,
    RAW_S3_SECRET_ACCESS_KEY: process.env.RAW_S3_SECRET_ACCESS_KEY,
  });
  const result = await runMotianV1Backfill({
    batchSize: resolveBatchSize(),
    concurrency: resolveConcurrency(),
    executionMode,
    includeClosed:
      scope === "active" && process.env.NEON_V1_INCLUDE_CLOSED === "1",
    rawObjectStore,
    scope,
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.status !== "succeeded") {
    const { failure } = result.evidence;
    if (!failure) {
      throw new Error("Failed backfill result is missing failure evidence");
    }
    process.stderr.write(
      `${formatBackfillFailureDiagnostic(
        failure,
        getBackfillFailureDiagnostic(result)
      )}\n`
    );
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
