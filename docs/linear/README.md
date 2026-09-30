# Linear setup — Job Intelligence

> Historical import pack of 2026-08-27. This directory documents how the Job Intelligence board was created; it is not kept in sync. For current issue state, priorities and statuses, see the live Linear project.

The live Linear workspace is available and DEC-005 is recorded as `RJC-321` (`Done`). This directory remains the reproducible source/import pack for the Job Intelligence board; U10 (`RJC-347`) deliberately remains open.

**Answer to “should we create all slices?”:** yes — as **roadmap containers**. Only **Slice A** is fully issued with acceptance criteria. Slice B/C are placeholder epics; Candidate Intelligence and Company OS are epic stubs with no build children.

## What this pack creates

| Container | Linear shape | Spec depth |
|---|---|---|
| **Gate 0** | Milestone + `gate-0` label + parent issue | DEC-001..008 as **product decisions**, not engineering tasks |
| **Slice A** | Milestone + `slice-a` + parent epic | Full U1–U10 issues (goal, AC, blocked-by, plan/PR links) |
| **Slice B** | Milestone + `slice-b` + parent epic | Four placeholders, all blocked on **DEC-006** |
| **Slice C** | Milestone + `slice-c` + parent epic | Four placeholders — **not** one issue per of 23 bronnen |
| **Later** | Milestone + `later` | Two epic stubs, zero build issues |

Project name: **Job Intelligence**. Preferred team: **Catapulze** or **Job Intelligence**.

Labels: `slice-a`, `slice-b`, `slice-c`, `gate-0`, `later`, `blocked`.

Statuses: Slice B/C/Later → **Backlog**. Slice A **U1–U3** → **Todo** if the team has an active cycle, otherwise **Backlog**. Remaining Slice A units → **Backlog**.

Assignees: none, unless you run the apply script as Ryan Lisse (`<owner-email>`) with `LINEAR_ASSIGN_IF_RYAN=1`.

## Files

| File | Use |
|---|---|
| [`issues.mjs`](issues.mjs) | Source of truth (catalog + descriptions) |
| [`job-intelligence-import.json`](job-intelligence-import.json) | Machine-readable dump |
| [`job-intelligence-import.csv`](job-intelligence-import.csv) | Linear CSV importer (titles/descriptions/labels/status). **Does not** create projects, milestones, parent/sub-issues, or blocked-by relations — use the apply script for those |
| [`apply.mjs`](apply.mjs) | Idempotent GraphQL apply: team, project, milestones, labels, issues, relations |

## Preferred: apply via API key

1. In Linear: **Settings → Account → API → Personal API keys** → create a key with issue/project write on the Catapulze workspace. Name it `cursor-job-intelligence-import`.
2. Put it in the cloud environment as secret **`LINEAR_API_KEY`** (value starts with `lin_api_`).
3. Re-run this agent, or locally:

```bash
export LINEAR_API_KEY=lin_api_...
node docs/linear/apply.mjs
```

Optional env:

- `LINEAR_TEAM_NAME=Catapulze` / `LINEAR_TEAM_KEY=CAT` / `LINEAR_TEAM_ID=...`
- `LINEAR_ASSIGN_IF_RYAN=1` — assign only if the key’s user email is `<owner-email>`
- `--dry-run` — resolve team/project, print creates, write nothing

The script reconciles deterministically by configured Linear identifier, stable catalog marker, catalog-id title and finally exact title. Updates retain the catalog marker, so issue renames do not create duplicates.

## Fallback: CSV import

Linear CSV import cannot set `blocked-by`, parent/sub-issues, or project milestones.

1. Linear → **Settings → Import** → CSV.
2. Use [`job-intelligence-import.csv`](job-intelligence-import.csv).
3. Map: Title, Description, Status, Priority, Labels. Create/select project **Job Intelligence**.
4. Manually: create milestones Gate 0 / Slice A / Slice B / Slice C / Later; nest children under the six parent issues; add blocked-by from the CSV `BlockedBy` column (catalog ids: `U1`, `DEC-006`, …).

Regenerate dumps after editing `issues.mjs`:

```bash
node docs/linear/apply.mjs --dump-json --dump-csv
```

## Exact issue list (32)

Plan for Slice A units: [`docs/plans/2026-08-27-2022-feat-slice-a-read-path-plan.md`](../plans/2026-08-27-2022-feat-slice-a-read-path-plan.md) · [PR #4](https://github.com/ryanlissedev/rsp-job-intelligence/pull/4)

### Gate 0 — product decisions (not engineering)

| Id | Title | Status |
|---|---|---|
| GATE-0 | Product decisions DEC-001..008 | Backlog (parent) |
| DEC-001 | Accepteer Ideal State Criteria en donderdagscope | Backlog |
| DEC-002 | Lever definitieve bronmatrix / deep dive | Backlog |
| DEC-003 | Leg schema en deduperegels vast | Backlog |
| DEC-004 | Leg searchcontract en SLO vast | Backlog |
| DEC-005 | Gebruik Postgres 16 on-box; Motian-Neon alleen als read-only importbron | Done (`RJC-321`) — **omgekeerd door [ADR-0006](../adr/ADR-0006-neon-as-system-of-record.md), 2026-08-31: Neon is nu de production system of record** |
| DEC-006 | Bevestig Spot/Spott-product, URL, API en sandbox | Backlog — **blocks Slice B** |
| DEC-007 | Stel scrape- en hostingbudget vast | Backlog |
| DEC-008 | Definieer raw-data-minimalisatie en retentie | Backlog |

### Slice A — fully issued (U1–U10)

| Id | Title | Blocked by | Status |
|---|---|---|---|
| SLICE-A | Job Intelligence read path | — | Backlog (parent) |
| U1 | Workspace skeleton and safety rails | — | Todo if cycle, else Backlog |
| U2 | Postgres core model and migrations | U1 | Todo if cycle, else Backlog |
| U3 | Bronregister and connector contract | U2 | Todo if cycle, else Backlog |
| U4 | TenderNed and Inhuurdesk connectors | U1, U3 | Backlog |
| U5 | Normalise, identity, lifecycle | U2, U3 | Backlog |
| U6 | Boolean parser, SearchAdapter, Manticore | U2, U5 | Backlog |
| U7 | Capability registry, REST, and MCP | U3, U6 | Backlog |
| U9 | Lean search UI | U7 | Backlog |
| U8 | Observability, Motian-Neon read-only backfill, e2e, review pack | U4, U5, U6, U7 | Backlog |
| U10 | On-box Postgres production hardening | U2 | Backlog — **open P0 production gate** |

Sequencing: U1 → U2 → U3. U8 and U9 may proceed in parallel after U7. U10 may proceed after U2, but remains open until private networking, protected persistence, monitoring/resource limits, continuous off-site WAL and an isolated restore are evidenced.

DEC-005 is inhoudelijk definitief in deze catalogus: de nieuwe Catapulze-database is Postgres 16 on-box vanaf P0. Motian-Neon blijft uitsluitend een read-only bron voor de historische U8-backfill. Productie vereist een beschermd persistent volume, private poort 5432, continue WAL/off-site backups met een bewezen restore, monitoring en resourceprioriteit voor Postgres. HA-behoefte of meetbare disk/RAM-concurrentie is de exit-trigger naar een aparte DB-host of managed PostgreSQL.

**Omgekeerd, 2026-08-31.** [ADR-0006](../adr/ADR-0006-neon-as-system-of-record.md) maakt Neon (managed Postgres) de production system of record; er komt géén dedicated on-box PostgreSQL-productie-instance. De alinea hierboven is bewust ongewijzigd gelaten als historisch record van het oorspronkelijke besluit — zie ADR-0006 voor de onderbouwing van de omkering en [docs/runbooks/neon-restore.md](../runbooks/neon-restore.md) voor de resulterende Neon-restore- en rolscheidingsverplichtingen (RJC-381). Dit is een lokale mirror van de ADR-tekst; de live Linear-tekst van `RJC-321` kon deze sessie niet worden gelezen (beide beschikbare Linear-MCP-verbindingen faalden — verkeerde workspace resp. verlopen token) en is dus niet geverifieerd tegen dit bestand.

### Slice B — placeholders, blocked on DEC-006

| Id | Title | Blocked by |
|---|---|---|
| SLICE-B | Controlled Spott.io export | DEC-006 |
| SB-API | API/MCP spike for Spott.io | DEC-006 |
| SB-APPROVAL | Snapshot-bound approval | DEC-006, U7 |
| SB-EXPORT | Idempotent export | DEC-006, SB-API, SB-APPROVAL |
| SB-RECEIPTS | Export receipts and ID crosswalk | DEC-006, SB-EXPORT |

### Slice C — placeholders (not per-source)

| Id | Title | Blocked by |
|---|---|---|
| SLICE-C | Source expansion and hardening | SLICE-A |
| SC-SOURCES | Remaining accepted sources (bucket) | SLICE-A, DEC-002 |
| SC-ALERTS | Anomaly alerting beyond Slice A silence events | U8 |
| SC-REPLAY | Replay and backfill runbooks | U8 |
| SC-LOAD | Load tests against the 200k Boolean SLO | U6, U8 |

### Later — epic stubs, no build children

| Id | Title |
|---|---|
| LATER-CI | Candidate Intelligence |
| LATER-OS | Company OS |

## Intentionally not created

- One issue per bron in `SOURCE_MATRIX.md` (23 sources)
- Full Spott.io write spec (`commit_export`, standing `approval_policy`, retries/DLQ, sandbox e2e)
- Candidate matching / ranking / screening / auto-reject
- Company OS runtime beyond the epic stub
- Indeed (JI-007) as a Slice A build ticket
- Rung-3 Playwright login connectors as build tickets
