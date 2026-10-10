import path from "node:path";

import { FilesystemObjectStore } from "./filesystem-object-store";
import {
  DurableObjectStore,
  parseContentAddressedRawObjectPath,
  RawObjectDigestMismatchError,
  RawObjectMetadataMissingError,
} from "./object-store";
import type {
  DurableObjectClient,
  ObjectStore,
  RawContentType,
  StoredObject,
} from "./object-store";

const METADATA_SUFFIX = ".ji-meta.json";
const RAW_PREFIX = "raw/";
const CONTENT_TYPE_MIME = {
  html: "text/html",
  json: "application/json",
  pdf: "application/pdf",
} satisfies Record<RawContentType, string>;

interface StoredMetadata {
  contentType: RawContentType;
  expiresAt: string;
}

const metadataPathFor = (objectPath: string): string =>
  `${objectPath}${METADATA_SUFFIX}`;

/** Bun's S3Client raises `S3Error` (name) with a `.code` field — `NoSuchKey`
 * is the only code that means "genuinely absent"; everything else (bad
 * credentials, network failure, permission errors, ...) must propagate.
 * Callers narrow the catch binding to `Error` before calling this. */
const isNoSuchKeyError = (error: Error): boolean => {
  if (!("code" in error)) {
    return false;
  }
  // SAFETY: narrowed to Error with an own/inherited "code" property above;
  // Bun's S3Error always types that field as a string discriminant.
  return (error as Error & { code?: string }).code === "NoSuchKey";
};

const sha256Hex = async (body: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(body));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export interface S3ObjectClientOptions {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** S3-compatible durable object client backed by Bun's built-in `Bun.S3Client`
 * (RJC-386) — no SDK dependency. Content type and expiry are not carried as
 * S3 object metadata (Bun's S3Options has no arbitrary-metadata header
 * support today); instead a small `{path}.ji-meta.json` sidecar mirrors the
 * convention `FilesystemObjectStore` already uses, so both stores read back
 * the same shape. */
export class S3ObjectClient implements DurableObjectClient {
  private readonly client: Bun.S3Client;

  constructor(options: S3ObjectClientOptions) {
    this.client = new Bun.S3Client({
      accessKeyId: options.accessKeyId,
      bucket: options.bucket,
      endpoint: options.endpoint,
      region: options.region,
      secretAccessKey: options.secretAccessKey,
    });
  }

  async put(object: StoredObject): Promise<void> {
    const contentAddressed = parseContentAddressedRawObjectPath(object.path);
    if (contentAddressed) {
      const alreadyStored = await this.client.exists(object.path);
      if (alreadyStored) {
        const [stored, requestedHash] = await Promise.all([
          this.get(object.path),
          sha256Hex(object.body),
        ]);
        if (!stored) {
          // The body was deleted between HEAD and GET. Treat it as absent and
          // repair it through the normal metadata-before-body write below.
        } else if (
          stored.body.byteLength !== object.body.byteLength ||
          stored.contentType !== object.contentType ||
          requestedHash !== contentAddressed.contentHash
        ) {
          throw new RawObjectDigestMismatchError(
            object.path,
            contentAddressed.contentHash,
            requestedHash
          );
        } else {
          return;
        }
      }
    }

    const metadata: StoredMetadata = {
      contentType: object.contentType,
      expiresAt: object.expiresAt.toISOString(),
    };

    // Ordering is safety-critical: metadata is written BEFORE the body.
    // These two writes are not transactional, but the dedup short-circuit
    // above checks ONLY the body key (object.path), never the sidecar —
    // so if a crash lands between the two writes below, the object is left
    // with a sidecar but no body, and the NEXT put() attempt for the same
    // content-addressed path re-enters this function (exists() on the body
    // key is still false) and retries both writes. The reverse ordering
    // (body-first) would let exists() see the body, short-circuit, and skip
    // the retry forever — the body would then be permanently unreadable
    // because get() requires the sidecar too (see
    // RawObjectMetadataMissingError, which documents why that state must
    // never silently resolve to null).
    await this.client.write(
      metadataPathFor(object.path),
      JSON.stringify(metadata)
    );
    await this.client.write(object.path, object.body, {
      type: CONTENT_TYPE_MIME[object.contentType],
    });
  }

  async get(objectPath: string): Promise<StoredObject | null> {
    const bodyFile = this.client.file(objectPath);
    const metadataFile = this.client.file(metadataPathFor(objectPath));

    let bodyBuffer: ArrayBuffer;
    try {
      bodyBuffer = await bodyFile.arrayBuffer();
    } catch (error) {
      if (error instanceof Error && isNoSuchKeyError(error)) {
        return null;
      }
      // Bad credentials, network failure, permission errors, etc. must
      // surface as failures, not a silent "not found".
      throw error;
    }

    let metadataRaw: string;
    try {
      metadataRaw = await metadataFile.text();
    } catch (error) {
      if (error instanceof Error && isNoSuchKeyError(error)) {
        throw new RawObjectMetadataMissingError(objectPath);
      }
      throw error;
    }

    const body = new Uint8Array(bodyBuffer);
    const contentAddressed = parseContentAddressedRawObjectPath(objectPath);
    if (contentAddressed) {
      const actualHash = await sha256Hex(body);
      if (actualHash !== contentAddressed.contentHash) {
        throw new RawObjectDigestMismatchError(
          objectPath,
          contentAddressed.contentHash,
          actualHash
        );
      }
    }

    // SAFETY: metadata sidecars are written by this client as StoredMetadata JSON.
    const metadata = JSON.parse(metadataRaw) as StoredMetadata;
    return {
      body,
      contentType: metadata.contentType,
      expiresAt: new Date(metadata.expiresAt),
      path: objectPath,
    };
  }

  /** Deletes objects whose sidecar `expiresAt` is at or before `before`.
   * ponytail: O(n) listing over the whole `raw/` prefix — fine for a
   * scheduled sweep at current volume. Production retention is expected to
   * be a bucket lifecycle rule; this method is the app-side fallback for
   * providers/configs without one. Upgrade to a prefix-partitioned sweep if
   * the object count makes a full listing slow. */
  async deleteExpired(before: Date): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      // oxlint-disable-next-line no-await-in-loop -- pagination is inherently sequential
      const page = await this.client.list({
        continuationToken,
        prefix: RAW_PREFIX,
      });
      const metadataKeys = (page.contents ?? [])
        .map((entry) => entry.key)
        .filter((key) => key.endsWith(METADATA_SUFFIX));

      // oxlint-disable-next-line no-await-in-loop -- each metadata read gates a delete decision
      deleted += await this.deleteExpiredMetadataKeys(metadataKeys, before);
      continuationToken = page.isTruncated
        ? page.nextContinuationToken
        : undefined;
    } while (continuationToken);

    return deleted;
  }

  private async deleteExpiredMetadataKeys(
    metadataKeys: string[],
    before: Date
  ): Promise<number> {
    let deleted = 0;
    for (const metadataKey of metadataKeys) {
      const bodyKey = metadataKey.slice(
        0,
        metadataKey.length - METADATA_SUFFIX.length
      );
      // oxlint-disable-next-line no-await-in-loop -- sequential expiry walk, mirrors FilesystemObjectStore
      const metadataRaw = await this.client.file(metadataKey).text();
      // SAFETY: metadata sidecars are written by this client as StoredMetadata JSON.
      const metadata = JSON.parse(metadataRaw) as StoredMetadata;
      if (new Date(metadata.expiresAt) > before) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential expiry walk, mirrors FilesystemObjectStore
      await Promise.all([
        this.client.delete(bodyKey),
        this.client.delete(metadataKey),
      ]);
      deleted += 1;
    }
    return deleted;
  }
}

export interface RawObjectStoreEnv {
  RAW_S3_BUCKET?: string;
  RAW_S3_ENDPOINT?: string;
  RAW_S3_REGION?: string;
  RAW_S3_ACCESS_KEY_ID?: string;
  RAW_S3_SECRET_ACCESS_KEY?: string;
  RAW_OBJECT_STORE_PATH?: string;
}

export interface RawObjectStoreResult {
  store: ObjectStore;
  /** Lets callers (e.g. production startup) assert on which backend was
   * actually selected, without instanceof-checking the store. */
  kind: "s3" | "filesystem";
}

/** Selects the durable raw-object backend by environment (RJC-386): S3 (or
 * any S3-compatible endpoint, incl. MinIO locally) when RAW_S3_BUCKET is
 * set, otherwise the worker-local filesystem store. */
export const createRawObjectStore = (
  env: RawObjectStoreEnv
): RawObjectStoreResult => {
  const bucket = env.RAW_S3_BUCKET?.trim();
  if (bucket) {
    const client = new S3ObjectClient({
      accessKeyId: env.RAW_S3_ACCESS_KEY_ID,
      bucket,
      endpoint: env.RAW_S3_ENDPOINT?.trim(),
      region: env.RAW_S3_REGION?.trim() || "us-east-1",
      secretAccessKey: env.RAW_S3_SECRET_ACCESS_KEY,
    });
    return { kind: "s3", store: new DurableObjectStore(client) };
  }

  return {
    kind: "filesystem",
    store: new FilesystemObjectStore(
      env.RAW_OBJECT_STORE_PATH?.trim() ||
        path.join(process.cwd(), ".data", "raw-objects")
    ),
  };
};
