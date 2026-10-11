/**
 * On-box oneshot for enrich-incomplete (Coolify Scheduled Task on the poller
 * app). Reads the payload from env so the scheduled command never changes
 * when an operator flips dryRun. Unset variables keep the Trigger defaults
 * (`enrichIncompleteDefaults`): dryRun true, LLM residual off, batch 25.
 *
 * | Env | Payload field | Default |
 * |---|---|---|
 * | `ENRICH_DRY_RUN` | dryRun | true |
 * | `ENRICH_BATCH_SIZE` | batchSize | 25 (1..500) |
 * | `ENRICH_ENABLE_LLM_RESIDUAL` | enableLlmResidual | false |
 * | `ENRICH_APPLY_STORED_PROPOSALS` | applyStoredProposals | false |
 * | `ENRICHMENT_DURABLE` (existing) | durable | off; only used when dryRun is false |
 *
 * Any malformed value fails closed: the run never starts on a typo.
 */
import {
  enrichIncompleteDefaults,
  enrichIncompletePayload,
} from "./tasks/enrich-incomplete-schema";
import type { EnrichIncompletePayload } from "./tasks/enrich-incomplete-schema";

export type EnrichOneshotEnv = Readonly<Record<string, string | undefined>>;

export class EnrichOneshotConfigError extends Error {
  override readonly name = "EnrichOneshotConfigError";
}

const TRUE_VALUES = new Set(["1", "true", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "no"]);

const readBoolean = (
  env: EnrichOneshotEnv,
  key: string,
  fallback: boolean
): boolean => {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (TRUE_VALUES.has(raw)) {
    return true;
  }
  if (FALSE_VALUES.has(raw)) {
    return false;
  }
  throw new EnrichOneshotConfigError(
    `${key} must be true/false (or 1/0), got "${raw}"`
  );
};

const INTEGER_PATTERN = /^\d+$/u;

const readBatchSize = (env: EnrichOneshotEnv): number => {
  const raw = env.ENRICH_BATCH_SIZE?.trim();
  if (raw === undefined || raw === "") {
    return enrichIncompleteDefaults.batchSize;
  }
  if (!INTEGER_PATTERN.test(raw)) {
    throw new EnrichOneshotConfigError(
      `ENRICH_BATCH_SIZE must be a positive integer, got "${raw}"`
    );
  }
  return Number(raw);
};

export type EnrichOneshotPayload = Required<
  Omit<EnrichIncompletePayload, "durable">
>;

/** Builds the enrich-incomplete payload from env; every field is explicit so the run log shows the effective config. */
export const enrichOneshotPayloadFromEnv = (
  env: EnrichOneshotEnv
): EnrichOneshotPayload => {
  const candidate = {
    applyStoredProposals: readBoolean(
      env,
      "ENRICH_APPLY_STORED_PROPOSALS",
      enrichIncompleteDefaults.applyStoredProposals
    ),
    batchSize: readBatchSize(env),
    dryRun: readBoolean(env, "ENRICH_DRY_RUN", enrichIncompleteDefaults.dryRun),
    enableLlmResidual: readBoolean(
      env,
      "ENRICH_ENABLE_LLM_RESIDUAL",
      enrichIncompleteDefaults.enableLlmResidual
    ),
  };
  const parsed = enrichIncompletePayload.safeParse(candidate);
  if (!parsed.success) {
    throw new EnrichOneshotConfigError(
      `invalid enrich oneshot config: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return candidate;
};
