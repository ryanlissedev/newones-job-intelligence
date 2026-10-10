import { z } from "zod";

import { canaryJsonValueSchema } from "./canary";
import type { CanaryJsonValue } from "./canary";
import type { MutationLiveJobsConfig } from "./config";
import type { SanitizedCleanupReceipt } from "./evidence";
import { SanitizedMutationError } from "./mutation-errors";

export type MutationResourceKind = "markering" | "saved-search" | "snapshot";

export interface MutationResource {
  readonly id: string;
  readonly kind: Exclude<MutationResourceKind, "markering">;
}

export interface MutationAttemptLedger {
  markering: boolean;
  savedSearch: boolean;
  snapshot: boolean;
}

export interface MutationCleanupBaseline {
  readonly token: string;
}

interface CleanupLiveJobsInput {
  readonly attemptedWrites: MutationAttemptLedger;
  readonly baseline: MutationCleanupBaseline;
  readonly config: MutationLiveJobsConfig;
  readonly observedResources: readonly MutationResource[];
  readonly request: CleanupRequestContext;
}

interface CleanupRequestContext {
  readonly post: (
    url: string,
    options: {
      readonly data: unknown;
      readonly headers: Readonly<Record<string, string>>;
      readonly maxRedirects: number;
    }
  ) => Promise<CleanupRequestResponse>;
}

interface CleanupRequestResponse {
  readonly json: () => Promise<CanaryJsonValue>;
  readonly status: () => number;
  readonly url: () => string;
}

interface CleanupFetchResponse {
  readonly json: () => Promise<CanaryJsonValue>;
  readonly status: number;
  readonly url: string;
}

type CleanupFetcher = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<CleanupFetchResponse>;

const baselineResponseSchema = z.object({
  baselineToken: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u),
  preservedExistingState: z.literal(true),
});
const cleanupResponseSchema = z.object({
  baselineRestored: z.boolean(),
  residualRunWrites: z.object({
    markering: z.number().int().nonnegative(),
    savedSearch: z.number().int().nonnegative(),
    snapshot: z.number().int().nonnegative(),
  }),
  status: z.enum(["clean", "residue"]),
});

const cleanupHeaders = (cleanupToken: string) => ({
  Authorization: `Bearer ${cleanupToken}`,
  "Content-Type": "application/json",
});

const defaultCleanupFetcher: CleanupFetcher = async (input, init) => {
  const response = await fetch(input, init);
  return {
    json: async () => canaryJsonValueSchema.parse(await response.json()),
    status: response.status,
    url: response.url,
  };
};

const cleanupScope = (config: MutationLiveJobsConfig) => ({
  accountId: config.testAccountId,
  canaryId: config.canaryId,
  namespace: config.testNamespace,
});

export const createMutationAttemptLedger = (): MutationAttemptLedger => ({
  markering: false,
  savedSearch: false,
  snapshot: false,
});

const attemptedKinds = (
  ledger: MutationAttemptLedger
): MutationResourceKind[] => {
  const kinds: MutationResourceKind[] = [];
  if (ledger.markering) {
    kinds.push("markering");
  }
  if (ledger.savedSearch) {
    kinds.push("saved-search");
  }
  if (ledger.snapshot) {
    kinds.push("snapshot");
  }
  return kinds;
};

/**
 * Captures an opaque server-side baseline before any browser write. The
 * cleanup service must later restore this exact baseline, so a pre-existing
 * marker or namespaced record is preserved rather than deleted.
 */
export const preflightLiveJobsCleanup = async (
  config: MutationLiveJobsConfig,
  fetcher: CleanupFetcher = defaultCleanupFetcher
): Promise<MutationCleanupBaseline> => {
  let response: CleanupFetchResponse;
  try {
    response = await fetcher(config.cleanupUrl, {
      body: JSON.stringify({
        action: "capture-baseline",
        scope: cleanupScope(config),
      }),
      headers: cleanupHeaders(config.cleanupToken),
      method: "POST",
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Isolated live-jobs cleanup baseline could not be captured; no browser writes were attempted."
    );
  }

  if (response.status !== 200 || response.url !== config.cleanupUrl) {
    throw new Error(
      "Isolated live-jobs cleanup baseline did not return the exact unredirected response; no browser writes were attempted."
    );
  }
  try {
    const parsed = baselineResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      return { token: parsed.data.baselineToken };
    }
  } catch {
    // Raw cleanup responses are deliberately discarded.
  }
  throw new Error(
    "Isolated live-jobs cleanup baseline receipt was invalid; no browser writes were attempted."
  );
};

/**
 * Restores the server-side baseline for the full isolated account/namespace
 * scope and deterministic canary marker. Observed ids are hints only: the
 * attempted-write ledger remains exhaustive when a committed response is lost
 * or malformed. Success requires an exact zero-residue receipt.
 */
export const cleanupLiveJobsMutations = async ({
  attemptedWrites,
  baseline,
  config,
  observedResources,
  request,
}: CleanupLiveJobsInput): Promise<SanitizedCleanupReceipt> => {
  let response;
  try {
    response = await request.post(config.cleanupUrl, {
      data: {
        action: "restore-baseline-and-verify",
        attemptedWrites: {
          markering: attemptedWrites.markering,
          savedSearch: attemptedWrites.savedSearch,
          snapshot: attemptedWrites.snapshot,
        },
        baselineToken: baseline.token,
        observedResources,
        scope: cleanupScope(config),
      },
      headers: cleanupHeaders(config.cleanupToken),
      maxRedirects: 0,
    });
  } catch {
    throw new SanitizedMutationError({
      code: "cleanup-request-failed",
      phase: "cleanup",
    });
  }

  if (response.status() !== 200 || response.url() !== config.cleanupUrl) {
    throw new SanitizedMutationError({
      code: "cleanup-invalid-response",
      phase: "cleanup",
    });
  }

  try {
    const parsed = cleanupResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new SanitizedMutationError({
        code: "cleanup-invalid-response",
        phase: "cleanup",
      });
    }
    const residue = parsed.data.residualRunWrites;
    if (
      !parsed.data.baselineRestored ||
      parsed.data.status !== "clean" ||
      residue.markering !== 0 ||
      residue.savedSearch !== 0 ||
      residue.snapshot !== 0
    ) {
      throw new SanitizedMutationError({
        code: "cleanup-residue",
        phase: "cleanup",
      });
    }
  } catch (error) {
    if (error instanceof SanitizedMutationError) {
      throw error;
    }
    throw new SanitizedMutationError({
      code: "cleanup-invalid-response",
      phase: "cleanup",
    });
  }

  return {
    attemptedKinds: attemptedKinds(attemptedWrites),
    baselineRestored: true,
    residueCount: 0,
    status: response.status(),
  };
};
