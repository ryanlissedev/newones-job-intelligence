# Trigger.dev → on-box Postgres cutover (RJC-418 remainder)

Status: **Operator one-shot** — Coolify apps already use on-box `ji_*`
(`DATABASE_URL` / `PROJECTOR_DATABASE_URL` / `MIGRATION_DATABASE_URL`).
Remaining gap: Trigger.dev Cloud prod still points at Neon, and Hetzner
firewall `catapulze-prod` must allow Trigger **static egress IPs** on TCP 5432.

Catapulze owns Coolify mutate + this firewall work. This agent lane has **no**
Trigger.dev API and must **not** print secret values or connection strings
with credentials.

Related: [ADR-0011](../adr/ADR-0011-postgres-on-box-trigger-static-ips.md),
[postgres-on-box.md](postgres-on-box.md), [hetzner-deploy.md](hetzner-deploy.md)
§ worker env, [search-projector.md](search-projector.md).

## Preconditions (already true when Coolify `/readyz` is 200 on-box)

- Coolify Postgres resource live; server/projector/migrator/web use on-box
  `ji_app` / `ji_migrator` URLs on the private Coolify network.
- Motian backfill stays untouched (separate `MOTIAN_*` / Neon import path).
- Worker production mode is `SEARCH_PROJECTOR=onbox` (worker does **not** need
  `MANTICORE_URL` or `PROJECTOR_DATABASE_URL`).

## Env inventory — Trigger.dev **prod** only

Set / flip these in the Trigger.dev dashboard → project → **Environment
Variables** for the **prod** environment (not Coolify). Names only — values
come from 1Password / Coolify Postgres UI; never paste passwords into chat,
issues, or git.

| Variable | Required | Cutover action |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | Replace Neon URL with on-box **app-role** URL (`ji_app`) reachable from the public internet on the published Postgres host:port (TLS/`sslmode` as required by the Coolify resource). Same logical DB as Coolify runtime — **not** admin, **not** migrator, **not** Motian. |
| `SEARCH_PROJECTOR` | yes for prod | Must be `onbox` (already the production contract). |
| `RAW_S3_BUCKET` / `RAW_S3_ENDPOINT` / `RAW_S3_REGION` / `RAW_S3_ACCESS_KEY_ID` / `RAW_S3_SECRET_ACCESS_KEY` | if ingest writes raw objects | Unchanged by SoR cutover; keep aligned with server. |
| `TRIGGER_SECRET_KEY` | deploy / programmatic trigger | Unrelated to DB host; RJC-373 if still open. |
| `MANTICORE_URL` | **no** when `onbox` | Leave unset / remove so workers cannot accidentally drain. |
| `PROJECTOR_DATABASE_URL` / `MIGRATION_DATABASE_URL` / `POSTGRES_*` | **no** on Trigger | Coolify-only. Do not put migrator/admin into Trigger. |

Worker code path: `packages/env/src/database.ts` and
`apps/worker/src/poll-bron-env.ts` require only `DATABASE_URL` (+ projector
mode). No code change is required for the URL flip.

## One-shot procedure (Ryan / Catapulze)

Do **not** flip `DATABASE_URL` before the firewall allowlist is in place, or
polls fail closed on connect timeout.

### 1) Confirm Postgres is reachable only via allowlist

Coolify apps stay on the internal network. For Trigger Cloud, the Coolify
Postgres resource must expose TCP **5432** (or the resource’s published host
port) on the server’s public IPv4 **and** Hetzner Cloud Firewall must deny
everyone else.

Inspect current rules (no secrets):

```bash
hcloud firewall describe <hetzner-firewall-id>
# name: catapulze-prod
```

Expect: 80/443 public; 22 restricted; **no** world-open 5432. After step 3,
5432 inbound exists **only** from Trigger static IPs (plus any explicit
operator bastion you already trust).

External negative probe from a non-allowlisted host must show 5432 closed
(timeout / filtered), not an open Postgres banner.

### 2) Enable / copy Trigger.dev static egress IPs

Paid Trigger plan required (free = dynamic IPs → cannot allowlist).

1. Open Trigger.dev dashboard → **Regions**.
2. Prefer region closest to the box (Hetzner `nbg1` → start with
   `eu-central-1` unless prod already pinned elsewhere).
3. Copy the **static IP addresses** shown for that region (paid plans only).
4. Keep the list in the operator scratchpad / password manager — not in git.

Official refs: [Static IPs changelog](https://trigger.dev/changelog/static-ips),
[Launchweek AWS regions](https://trigger.dev/launchweek/2/4x-concurrency-static-ips-aws).

### 3) Add static IPs to Hetzner firewall `catapulze-prod`

For each Trigger static IPv4 `A.B.C.D`:

```bash
hcloud firewall add-rule <hetzner-firewall-id> \
  --direction in --protocol tcp --port 5432 \
  --source-ips A.B.C.D/32 \
  --description "Trigger.dev static egress (RJC-418)"
```

Or edit via Console → Firewalls → `catapulze-prod` → inbound TCP 5432 from
those `/32`s only. Re-run `hcloud firewall describe <hetzner-firewall-id>` and confirm
rule count matches the Regions list.

### 4) Flip Trigger prod `DATABASE_URL`

In Trigger.dev → Environment Variables → **prod**:

1. Build the on-box app-role URL offline (1Password / Coolify Postgres
   connection panel). Host = public IPv4 or DNS that resolves to the box;
   user = `ji_app`; database = production DB name; port = published 5432
   (or Coolify-mapped port).
2. Update `DATABASE_URL` only (preview vs production env rows if the UI
   splits them — set **prod**).
3. Confirm `SEARCH_PROJECTOR=onbox`.
4. Do **not** paste the URL into Linear, Slack, PR text, or shell history
   dumps. Prefer dashboard paste / `op` inject.

No Coolify env change in this step (already on-box).

### 5) Prove the write path

1. Wait for one `poller_source` line from the on-box poller (`docs/runbooks/onbox-poller.md`) in
   **prod**.
2. Run status must be **succeeded** (not connect / timeout / SSL errors).
3. On-box projector: `searchProjection` lag 0 after outbox drain (Coolify
   projector logs / `/readyz`).
4. Optional: compare one new `curated.*` row timestamp to the Trigger run id
   (read-only SQL as `ji_app` or `ji_readonly` — do not log the URL).

### 6) Rollback (if polls fail)

1. Set Trigger prod `DATABASE_URL` back to the previous Neon app URL.
2. Leave firewall rules in place (harmless) or remove the new 5432 `/32`
   rules if you want the previous posture.
3. Coolify stays on-box — do not bounce Coolify back to Neon for a Trigger
   failure.

## Done when

- [ ] Trigger Regions static IPs recorded for the active prod region
- [ ] `hcloud firewall describe <hetzner-firewall-id>` shows TCP 5432 only from those `/32`s
- [ ] Trigger prod `DATABASE_URL` is on-box `ji_app` (no Neon host)
- [ ] `SEARCH_PROJECTOR=onbox`; no `MANTICORE_URL` on Trigger prod
- [ ] At least one prod poll **succeeded** (a `poller_source` line without `errorName`)
- [ ] Projector lag 0 / Coolify `/readyz` still 200

Then RJC-418 ops DoD can close aside from any remaining R2 restore-drill
items tracked under RJC-405.

## Explicit non-goals

- No Coolify API/UI mutation from this runbook’s agent lane.
- No Motian backfill / Neon import changes.
- No printing of passwords, tokens, or full connection strings.
- No opening 5432 to `0.0.0.0/0`.
