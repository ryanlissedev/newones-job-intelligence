import type { Context } from "hono";

const RELEASE_SHA_PATTERN = /^[a-f0-9]{40}$/u;

interface ReleaseIdentityBody {
  readonly releaseSha: string | null;
}

const noStoreJson = (body: ReleaseIdentityBody, status: number): Response =>
  Response.json(body, {
    headers: { "Cache-Control": "no-store" },
    status,
  });

/**
 * A deliberately tiny public identity endpoint. It exposes only the deployed
 * commit SHA; missing/invalid configuration is not converted into a plausible
 * release identity.
 */
export const createReleaseHandler =
  (releaseSha?: string) =>
  (_context: Context): Response => {
    if (!releaseSha || !RELEASE_SHA_PATTERN.test(releaseSha)) {
      return noStoreJson({ releaseSha: null }, 503);
    }
    return noStoreJson({ releaseSha }, 200);
  };
