# Spott export reservation and recovery

Production export stays disabled until an explicit write client, real company/stage mapping, and the provider contract have been verified. Setting `SPOTT_LIVE=1` does not wire a write client into the production registry. Fixtures belong in explicit test dependencies. This runbook does not authorize production writes or historical crosswalk cleanup.

## Effect lifecycle

The durable effect key is `(scopeId, target, canonicalVacancyId, actionType)`. It is independent of the snapshot, so approving a new snapshot cannot bypass an existing reservation. Every invocation, including readback retries, must pass the current snapshot/approval and capability authorization checks.

| Durable state | Meaning | Next permitted action |
| --- | --- | --- |
| No reservation | No create has been reserved locally | Atomically reserve before calling the provider. Only the insert winner may POST. |
| `reserved`, no external ID | Create may be in flight, may have succeeded, or may never have started | Keep the reservation. Repeated calls must not POST. Investigate using the protocol below. |
| `external_id_acquired` | The external ID is durably known; confirmation is pending | GET that same ID. A failed GET, timeout, 404, or mismatched ID cannot authorize another POST. |
| `confirmed` | Readback matched the stored external ID | Return the persisted outcome or a truthful skip receipt. Never create again for this scoped key. |

An external ID is saved before confirmation. Confirmed finalization persists the crosswalk, attempt, receipt, and effect state transactionally. A newly finalized create requires matching readback. Replay skip receipts reuse existing crosswalk evidence and do not establish fresh provider confirmation; legacy crosswalk provenance requires separate investigation. An unconfirmed receipt means that confirmation was not established; it does not prove the remote create failed.

Attempt/result status describes the current invocation. A concurrent caller that encounters a reservation with no ID records a `failed` invocation and an unconfirmed receipt because it cannot proceed, even while the winning provider request is still running. The effect itself stays `reserved` with a pending or uncertain outcome. Neither the failed-attempt count nor that receipt authorizes a new create. Once the original caller saves the ID, a subsequent approved invocation can resume readback normally.

There is no reservation expiry, automatic release, or retry-POST policy. A crash after reservation but before POST deliberately favors preventing a duplicate over automatically recovering availability. A database failure after a successful POST may leave only the reservation: if the ID was committed, readback can resume; otherwise the outcome needs investigation.

## Unknown outcome without an external ID

1. Keep export disabled for the affected key and preserve its reservation and all attempts/receipts. Do not delete the row, change the scope/key, approve a new snapshot to bypass it, or retry POST based on elapsed time or an HTTP error.
2. Gather the scoped key, reservation and attempt timestamps, approval/snapshot IDs, and sanitized request/response evidence from the authorized environment. Do not copy credentials, vacancy payloads, or personal data into git or public evidence.
3. Check the current official provider contract and obtain provider-side evidence for the original request. A matching title or a list result alone is not a unique correlation. Do not assume an undocumented idempotency header, or treat an empty list/404 as proof that create never happened.
4. If the original external ID is established unambiguously, obtain separate authorization and use the reconciliation command below to review and bind that ID to the existing reservation with `manual_evidence` provenance. Supply references to the evidence and authorization. The command rejects an existing or conflicting binding. This internal operation does not itself create a confirmed receipt.
5. Confirmation remains a separate step through the normal approved export path, which GETs the bound ID. Production export remains disabled in this release; reconciliation does not enable that path. After the provider integration is separately verified and enabled, only matching readback may finalize the effect. If no ID can be established, leave the reservation blocked and escalate to the provider. This release supplies no reset or re-create operation for that case.

Production remediation is a separate change with read-only evidence and explicit authorization. Historical synthetic crosswalks must be investigated separately; this migration does not delete or reinterpret them.

## Supported reconciliation command

Run `bun run export:reconcile-spott` from the repository root. The command connects directly to the selected database; it does not call a server HTTP endpoint or the Spott API. Its scope is fixed to this deployment's `catapulze` scope, `spott` target, and `create` action. It can bind an externally verified ID only to an existing `reserved` effect with no ID or crosswalk.

Before using an authorized environment:

- Verify the original external ID and keep the supporting evidence in an appropriately restricted location. `--evidence-ref` and `--authorization-ref` are pointers the operator must verify. Each uses `namespace:identifier` format, at most 128 characters, with no URL or query string. They are not credentials, and accepting their text does not prove that the evidence or authorization exists.
- Identify the current approved snapshot, its matching unexpired approval, and the canonical vacancy included in both. Reconciliation validates those records again during apply.
- Use a signed Better Auth bearer for an authenticated administrator with both `ROLE_OPERATOR` and `PERM_EXPORT`. Actor identity and permissions come from authenticated records; the CLI accepts no actor or role arguments. The administrator session and valid snapshot approval establish the implemented authority. The command does not require two different approvers, and reference strings do not establish independent approval.
- Inject `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `SPOTT_EXPORT_RECONCILIATION_BEARER_TOKEN` into this process using the environment's approved secret manager. Confirm the selected database before running. The bearer belongs only in the process environment, never argv, copied commands, shell history, `.env.example`, or captured evidence. Use the environment's actual secret references; this runbook assumes no vault/item path. Do not print environment values or enable shell tracing.

The default operation performs a real database read in a read-only, repeatable-read transaction. It verifies the signed bearer and the current authentication records in that transaction, then returns one JSON line containing `mode: "dry-run"`, `applied: false`, `plan`, and `planHash`. It writes no reservation, receipt, or audit event. Snapshot and approval summaries contain bounded `resultCount` and `resultIdsHash` fields; the hash binds the ordered IDs without emitting the full lists. The approval summary also binds `actorId` and `motivationHash` without emitting the motivation text. Review the returned actor, scoped key, reservation state, selection summaries against the authorized snapshot, external ID, and both references before authorizing apply.

These arguments are synthetic syntax examples, not production instructions or authorization. Replace them only with values from the reviewed recovery case in an explicitly authorized environment:

```bash
bun run export:reconcile-spott -- \
  --scope catapulze \
  --canonical-vacancy-id 00000000-0000-4000-8000-000000000101 \
  --external-id spott-synthetic-recovered-001 \
  --snapshot-id 00000000-0000-4000-8000-000000000102 \
  --approval-id 00000000-0000-4000-8000-000000000103 \
  --evidence-ref evidence:synthetic-recovery-001 \
  --authorization-ref approval:synthetic-recovery-001
```

Apply requires explicit `--apply` and the exact 64-character `planHash` returned by that reviewed dry-run. Keep all other arguments unchanged. The placeholder below must be replaced by that returned hash; do not calculate or substitute a hash to bypass a stale plan:

```bash
bun run export:reconcile-spott -- \
  --scope catapulze \
  --canonical-vacancy-id 00000000-0000-4000-8000-000000000101 \
  --external-id spott-synthetic-recovered-001 \
  --snapshot-id 00000000-0000-4000-8000-000000000102 \
  --approval-id 00000000-0000-4000-8000-000000000103 \
  --evidence-ref evidence:synthetic-recovery-001 \
  --authorization-ref approval:synthetic-recovery-001 \
  --apply \
  --plan-hash '<planHash-from-reviewed-dry-run>'
```

Apply rechecks authentication, current approval, reservation state, and the plan hash in a serializable transaction. It atomically records the external ID with `manual_evidence` provenance, changes the effect to `external_id_acquired`, and appends a `reconcile_spott_export_id` audit event with the authenticated actor and evidence/authorization references. Successful output contains `mode: "apply"`, `applied: true`, the plan and hash, and `auditEventId`. Keep this output with the restricted recovery record; it proves the local binding and audit, not a provider readback.

If database connection cleanup fails after a successful dry-run or committed apply, the successful stdout result and exit code 0 are preserved. The CLI emits only the sanitized warning `{ "status": "warning", "code": "DATABASE_CLOSE_FAILED" }` on stderr. This warning does not undo the committed binding or authorize repeating the operation.

A missing reservation, existing ID or crosswalk, wrong scope, revoked permissions, expired/mismatched approval, or changed plan refuses the operation. The proposed external ID is also rejected with `EXTERNAL_ID_CONFLICT` when already bound to another canonical vacancy in the same scope, `spott` target, and `create` action. Reconciliation and the supported effect/crosswalk stores perform the same reverse ownership checks against both effects and crosswalks inside serializable transactions. When supported writers race after observing no owner, PostgreSQL aborts an incompatible transaction rather than allowing both bindings to commit. Treat a serialization failure as an uncertain local operation: inspect durable state before deciding whether to retry, and never replay a provider POST because of it. This is an application-level invariant across these supported writers, not a universal database uniqueness constraint for arbitrary SQL.

Refusals emit only `{ "status": "refused", "code": "..." }`. After a stale-plan refusal, inspect the changed state and obtain a new reviewed dry-run; never delete or reset the reservation to make apply succeed. The command provides no reset, replacement-ID, provider POST, or provider GET operation, and writes no crosswalk, export attempt, or confirmed receipt. Normal approved export confirmation remains separate and production export remains disabled.

## Public provider contract check

Checked on 2026-09-05 using the official [OpenAPI document](https://docs.spott.io/api-reference/openapi.json), **Spott API Reference 0.1**, and [API overview](https://docs.spott.io/docs/developers/api-overview.md). The downloaded OpenAPI SHA-256 was `750f32373626811966021fed21e308b3906789361b13dd5bd9e596b86143bff4`.

`POST /vacancies` declares no parameters, and `CreateVacancyDto` declares no external correlation key or idempotency key. The published OpenAPI contains no idempotency guarantee or external-key lookup contract. `GET /vacancies/{id}` documents a successful vacancy response and a 404, with no stated consistency window. These observations describe the published contract, not every behavior the provider might support privately.

Consequently this implementation sends no invented idempotency header and never treats an unknown result as safe to repeat. Provider support must establish the original ID or supply a separately reviewed recovery contract. Public schema inspection alone does not verify tenant credentials, company/stage mapping, sandbox behavior, or production readiness.

The current live schema also needs a separate adapter review before enabling writes: the mapper covers the documented required create fields, but uses fixture company/stage IDs and hardcoded business values with unverified tenant semantics. GET nests name, description, stage, and client data differently from the local DTO. Custom attributes are written after an ID is known, so they do not solve the ambiguous-create window. This safety repair intentionally leaves those integration prerequisites open.

## Verification boundaries

Pure regressions use explicit synthetic clients and stores. Database concurrency, transaction rollback, and migration tests require a disposable database after the RJC-425 guard is present. Full gates run in CI with at most two workers. No fixture receipt, local test, or successful migration establishes a live provider contract or production export readiness.
