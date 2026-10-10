/* oxlint-disable max-classes-per-file -- in-memory and durable adapters share one small contract */
import type { BronId, ScrapeRunId, SourceRecordId } from "@ji/domain";

export type RawContentType = "json" | "html" | "pdf";

export interface RawObjectPathInput {
  bronSlug: string;
  runId: ScrapeRunId;
  recordId: string;
  contentType: RawContentType;
  startedAt?: Date;
}

const pad = (value: number): string => value.toString().padStart(2, "0");

export const buildRawObjectPath = ({
  bronSlug,
  contentType,
  recordId,
  runId,
  startedAt = new Date(),
}: RawObjectPathInput): string => {
  const year = startedAt.getUTCFullYear();
  const month = pad(startedAt.getUTCMonth() + 1);
  const day = pad(startedAt.getUTCDate());

  return `raw/${bronSlug}/${year}/${month}/${day}/${runId}/${recordId}.${contentType}`;
};

export interface StoredObject {
  path: string;
  body: Uint8Array;
  contentType: RawContentType;
  /** Object-store lifecycle deadline; raw defaults are configured by the caller. */
  expiresAt: Date;
}

export interface ObjectStore {
  put: (object: StoredObject) => Promise<void>;
  get: (path: string) => Promise<StoredObject | null>;
  deleteExpired: (before: Date) => Promise<number>;
}

export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  put(object: StoredObject): Promise<void> {
    this.objects.set(object.path, object);
    return Promise.resolve();
  }

  get(path: string): Promise<StoredObject | null> {
    return Promise.resolve(this.objects.get(path) ?? null);
  }

  deleteExpired(before: Date): Promise<number> {
    let deleted = 0;
    for (const [path, object] of this.objects) {
      if (object.expiresAt <= before) {
        this.objects.delete(path);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  has(path: string): boolean {
    return this.objects.has(path);
  }
}

export const hashContent = async (body: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(body));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export interface ContentAddressedRawObjectPathInput {
  bronSlug: string;
  contentType: RawContentType;
  /** Precomputed via {@link hashContent}; the path builder stays sync. Any
   * case is accepted and normalized to lowercase — {@link hashContent}
   * itself always emits lowercase, but callers may pass a hash sourced
   * elsewhere (e.g. a connector's own digest). */
  contentHash: string;
  startedAt?: Date;
}

// A slash, or any other path-structuring character, in bronSlug would shift
// every segment after it — e.g. a "raw/" prefix or extra "/" would either
// collide with an unrelated key or (more dangerously) make the resulting
// path silently fail CONTENT_ADDRESSED_PATH_PATTERN below, so a corrupted or
// tampered object would read back unverified instead of failing loudly.
const BRON_SLUG_PATTERN = /^[a-z0-9-]+$/u;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/iu;

/** RJC-386 content-addressed scheme: same bytes always resolve to the same
 * key, making writes idempotent and readback digest-verifiable. Validates
 * bronSlug and contentHash strictly: a value that produced a path
 * `parseContentAddressedRawObjectPath` couldn't recognize would silently
 * skip digest verification on readback instead of failing loudly, so this
 * throws rather than build such a path. */
export const buildContentAddressedRawObjectPath = ({
  bronSlug,
  contentType,
  contentHash,
  startedAt = new Date(),
}: ContentAddressedRawObjectPathInput): string => {
  if (!BRON_SLUG_PATTERN.test(bronSlug)) {
    throw new Error(
      `Invalid bronSlug for content-addressed raw object path: ${bronSlug} ` +
        "(must match [a-z0-9-]+, no slashes)"
    );
  }
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new Error(
      `Invalid contentHash for content-addressed raw object path: ${contentHash} ` +
        "(must be a 64-character hex SHA-256 digest)"
    );
  }
  const normalizedContentHash = contentHash.toLowerCase();
  const year = startedAt.getUTCFullYear();
  const month = pad(startedAt.getUTCMonth() + 1);

  return `raw/${bronSlug}/${year}/${month}/${normalizedContentHash}.${contentType}`;
};

const CONTENT_ADDRESSED_PATH_PATTERN =
  /^raw\/(?<bronSlug>[a-z0-9-]+)\/\d{4}\/\d{2}\/(?<contentHash>[0-9a-f]{64})\.(?:json|html|pdf)$/u;

/** Recognizes a {@link buildContentAddressedRawObjectPath} key and extracts
 * its embedded hash. Legacy {@link buildRawObjectPath} keys (which carry a
 * day + runId + recordId segment instead) never match, so callers can use
 * this to decide whether digest verification applies. */
export const parseContentAddressedRawObjectPath = (
  objectPath: string
): { contentHash: string } | null => {
  const match = CONTENT_ADDRESSED_PATH_PATTERN.exec(objectPath);
  const contentHash = match?.groups?.contentHash;
  return contentHash ? { contentHash } : null;
};

/** Thrown by a durable client's `get` when a content-addressed object's body
 * no longer hashes to the digest embedded in its own path — the object was
 * corrupted or tampered with in the backing store. Never returned as a
 * valid StoredObject. */
export class RawObjectDigestMismatchError extends Error {
  constructor(path: string, expectedHash: string, actualHash: string) {
    super(
      `Raw object digest mismatch at ${path}: expected ${expectedHash}, got ${actualHash}`
    );
    this.name = "RawObjectDigestMismatchError";
  }
}

/** Thrown by a durable client's `get` when an object's body exists but its
 * `.ji-meta.json` sidecar does not.
 *
 * This is ALWAYS a partial/torn write, never a legitimate legacy state: the
 * S3-compatible store is new as of RJC-386, so no S3 object predates the
 * sidecar convention (unlike the filesystem store's `raw/.../{runId}/...`
 * paths, which do have real pre-sidecar legacy readers — see
 * `buildRawObjectPath`, which stays intentionally unvalidated for that
 * reason). `S3ObjectClient.put` writes the sidecar before the body
 * specifically so this state is unreachable on the happy path; do not
 * "fix" this back to returning `null` — a missing body is a legitimate
 * null, a body without its metadata is corruption and must fail loudly. */
export class RawObjectMetadataMissingError extends Error {
  constructor(path: string) {
    super(
      `Raw object body exists at ${path} but its metadata sidecar is missing (partial write)`
    );
    this.name = "RawObjectMetadataMissingError";
  }
}

export interface SourceRecordPointer {
  bronId: BronId;
  bronReferentie: string;
  contentHash: string;
  /**
   * RJC-357: the listing-tier hash (`hash*ListingItem`) the discover pass
   * computed for this record, persisted so the known-hash short-circuit can
   * compare listing hash to listing hash. Absent/null means "no listing
   * hash recorded", which must never skip a fetch.
   */
  listingHash?: string | null;
  rawPayloadRef: string;
  scrapeRunId: ScrapeRunId;
}

export type SourceRecordWriteOutcome = "new" | "changed" | "unchanged";

export interface SourceRecordWriteResult {
  outcome: SourceRecordWriteOutcome;
  sourceRecordId: SourceRecordId;
}

/** Adapter for durable S3-compatible clients without coupling connectors to an SDK. */
export interface DurableObjectClient {
  put: (object: StoredObject) => Promise<void>;
  get: (path: string) => Promise<StoredObject | null>;
  deleteExpired: (before: Date) => Promise<number>;
}

export class DurableObjectStore implements ObjectStore {
  private readonly client: DurableObjectClient;

  constructor(client: DurableObjectClient) {
    this.client = client;
  }

  put(object: StoredObject): Promise<void> {
    return this.client.put(object);
  }

  get(path: string): Promise<StoredObject | null> {
    return this.client.get(path);
  }

  deleteExpired(before: Date): Promise<number> {
    return this.client.deleteExpired(before);
  }
}
