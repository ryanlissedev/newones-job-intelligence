# Raw object storage (RJC-386)

The server and worker share one durable store for raw connector payloads
(content-addressed and legacy object keys, both defined in
`packages/connectors/src/object-store.ts`). Before this change each side
constructed its own `FilesystemObjectStore` under `.data/raw-objects`; since
the cloud worker (Trigger.dev) and the server share no filesystem, the server
could never read back a payload ref the worker wrote, restarts lost payloads,
and replay was unreliable.

`createRawObjectStore` (`packages/connectors/src/s3-object-client.ts`,
exported only via the `@ji/connectors/s3-object-client` subpath — see
**Why a subpath export** below) picks the backend from environment:

- `RAW_S3_BUCKET` set → S3-compatible `S3ObjectClient` (Bun's built-in
  `Bun.S3Client`; no SDK dependency; any S3-compatible endpoint, including
  MinIO locally).
- `RAW_S3_BUCKET` unset → the worker-local `FilesystemObjectStore`
  (`RAW_OBJECT_STORE_PATH`, default `.data/raw-objects`).

Both `apps/server/src/slice-a-registry.ts` and
`apps/worker/src/poll-bron-run.ts` call the same factory with the same
environment variable names. They resolve to the same backend only when the
two deployments receive the same values; the shared factory is not proof of
environment parity.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RAW_S3_BUCKET` | Selects the S3 backend when set. |
| `RAW_S3_ENDPOINT` | S3-compatible endpoint URL (e.g. `http://127.0.0.1:9002` for local MinIO). Omit for real AWS S3. |
| `RAW_S3_REGION` | Defaults to `us-east-1`. |
| `RAW_S3_ACCESS_KEY_ID` / `RAW_S3_SECRET_ACCESS_KEY` | Credentials. |
| `RAW_OBJECT_STORE_PATH` | Filesystem root when the S3 backend is not selected. Defaults to `.data/raw-objects` under `cwd`. |

See `apps/server/.env.example` and `apps/worker/.env.example` for the local
MinIO defaults (commented out).

## Production guard

`createProductionSliceADeps` (`apps/server/src/slice-a-registry.ts`) throws on
startup when `nodeEnv === "production"` and the resolved store is the
filesystem backend, naming `RAW_S3_BUCKET` as the missing configuration —
same spirit as `assertProductionPersistence` in the same file, but for the
object store rather than a `SliceAStores` entry.

The ordinary poll worker enforces the same invariant in its own process:
`createPollBronRuntime` (`apps/worker/src/poll-bron-run.ts`) throws when
`process.env.NODE_ENV === "production"` and the resolved store is
`filesystem`. The production Motian backfill is independently fail-closed:
`resolveBackfillObjectStore` (`packages/db/src/backfill-runner.ts`) accepts
only a store with `kind: "s3"` when its explicit execution mode is
`production`; both the CLI and Trigger.dev backfill entrypoints pass their
factory result through that gate.

These are backend-kind guards, not deployment proof. The operator must still
verify that server and worker have exactly the same bucket, endpoint, region
and credentials (without logging secret values), and prove a live R2 write
and exact readback. The poll-worker guard also depends on the deployed worker
actually receiving `NODE_ENV=production`.

## Production provider (ADR-0008)

Production uses **Cloudflare R2** — decided in
[ADR-0008](../adr/ADR-0008-cloudflare-r2-for-raw-payloads.md)
(cost: base tier covers the estimated 45–90 GB many times over; box disk and
I/O stay reserved for Manticore; the replay source is decoupled from the box
it would replay after). The bucket, endpoint and credentials do not exist
yet — creating them is an operator action, and a credential-rotation
procedure still needs to be written (flagged in the ADR). Configuration is
the same five `RAW_S3_*` variables above, set identically on server AND
worker. MinIO below remains the local development target; both resolve
through the same `createRawObjectStore`, so switching providers is
configuration only.

## Local MinIO (docker-compose)

A `raw-storage-minio` / `raw-storage-minio-init` pair lives in the root
`docker-compose.yml` under `profiles: ["storage"]` — never started by a plain
`docker compose up`. It is named distinctly from `docker-compose.backup.yml`'s
own (pre-existing, unrelated) `minio`/`minio-init` WAL-G backup-drill overlay:
reusing that name would deep-merge the two service definitions whenever both
compose files are combined, silently changing an already-working feature.

```bash
docker compose --profile storage up -d --wait raw-storage-minio raw-storage-minio-init
# bucket `ji-raw-local` is created automatically by the init step (idempotent)

RAW_S3_ENDPOINT=http://127.0.0.1:9002 \
RAW_S3_BUCKET=ji-raw-local \
RAW_S3_REGION=us-east-1 \
RAW_S3_ACCESS_KEY_ID=minioadmin \
RAW_S3_SECRET_ACCESS_KEY=minioadmin \
bun test packages/connectors

docker compose --profile storage down
```

Ports default to `9002` (API) / `9003` (console) via
`RAW_STORAGE_MINIO_API_PORT` / `RAW_STORAGE_MINIO_CONSOLE_PORT` — chosen to
avoid colliding with the backup overlay's MinIO on `9000`.

Without `RAW_S3_BUCKET` set, `packages/connectors/src/s3-object-client.spec.ts`
skips its S3-backed suite with a clear message (mirrors the
`DATABASE_UPGRADE_TEST_URL` gating pattern in `packages/db`); the
`FilesystemObjectStore` specs still run.

**CI:** no MinIO service is wired into CI as part of this change — the S3
spec skips there the same way it does locally without the env vars. Wiring a
CI MinIO service (or running the S3 suite against a real bucket in CI) is
left as follow-up.

## Content addressing and digest validation

`buildContentAddressedRawObjectPath` (`packages/connectors/src/object-store.ts`)
builds keys as `raw/{bronSlug}/{yyyy}/{mm}/{sha256}.{contentType}`. `S3ObjectClient.get`
verifies the body's SHA-256 against the hash embedded in a content-addressed
path and throws `RawObjectDigestMismatchError` on mismatch — a corrupted or
tampered object is never returned as if valid. Legacy paths from the older
`buildRawObjectPath` scheme (`raw/{bronSlug}/{yyyy}/{mm}/{dd}/{runId}/{recordId}.{contentType}`)
carry no embedded hash and are read back unverified, so existing refs stay
readable.

`S3ObjectClient.put` treats a content-addressed path as idempotent: it does a
HEAD check (`exists()`) before writing, and skips the write entirely if the
key already exists. This is documented as an optimisation, not an atomic
guarantee — a concurrent writer could still race between the HEAD and the
PUT, since S3-compatible conditional writes vary by provider (see the
`ponytail:` comment on `S3ObjectClient.put`).

## Metadata convention

Bun's `S3Options` has no arbitrary-metadata header support today, so
`contentType` and `expiresAt` are not carried as S3 object metadata. Instead
`S3ObjectClient` writes a `{path}.ji-meta.json` sidecar object next to the
body — the same convention `FilesystemObjectStore` already uses for its local
`.ji-meta.json` sidecar files, so both stores read back the identical shape.

## Retention

`S3ObjectClient.deleteExpired(before)` lists the whole `raw/` prefix and
deletes objects whose sidecar `expiresAt` is at or before `before`. This is an
O(n) app-side fallback; production retention is expected to be a bucket
lifecycle rule instead. See the `ponytail:` comment on `deleteExpired` for the
scaling ceiling.

## Deferred follow-ups (out of scope for RJC-386)

- **`RawObjectMetadata` Neon/Postgres table.** The ticket's original scheme
  mentioned a database-backed metadata table for raw objects. This PR does
  not add one (migration slot 0007 is owned by a sibling lane, and the
  ticket's own scope note defers it) — object metadata lives only in the
  `.ji-meta.json` sidecar today.
- **zstd compression.** Skipped this round — no compression is applied to
  stored bodies. `Bun.zstdCompressSync` may be viable in a later pass; add
  `.zst` to the content-addressed path scheme and a round-trip test if so.
- **CI MinIO service.** Not wired up; the S3 suite skips in CI the same way
  it does locally without `RAW_S3_BUCKET`.
- **Live env-parity and R2 proof.** The fail-closed guards do not establish
  that the separately deployed server and worker received identical values,
  nor that the configured R2 bucket accepts a write and exact readback.

## Why a subpath export

`S3ObjectClient` and `createRawObjectStore` are exported only via
`@ji/connectors/s3-object-client`, not the package's main `"."` barrel
(`packages/connectors/src/index.ts`). They construct `Bun.S3Client`, which
needs Bun's ambient types (`@types/bun`). `apps/web`'s TypeScript program
reaches into `@ji/connectors`'s main barrel transitively (via
`apps/web/src/utils/trpc.ts`'s `import type { AppRouter } from "@ji/api/routers/index"`,
which pulls in `apps/server/src/slice-a-registry.ts`'s dependency graph) and
has no Bun ambient types configured — so re-exporting the S3 client from the
main barrel broke `web:check-types` with "Cannot find namespace 'Bun'".
Keeping it on a dedicated subpath (mirroring the existing
`@ji/connectors/lifecycle` pattern) means only Bun-runtime consumers
(`apps/server`, `apps/worker`) import it, and web's program never sees the
file at all.
