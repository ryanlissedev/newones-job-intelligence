# Automatic production deploy

This runbook describes the bounded application release lane. It deploys the
server, web application, and search projector from one immutable `main` SHA.
It does not run migrations, backfills, worker changes, search generation, or
any other durable data repair. Those operations require their separately
approved operator path.

## Trigger and safety boundary

`.github/workflows/deploy-production.yml` listens only to a successful `CI`
`workflow_run` for a `push` to `main`. The candidate is the event's full
40-character `head_sha`; the workflow checks out that exact SHA. Its
`production-deploy` concurrency group is serialized and never cancels an
active release.

The job enters the protected GitHub `production` environment. The release gate
runs before the Coolify credential is made available to a step. The driver is
disabled unless the protected variable `PRODUCTION_DEPLOY_ENABLED` is exactly
`1` or `true`; leave it unset/false until the first Coolify sequence has been
witnessed by an operator.

The SSH route remains the existing configured host route unless the protected
variable `PRODUCTION_DEPLOY_TAILSCALE_ENABLED` is exactly `1`. When enabled,
the job first joins the production tailnet with an ephemeral
`tag:catapulze-deploy` node,
waits for `COOLIFY_SSH_TAILSCALE_HOST` to answer, and then uses the Tailscale
host and known-hosts variables for the same pinned SSH tunnel. The opt-in
action is pinned to `tailscale/github-action` v4.1.3; it does not change the
Coolify API or deployment ordering.

The successful release gate writes a short-lived, sanitized evidence file. The
deploy driver reads and rechecks that file immediately before its first
application PATCH, together with a fresh `main` ref read. A GitHub deployment
ledger entry is created before any Coolify mutation and marked `in_progress`.
The workflow refuses to acquire the lease while another production ledger entry
is queued or in progress. Its description and JSON payload carry the workflow,
run, attempt, job, and candidate SHA, so a retry cannot be confused with a
different release.

## Release ledger predicate

A job that declares `environment: production` makes GitHub create its own
deployment record for that environment before the job runs its first step. That
record is not a release. It carries an empty `payload`, a null `description`,
and an `in_progress` status for the lifetime of the job. Reading every record
under `GET /repos/{repo}/deployments?environment=production` as a release
therefore makes the lane block on itself: the first run saw its own record,
refused to continue, and left a `failure` status behind that blocked every
later run as well.

Only records release tooling wrote itself count as release ledger entries. The
workflow writes a JSON payload of `workflow`, `workflow_run_id`, `run_attempt`,
`job`, and `candidate_sha`, plus a description that starts with `Automatic
production release`. The operator lane writes `source`,
`candidate_sha`, `release_sha`, and `roles` instead. A record counts as a
ledger entry only when its payload parses, carries a full 40-character
lowercase `candidate_sha`, and names its provenance with a non-empty
`workflow` or `source`. GitHub returns `payload` as an object on some routes
and as a JSON string on others, so both forms are parsed. Anything else is one
of GitHub's own environment records and is ignored by the gate, by the deploy
driver, and by the lease step. `scripts/production/release-gate.ts` exports the
predicate as `isReleaseLedgerEntry` and every filter uses it.

Ignoring a record is not the same as passing. When the production environment
holds no ledger entry at all, the gate still fails closed with
`missing_actual_deployed_sha` rather than falling back to an environment
record's SHA.

## Seeding the baseline

The ledger predicate means an environment that has never run this lane has no
release ledger entry, so the gate has nothing to compare against. Before first
enablement the operator seeds exactly one entry through the same API shape the
workflow uses. Create a production deployment whose `ref` is the SHA that is
actually running, with payload
`{workflow:"Deploy production", workflow_run_id:"manual", run_attempt:"1", job:"seed", candidate_sha:<deployed sha>}`,
then post a `success` status on it. The `ref` and the payload `candidate_sha`
must be the same SHA: a record whose payload SHA does not match the deployment
SHA is not treated as a ledger entry. Set
`PRODUCTION_LAST_DEPLOYED_RELEASE_JSON` to match that entry, including its
deployment id, its release SHA, and the three component SHAs read back from
Coolify. The seed entry and the protected variable must agree; the gate and the
driver both read them and both fail closed on a mismatch.

Seeding is a one-time step for the first release only. After that the baseline
rotates automatically. On a successful release the deploy driver writes the
complete new baseline into its outcome file, carrying the ledger deployment id,
the candidate SHA, and the three component SHAs it read back from Coolify. The
finalize step then writes that JSON to the `production` environment variable
`PRODUCTION_LAST_DEPLOYED_RELEASE_JSON`, updating it in place or creating it if
it does not exist yet. Rotation runs only after the ledger status is recorded
as `success`, so a failed or rolled-back release leaves the previous baseline
untouched and the next run still compares against the last release that
actually reached production. The job needs `actions: write` for this one call.
If rotation fails the job fails even though the deployment succeeded, because
an unrotated baseline blocks the next release.

## Review modes

`RELEASE_GATE_REVIEW_MODE` selects how the gate accepts review evidence. It is
supplied to the gate step from the repository variable of the same name. An
unset or empty value means `trusted-approver`. Any value other than
`trusted-approver` or `solo` blocks the release with `invalid_review_mode`
rather than falling back to a weaker rule.

In `trusted-approver` mode, every associated merged PR needs an exact-head
formal `APPROVED` review from a reviewer other than the author whose repository
permission is `write`, `push`, `maintain`, or `admin`.

In `solo` mode that approval is not required. Every associated merged PR must
still have no `CHANGES_REQUESTED` decision, no unresolved review threads, and
exactly one successful `claude-review` check run on the PR head SHA produced by
the GitHub Actions app. The same check-run trust rules apply, so a check from
any other app or a check that is not a completed success blocks the release.

Know what that check does and does not prove. `claude-code-review.yml` runs in
comment mode: it posts its findings on the PR and reports success as long as
the review job itself completed, whatever verdict the review reached. A
successful `claude-review` check therefore means the automated review ran on
that head, not that it approved. The gate also confirms the check came from the
`claude-code-review.yml` workflow run for that exact head, so a check with the
same name from any other workflow blocks with `untrusted_check`.

That leaves `solo` mode with exactly two vetoes that can actually stop a
release: an unresolved review thread and a `CHANGES_REQUESTED` decision. If the
automated review finds something that must block the release, a human has to
turn it into one of those two, or add the `release-blocker` label to an issue.
Reading the review and acting on it stays a human step.

`solo` is acceptable only where the repository has a single collaborator, which
makes the non-author approval rule impossible to satisfy rather than merely
inconvenient. It is not an escape hatch for an unreviewed change: the automated
review must still have run on the exact head. As soon as a second collaborator
with write permission exists, move the variable back to `trusted-approver`.

The protected environment supplies these names (values are never committed or
printed):

| Name | Purpose |
| --- | --- |
| `COOLIFY_SERVER_APPLICATION_UUID` | server application UUID |
| `COOLIFY_WEB_APPLICATION_UUID` | web application UUID |
| `COOLIFY_PROJECTOR_APPLICATION_UUID` | projector application UUID |
| `COOLIFY_API_TOKEN` | protected Coolify bearer credential |
| `COOLIFY_SSH_HOST` | private Coolify host name or address |
| `COOLIFY_SSH_USER` | restricted SSH tunnel user |
| `COOLIFY_SSH_PORT` | SSH port, normally `22` |
| `COOLIFY_SSH_KNOWN_HOSTS` | pinned host-key record for the tunnel target |
| `COOLIFY_SSH_PRIVATE_KEY` | process-scoped protected SSH private key |
| `COOLIFY_SSH_TAILSCALE_HOST` | verified Tailscale IP or MagicDNS name for the Coolify host when the opt-in route is enabled |
| `COOLIFY_SSH_TAILSCALE_KNOWN_HOSTS` | pinned host-key record whose hostname matches `COOLIFY_SSH_TAILSCALE_HOST` |
| `PRODUCTION_DEPLOY_TAILSCALE_ENABLED` | protected route switch; only the exact value `1` enables the ephemeral Tailscale step |
| `TS_OAUTH_CLIENT_ID` | protected Tailscale OAuth client ID used only by the ephemeral-node action |
| `TS_OAUTH_SECRET` | protected Tailscale OAuth client secret used only by the ephemeral-node action |
| `PRODUCTION_API_URL` | public API origin; currently the `api.<hetzner-ip-dashed>.sslip.io` rehearsal origin |
| `PRODUCTION_WEB_URL` | public web origin; currently the `app.<hetzner-ip-dashed>.sslip.io` rehearsal origin |
| `PRODUCTION_PROJECTOR_SCHEMA_HASH` | expected search projector schema hash |
| `PRODUCTION_PROJECTOR_RUNTIME_URL` | `${PRODUCTION_API_URL}/projector/runtime`; the API serves the projector's own runtime row (release SHA, container id, cycle count, heartbeat age) and answers 200 only while the heartbeat is under 60 seconds old |
| `PRODUCTION_WEB_VERSION_URL` | `${PRODUCTION_WEB_URL}/version`; the web route handler echoes `APP_RELEASE_SHA`, else Coolify's `SOURCE_COMMIT`, and answers 503 without an identity |
| `PRODUCTION_LAST_DEPLOYED_RELEASE_JSON` | protected, verified complete-release ledger baseline with release id, SHA, and server/web/projector SHAs |

The complete-release baseline is required. The gate and driver independently
read back its GitHub `production` deployment and successful status, then compare
its three component SHAs with Coolify's newest finished deployment identities.
The workflow records a deployment only after all Coolify and public readbacks
pass, so the next release compares the entire accumulated diff from the last
successful release rather than only the latest PR.

## Release gate

`bun scripts/production/release-gate.ts` is read-only. It checks the current
`main` ref before and after the gate, requires the candidate to be a strict
descendant of the actual deployed SHA, and fails closed on malformed or
truncated GitHub responses.

The candidate must have at least one merged PR whose merge commit is exactly
the candidate SHA. Every associated merged PR is checked for an active
`CHANGES_REQUESTED` decision and every page of unresolved GraphQL review
threads. In `trusted-approver` mode the gate requires an exact-head formal
`APPROVED` review from a different reviewer whose repository permission is
`write`, `push`, `maintain`, or `admin`, and a bare successful Claude workflow
does not satisfy that requirement. In `solo` mode a successful `claude-review`
check on the PR head replaces the approval. Missing review evidence, an
untrusted approver, or malformed pagination blocks the release in either mode.
The evidence output records the mode it ran under as `reviewMode`.

The gate requires trusted GitHub Actions runs for the exact SHA and exact
workflow/job identity: `CI` jobs `changes`, `verify`, `build`,
`application-image-smoke`, `mcp-edge-smoke`, and `postgres-restore-drill`, plus
React Doctor when the candidate changes the web surface. UI changes in
`apps/web`, `packages/ui`, or `e2e` require one successful `Browser evidence`
check from `Search audit evidence` on the exact PR head SHA. Check runs are
accepted only when their GitHub Actions app identity is present.

The whole comparison from the previous deployed SHA is inspected. Migration
and data-repair paths block the normal lane with a handoff reason, including
`packages/db/src/migrations/**`, `scripts/backfill-neon-v1.ts`,
`packages/application/src/backfill/**`, `packages/connectors/**`,
`apps/worker/**`, `tools/backfill/**`, and the migration tooling paths. The
connector and backfill blocks prevent a stateless release from claiming that
the separately deployed Trigger worker or durable repair lane was updated.
Open unrelated issues and PRs do not block; an open issue with the
`release-blocker` label does.

## Coolify sequence and rollback

`bun scripts/production/ssh-tunnel.ts -- bun scripts/production/coolify-deploy.ts`
starts a pinned, local-only SSH forward to the private Coolify 4.3.14 API
under `/api/v1`. The deployment child receives only
`http://127.0.0.1:18000/api/v1`; port 8000 is never addressed publicly.

The tunnel writes the injected private key and known-hosts record under a
0600 temporary directory, uses `StrictHostKeyChecking=yes`,
`ExitOnForwardFailure=yes`, and `IdentitiesOnly=yes`, and removes the files and
terminates the tunnel in a `finally` cleanup after the deployment child exits.
The private key is not passed to the child process or printed.

### Optional Tailscale route

Provision the following in the protected GitHub `production` environment before
setting `PRODUCTION_DEPLOY_TAILSCALE_ENABLED=1`:

- `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` for a Tailscale OAuth client with
  the minimum writable `auth_keys` scope, restricted to issuing
  `tag:catapulze-deploy`. Select this tag on the client, or use a documented
  tag-owner chain that grants it. Do not grant this client `tag:catapulze-prod`
  or a wildcard tag. Reserve ownership of the deploy tag for this automation.
- `COOLIFY_SSH_TAILSCALE_HOST`, normally the verified `catapulze-prod`
  MagicDNS name or `<tailscale-ip>` address.
- `COOLIFY_SSH_TAILSCALE_KNOWN_HOSTS`, captured from the same host and pinned
  to the verified SSH key. Its host field must match
  `COOLIFY_SSH_TAILSCALE_HOST`.

Tag the production box as `tag:catapulze-prod` and add the following narrow,
additive Tailscale grant to the existing tailnet policy:

```json
{
  "grants": [
    {
      "src": ["tag:catapulze-deploy"],
      "dst": ["tag:catapulze-prod"],
      "ip": ["tcp:22"]
    }
  ]
}
```

Tailscale policy entries are additive and have no deny rule that can undo a
broader grant. Preserve existing member and production connectivity. If the
existing member/prod rule uses `src: ["*"]`, replace that source only after a
tailnet inventory confirms every intended user, shared user/device identity,
tag, subnet, and CIDR range; preserve each intended source explicitly. Do not
assume that enumerating tags covers shared users, devices, subnet routers, or
other routed ranges. A wildcard destination may remain in that existing
member/prod rule when it is intentional, but the deploy grant above must keep
its exact source tag, exact production destination, and `tcp:22` restriction.
The deploy tag must not be included in any broader source set.

The workflow validates all four Tailscale inputs without printing their values.
The action's `ping` input then verifies the configured target before the SSH
tunnel starts. Keep the production box's public SSH firewall closed to GitHub
runner addresses; this route does not require opening port 22 globally and does not
use a self-hosted runner on the production box. Leave the switch unset or
different from `1` until the OAuth client, tag, grant, target host, and matching
known-hosts record have each been tested by an operator.

The grant above permits only TCP 22 from the deploy tag to the production tag.
It does not permit database, Coolify HTTP, or other service ports. The
`COOLIFY_SSH_TAILSCALE_KNOWN_HOSTS` record must be captured from that same
target and its host field must exactly match `COOLIFY_SSH_TAILSCALE_HOST`
(including the MagicDNS name or address used by the action); otherwise strict
host-key checking must fail closed.

After policy propagation, test the boundary from a node carrying
`tag:catapulze-deploy`: TCP 22 to the tagged production host must connect;
UDP 22, TCP 80/443, and TCP 22 to an untagged host must all be denied. Run the
same checks from a member and production node to confirm their existing access
was preserved.

The Coolify sequence is:

1. Read every application's current `git_commit_sha` and active deployment list.
2. Immediately before each mutation and each deploy POST, verify GitHub
   `refs/heads/main` still equals the candidate.
3. Sequentially `PATCH /applications/{uuid}` with the full candidate SHA, then
   `POST /deploy?uuid={uuid}&force=true`.
4. Poll `GET /deployments/{deployment_uuid}` until a bounded terminal state,
   requiring an exact candidate commit in deployment detail. A missing or
   unsupported status/identity is a hard failure.
5. Read the application back as the expected UUID, candidate SHA, and healthy
   state before advancing to the next role.

The role order is server, web, projector. Server readback requires
`/version.releaseSha`, `/livez` 200, and `/readyz` 200 with overall `ready` and
no `unavailable`, `migration_mismatch`, or `schema_hash_mismatch` reason. Web
readback requires `/` 200 and unauthenticated `/dashboard` 307. Projector
readback requires `/readyz.components.searchProjection.status` `ok` and the
configured schema hash.

The driver keeps the configured SHA and newest finished Coolify deployment SHA
as separate observations for every application. All three pairs must agree on
one trusted baseline before a mutation is allowed. After deployment, server
`/version` and web `/version` are checked against the candidate; the web
dashboard must redirect to `/login` on the same web origin, and the projector
runtime endpoint must attest the active candidate container, cycle counter, and
fresh heartbeat in addition to the readiness schema hash.

The projector has no HTTP surface of its own. Every drain cycle it records its
release SHA, container id, process cycle count, and heartbeat time in the
`search_projector_runtime` table, at most once per fifteen seconds. The API
reads that row at `/projector/runtime`. A container that lost the advisory lock
or stopped draining stops refreshing the row, so its evidence goes stale within
one minute and the driver refuses the release.

Do not restart the projector by stopping it in Coolify. Stopping the projector
through Coolify removes its container, and `start` does not recreate it, so the
application stays down and its runtime row goes stale. Bring it back with the
deploy endpoint against the commit it should run:
`PATCH /applications/{uuid}` with the pinned SHA, then
`POST /deploy?uuid={uuid}&force=true`. Confirm recovery by reading
`/projector/runtime` for the expected release SHA, a moving cycle counter, and
a heartbeat under sixty seconds old. The same rule applies to the server and
web applications.

Every application mutation records its prior configured SHA. A failure rolls
back all mutated stateless applications in reverse order, including the role
that was partially changed, and repeats deployment identity and application
health checks. The lane never rolls back database migrations, data, raw
objects, or search-generation metadata. If rollback cannot be verified, the
workflow stops with an operator-recovery reason and the existing Coolify and
database runbooks become authoritative.

The sequence has a single absolute deadline shorter than the GitHub job limit.
The final part of that budget is reserved for cancelling a still-active
deployment and rolling back mutated roles. A timeout first settles the active
Coolify deployment before rollback starts; if the reserve is exhausted or a
child remains active, the ledger records an error and the job fails closed.

## First enablement

The release that introduces this lane also introduces migration
`0023_search_projector_runtime`. The gate blocks migration paths by design, so
that first rollout goes through the operator migration path
(`docs/runbooks/neon-migration-catchup.md`) before `PRODUCTION_DEPLOY_ENABLED`
is ever set. Until the table exists, `/projector/runtime` answers 503 and every
projector readback fails closed.

Keep `PRODUCTION_DEPLOY_ENABLED` false while validating the protected variables,
the three UUIDs, the status/detail response shape, and the temporary public
origins. The first enabled run is a witnessed rehearsal. Confirm the sanitized
workflow summary contains only the candidate SHA, role, deployment UUID,
deployment state, previous SHA, HTTP statuses, and fixed reason codes. Never
put a Coolify token, resolved environment file, database URL, or raw provider
response in logs or artifacts.
