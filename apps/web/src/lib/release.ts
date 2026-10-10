const RELEASE_SHA_PATTERN = /^[a-f0-9]{40}$/u;

export interface ReleaseIdentity {
  readonly releaseSha: string | null;
}

/**
 * Same contract as the API server's /version (apps/server/src/http/release.ts):
 * the deploy driver compares this SHA with the candidate, so an absent or
 * malformed value must refuse to claim an identity rather than echo something
 * that merely looks like one.
 */
export const releaseResponse = (releaseSha?: string): Response => {
  const identified =
    releaseSha !== undefined && RELEASE_SHA_PATTERN.test(releaseSha);
  const body: ReleaseIdentity = { releaseSha: identified ? releaseSha : null };
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status: identified ? 200 : 503,
  });
};
