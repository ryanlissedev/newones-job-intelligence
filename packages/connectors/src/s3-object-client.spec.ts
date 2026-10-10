import { describe, expect, it } from "bun:test";

import type { ScrapeRunId } from "@ji/domain";

import {
  buildContentAddressedRawObjectPath,
  buildRawObjectPath,
  hashContent,
  RawObjectDigestMismatchError,
  RawObjectMetadataMissingError,
} from "./object-store";
import { S3ObjectClient } from "./s3-object-client";

const rawS3Bucket = process.env.RAW_S3_BUCKET;

// Mirrors packages/db's DATABASE_UPGRADE_TEST_URL gate: real S3 (MinIO
// locally) is required infrastructure, so the suite skips loudly instead of
// failing when nobody has it running.
const describeIfS3 = rawS3Bucket ? describe : describe.skip;

const s3Options = () => ({
  accessKeyId: process.env.RAW_S3_ACCESS_KEY_ID,
  // SAFETY: describeIfS3 only runs this suite's tests when rawS3Bucket is set.
  bucket: rawS3Bucket as string,
  endpoint: process.env.RAW_S3_ENDPOINT,
  region: process.env.RAW_S3_REGION ?? "us-east-1",
  secretAccessKey: process.env.RAW_S3_SECRET_ACCESS_KEY,
});

// SAFETY: fixed literal UUID used only as a branded-type fixture below.
const scrapeRunId = "11111111-1111-4111-8111-111111111111" as ScrapeRunId;

describeIfS3("S3ObjectClient (requires RAW_S3_BUCKET / MinIO)", () => {
  it("round-trips put -> get, preserving body/contentType/expiresAt", async () => {
    const client = new S3ObjectClient(s3Options());
    const body = new TextEncoder().encode(`hello-${crypto.randomUUID()}`);
    const contentHash = await hashContent(body);
    const path = buildContentAddressedRawObjectPath({
      bronSlug: "test-bron",
      contentHash,
      contentType: "json",
    });
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");

    await client.put({ body, contentType: "json", expiresAt, path });
    const stored = await client.get(path);

    expect(stored).not.toBeNull();
    expect([...(stored?.body ?? new Uint8Array())]).toEqual([...body]);
    expect(stored?.contentType).toBe("json");
    expect(stored?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
  });

  it("no-ops a second put of the same content-addressed path", async () => {
    const client = new S3ObjectClient(s3Options());
    const body = new TextEncoder().encode(`dup-${crypto.randomUUID()}`);
    const contentHash = await hashContent(body);
    const path = buildContentAddressedRawObjectPath({
      bronSlug: "test-bron",
      contentHash,
      contentType: "json",
    });
    const firstExpiresAt = new Date("2030-01-01T00:00:00.000Z");
    const secondExpiresAt = new Date("2031-01-01T00:00:00.000Z");

    await client.put({
      body,
      contentType: "json",
      expiresAt: firstExpiresAt,
      path,
    });
    // Second put with a different expiresAt must be a no-op after the
    // existing body's size and digest are verified; first metadata wins.
    await expect(
      client.put({
        body,
        contentType: "json",
        expiresAt: secondExpiresAt,
        path,
      })
    ).resolves.toBeUndefined();

    const stored = await client.get(path);
    expect(stored?.expiresAt.toISOString()).toBe(firstExpiresAt.toISOString());
  });

  it("rejects a second put whose body does not match its content-addressed path", async () => {
    const client = new S3ObjectClient(s3Options());
    const body = new TextEncoder().encode(`original-${crypto.randomUUID()}`);
    const contentHash = await hashContent(body);
    const path = buildContentAddressedRawObjectPath({
      bronSlug: "test-bron",
      contentHash,
      contentType: "json",
    });
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");

    await client.put({ body, contentType: "json", expiresAt, path });

    await expect(
      client.put({
        body: new TextEncoder().encode("different"),
        contentType: "json",
        expiresAt,
        path,
      })
    ).rejects.toBeInstanceOf(RawObjectDigestMismatchError);
  });

  it("retries a put when the sidecar exists but the body does not (crash recovery)", async () => {
    const body = new TextEncoder().encode(`recover-${crypto.randomUUID()}`);
    const contentHash = await hashContent(body);
    const path = buildContentAddressedRawObjectPath({
      bronSlug: "test-bron",
      contentHash,
      contentType: "json",
    });
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");

    // Simulate a crash between the two writes in put(): sidecar written,
    // body never was. The dedup short-circuit checks the BODY key only, so
    // a later put() for the same path must still write (not no-op).
    const bucket = new Bun.S3Client(s3Options());
    await bucket.write(
      `${path}.ji-meta.json`,
      JSON.stringify({
        contentType: "json",
        expiresAt: expiresAt.toISOString(),
      })
    );

    const client = new S3ObjectClient(s3Options());
    await client.put({ body, contentType: "json", expiresAt, path });

    const stored = await client.get(path);
    expect(stored).not.toBeNull();
    expect([...(stored?.body ?? new Uint8Array())]).toEqual([...body]);
  });

  it("returns null for a missing path", async () => {
    const client = new S3ObjectClient(s3Options());
    const stored = await client.get(
      `raw/test-bron/2030/01/${"0".repeat(64)}.json`
    );
    expect(stored).toBeNull();
  });

  it("rejects (not null) on wrong credentials", async () => {
    const client = new S3ObjectClient({
      ...s3Options(),
      accessKeyId: "wrong-access-key-id",
      secretAccessKey: "wrong-secret-access-key",
    });
    await expect(
      client.get(`raw/test-bron/2030/01/${"1".repeat(64)}.json`)
    ).rejects.toMatchObject({ code: "InvalidAccessKeyId" });
  });

  it("throws RawObjectMetadataMissingError when a body exists without its sidecar", async () => {
    const body = new TextEncoder().encode(`orphan-${crypto.randomUUID()}`);
    const contentHash = await hashContent(body);
    const path = buildContentAddressedRawObjectPath({
      bronSlug: "test-bron",
      contentHash,
      contentType: "json",
    });

    // Write the body directly through Bun.S3Client, bypassing
    // S3ObjectClient.put() so no `.ji-meta.json` sidecar is written —
    // simulates a crash between the two writes.
    const bucket = new Bun.S3Client(s3Options());
    await bucket.write(path, body);

    const client = new S3ObjectClient(s3Options());
    await expect(client.get(path)).rejects.toBeInstanceOf(
      RawObjectMetadataMissingError
    );
  });

  it("throws RawObjectDigestMismatchError when a content-addressed body is tampered with", async () => {
    const client = new S3ObjectClient(s3Options());
    const body = new TextEncoder().encode(`tamper-${crypto.randomUUID()}`);
    const contentHash = await hashContent(body);
    const path = buildContentAddressedRawObjectPath({
      bronSlug: "test-bron",
      contentHash,
      contentType: "json",
    });

    await client.put({
      body,
      contentType: "json",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      path,
    });

    // Write tampered bytes directly through Bun.S3Client under the same
    // content-addressed key, bypassing S3ObjectClient's own put().
    const bucket = new Bun.S3Client(s3Options());
    await bucket.write(path, new TextEncoder().encode("tampered-bytes"));

    await expect(client.get(path)).rejects.toBeInstanceOf(
      RawObjectDigestMismatchError
    );
  });

  it("skips digest verification for legacy (non-content-addressed) paths", async () => {
    const client = new S3ObjectClient(s3Options());
    const body = new TextEncoder().encode(`legacy-${crypto.randomUUID()}`);
    const path = buildRawObjectPath({
      bronSlug: "test-bron",
      contentType: "json",
      recordId: crypto.randomUUID(),
      runId: scrapeRunId,
    });

    await client.put({
      body,
      contentType: "json",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      path,
    });

    // Tamper directly — a legacy path has no embedded hash to verify against.
    const bucket = new Bun.S3Client(s3Options());
    await bucket.write(path, new TextEncoder().encode("different-bytes"));

    const stored = await client.get(path);
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored?.body)).toBe("different-bytes");
  });

  it("deleteExpired deletes only expired objects and returns the count", async () => {
    const client = new S3ObjectClient(s3Options());
    const expiredBody = new TextEncoder().encode(
      `expired-${crypto.randomUUID()}`
    );
    const liveBody = new TextEncoder().encode(`live-${crypto.randomUUID()}`);
    const expiredPath = buildContentAddressedRawObjectPath({
      bronSlug: "test-bron",
      contentHash: await hashContent(expiredBody),
      contentType: "json",
    });
    const livePath = buildContentAddressedRawObjectPath({
      bronSlug: "test-bron",
      contentHash: await hashContent(liveBody),
      contentType: "json",
    });
    const cutoff = new Date("2025-06-01T00:00:00.000Z");

    await client.put({
      body: expiredBody,
      contentType: "json",
      expiresAt: new Date("2025-01-01T00:00:00.000Z"),
      path: expiredPath,
    });
    await client.put({
      body: liveBody,
      contentType: "json",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      path: livePath,
    });

    const deletedCount = await client.deleteExpired(cutoff);

    expect(deletedCount).toBeGreaterThanOrEqual(1);
    expect(await client.get(expiredPath)).toBeNull();
    expect(await client.get(livePath)).not.toBeNull();
  });
});
