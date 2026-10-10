import { z } from "zod";

import type { LiveJobsConfig } from "./config";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const releaseResponseSchema = z
  .object({
    releaseSha: z.string().regex(SHA_PATTERN),
  })
  .strict();

export type ReleasePreflightJson = Readonly<Record<string, string | null>>;

export interface ReleasePreflightResponse {
  readonly status: number;
  readonly url: string;
  json: () => Promise<ReleasePreflightJson>;
}

type ReleasePreflightFetchResponse = Response | ReleasePreflightResponse;

export interface ReleasePreflightDependencies {
  readonly fetcher?: (
    input: string,
    init: RequestInit
  ) => Promise<ReleasePreflightFetchResponse>;
}

const releaseEndpoint = (apiUrl: string): string =>
  new URL("/version", apiUrl).toString();

/**
 * A release proof is valid only when the configured server exposes the exact
 * expected Git SHA without a redirect or an inferred deployment identity.
 */
export const preflightReleaseIdentity = async (
  config: LiveJobsConfig,
  dependencies: ReleasePreflightDependencies = {}
): Promise<void> => {
  const endpoint = releaseEndpoint(config.apiUrl);
  let response: ReleasePreflightFetchResponse;
  try {
    response = await (dependencies.fetcher ?? fetch)(endpoint, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      method: "GET",
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Release identity preflight could not reach /version; no browser evidence was attempted."
    );
  }
  if (response.status !== 200 || response.url !== endpoint) {
    throw new Error(
      "Release identity preflight did not receive the exact 200 response from /version; no browser evidence was attempted."
    );
  }
  let releaseSha: string | null;
  try {
    const parsed = releaseResponseSchema.safeParse(await response.json());
    releaseSha = parsed.success ? parsed.data.releaseSha : null;
  } catch {
    throw new Error(
      "Release identity preflight returned invalid JSON; no browser evidence was attempted."
    );
  }
  if (releaseSha !== config.expectedReleaseSha) {
    throw new Error(
      "Server release identity does not exactly match E2E_EXPECTED_RELEASE_SHA; no browser evidence was attempted."
    );
  }
};

export const appReleaseEndpoint = releaseEndpoint;
