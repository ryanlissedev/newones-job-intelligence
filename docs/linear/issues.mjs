/**
 * Linear import catalog for Catapulze Job Intelligence.
 * Source of truth for apply.mjs, CSV, and JSON dumps.
 *
 * Scoping: all slices exist as roadmap containers; only Slice A is fully issued.
 * Do not explode SOURCE_MATRIX into one issue per bron.
 */

export const PLAN_PATH =
  "docs/plans/2026-08-27-2022-feat-slice-a-read-path-plan.md";
export const PLAN_PR = "https://github.com/ryanlissedev/rsp-job-intelligence/pull/4";
export const REPO = "https://github.com/ryanlissedev/rsp-job-intelligence";

export const catalog = {
  meta: {
    generatedFor: "Catapulze Job Intelligence",
    date: "2026-08-27",
    scoping:
      "Create all slices as visible roadmap containers. Only Slice A is implementation-ready. Gate 0 holds product decisions, not engineering tasks.",
    sources: [
      PLAN_PATH,
      "docs/BUILD_BRIEF.md §10",
      "docs/IMPLEMENTATION_BACKLOG.md",
      "docs/SOURCE_MATRIX.md",
      "docs/README.md",
    ],
    intentionallyNotCreated: [
      "One Linear issue per of the 23 bronnen in SOURCE_MATRIX.md",
      "Full Spott.io write-path spec (commit_export, standing approval_policy, retries/DLQ, sandbox e2e)",
      "Candidate matching, ranking, screening, auto-reject, or ATS candidate-status writes",
      "Company OS runtime / typed action catalog beyond the epic stub",
      "Indeed (JI-007) as a Slice A build ticket",
      "Rung-3 Playwright login connectors as build tickets",
    ],
  },
  team: {
    preferredNames: ["Catapulze", "Job Intelligence"],
    preferredKeys: ["CAT", "JI"],
  },
  project: {
    name: "Job Intelligence",
    description:
      "Catapulze Job Intelligence: ingest aanvragen, Boolean search, then controlled Spott.io export. Slice A is the only implementation-ready vertical. Later slices are roadmap containers. Gate 0 holds DEC-001..008 as product decisions.",
    content: `Catapulze Job Intelligence roadmap.

**Slice A** is the only implementation-ready vertical (read path). **Slice B/C** and **Later** exist so the board shows the full BUILD_BRIEF §10 fasering without pretending those slices are specced for build.

Plan: [\`${PLAN_PATH}\`](${REPO}/blob/main/${PLAN_PATH}) · [PR #4](${PLAN_PR})
`,
  },
  milestones: [
    {
      key: "gate-0",
      name: "Gate 0",
      description:
        "Product decisions DEC-001..008. Not engineering tasks. Owners: Robbie (product) + Ryan (architecture).",
    },
    {
      key: "slice-a",
      name: "Slice A",
      description:
        "Job Intelligence read path plus the P0 database production gate. Full issues U1–U10. Implementation-ready from the 27 Aug plan.",
    },
    {
      key: "slice-b",
      name: "Slice B",
      description:
        "Controlled Spott.io export. Placeholder issues only. Blocked on DEC-006.",
    },
    {
      key: "slice-c",
      name: "Slice C",
      description:
        "Source expansion + hardening. Placeholders only — not one issue per bron.",
    },
    {
      key: "later",
      name: "Later",
      description:
        "Candidate Intelligence and Company OS epic stubs. No build issues until DPIA/grondslag (CI) and control-plane design (OS).",
    },
  ],
  labels: [
    { name: "slice-a", color: "#5E6AD2", description: "Slice A — Job Intelligence read path" },
    { name: "slice-b", color: "#F2C94C", description: "Slice B — controlled Spott.io export" },
    { name: "slice-c", color: "#26B5CE", description: "Slice C — source expansion + hardening" },
    { name: "gate-0", color: "#EB5757", description: "Gate 0 product decision (not an engineering task)" },
    { name: "later", color: "#9B51E0", description: "Later product — not in current build" },
    { name: "blocked", color: "#C52828", description: "Blocked on a Gate 0 decision or upstream issue" },
  ],
  issues: [
    // --- Gate 0 container + DEC issues ---
    {
      id: "GATE-0",
      title: "[Gate 0] Product decisions DEC-001..008",
      kind: "epic",
      milestone: "gate-0",
      labels: ["gate-0"],
      status: "Backlog",
      priority: 2,
      parent: null,
      blockedBy: [],
      description: gate0Epic(),
    },
    {
      id: "DEC-001",
      title: "[DEC-001] Accepteer Ideal State Criteria en donderdagscope",
      kind: "decision",
      milestone: "gate-0",
      labels: ["gate-0"],
      status: "Backlog",
      priority: 2,
      parent: "GATE-0",
      blockedBy: [],
      description: decIssue({
        id: "DEC-001",
        prio: "P0",
        owners: "Robbie + Ryan",
        readyWhen:
          "Read-only slice versus inclusief Spot/Spott staat schriftelijk vast.",
        notes: `This is a **product decision**, not an engineering task.

The Slice A plan infers donderdag = read path only (BUILD_BRIEF Slice A + brainstorm). Slice B export is out of the Thursday claim unless this decision explicitly expands scope.

Ideal State Criteria: \`docs/BUILD_BRIEF.md\` §2 (criteria 1–5, 7–10 for Slice A; criterion 6 is interface-only until Slice B).`,
      }),
    },
    {
      id: "DEC-002",
      title: "[DEC-002] Lever definitieve bronmatrix / deep dive",
      kind: "decision",
      milestone: "gate-0",
      labels: ["gate-0"],
      status: "Backlog",
      priority: 2,
      parent: "GATE-0",
      blockedBy: [],
      description: decIssue({
        id: "DEC-002",
        prio: "P0",
        owners: "Robbie",
        readyWhen:
          "Iedere bron heeft URL, land, prioriteit, methode, auth, frequentie, eigenaar en ToS/AVG-status.",
        notes: `This is a **product decision**, not an engineering task.

\`docs/SOURCE_MATRIX.md\` already records the 27 Aug verification (23 real bronnen, ladder, ToS notes). Remaining product work: leveranciersaccounts, ToS-besluiten, and Indeed (JI-007).

**Do not** create one Linear issue per bron. Slice A implements TenderNed + Inhuurdesk only. Remaining sources wait for Slice C as a single placeholder.`,
      }),
    },
    {
      id: "DEC-003",
      title: "[DEC-003] Leg schema en deduperegels vast",
      kind: "decision",
      milestone: "gate-0",
      labels: ["gate-0"],
      status: "Backlog",
      priority: 2,
      parent: "GATE-0",
      blockedBy: [],
      description: decIssue({
        id: "DEC-003",
        prio: "P0",
        owners: "Samen (Robbie + Ryan)",
        readyWhen:
          "Verplichte velden, unknown-gedrag en drie dedupe-niveaus zijn geaccepteerd.",
        notes: `This is a **product decision**, not an engineering task.

Plan default (KTD3/KTD8): 75-field model is the target schema, not a Slice A completeness gate. Unknown stays explicit. Three dedupe problems: ingest idempotency, cross-source identity (reversible), effect idempotency (Slice B).`,
      }),
    },
    {
      id: "DEC-004",
      title: "[DEC-004] Leg searchcontract en SLO vast",
      kind: "decision",
      milestone: "gate-0",
      labels: ["gate-0"],
      status: "Backlog",
      priority: 2,
      parent: "GATE-0",
      blockedBy: [],
      description: decIssue({
        id: "DEC-004",
        prio: "P0",
        owners: "Robbie",
        readyWhen:
          "Syntax, velden, filters, p95/p99 en benchmarkqueryset zijn testbaar.",
        notes: `This is a **product decision**, not an engineering task.

Plan default: Boolean over titel + volledige beschrijving; \`AND\` \`OR\` \`NOT\` parentheses phrases; p95 ≤ 100 ms at SearchAdapter over 200k (JI-NFR-02 rewrite 27 Aug). BUILD_BRIEF 750 ms proposal is superseded for Slice A. Confirm or replace in writing.`,
      }),
    },
    {
      id: "DEC-005",
      linearIdentifier: "RJC-321",
      title:
        "[DEC-005] Gebruik Postgres 16 on-box; Motian-Neon alleen als read-only importbron",
      kind: "decision",
      milestone: "gate-0",
      labels: ["gate-0"],
      status: "Done",
      priority: 2,
      parent: "GATE-0",
      blockedBy: [],
      description: decIssue({
        id: "DEC-005",
        prio: "P0",
        owners: "Ryan",
        readyWhen:
          "De on-box datastroom, read-only backfill, restore/rollback en operationele exit-gates zijn beschreven.",
        notes: `This is a **product / architecture decision**, not a Slice A coding task.

**Accepted/Done 28-08-2026 as RJC-321:** the new Catapulze system of record is **Postgres 16 on-box from P0**, provisioned with Docker Compose. Motian-Neon is exclusively a **read-only import source** for the legacy backfill; Catapulze never writes to it and does not use it as an application fallback or dual-write target. The schema remains portable PostgreSQL.

This avoids a later Neon-to-on-box migration and keeps Postgres, the outbox worker, and Manticore on the same private host/network. U8 owns the idempotent Motian-Neon backfill with retained \`v1_id\` provenance.

Production gates:
- the Postgres data directory uses a protected persistent volume; normal operations never run \`docker compose down -v\`;
- port 5432 is private and is not published to the internet;
- continuous WAL archiving and off-site backups are enabled, and a restore from empty is tested before production and on a recurring schedule;
- disk, memory, connections, WAL growth, backup freshness, and restore results are monitored; Postgres receives resource priority over the rebuildable Manticore index;
- if HA becomes required, or measured disk/RAM contention threatens the database SLO, move Postgres to a dedicated DB host or managed PostgreSQL. Managed Neon remains an explicit exit option only when database operations are no longer carried in-house.

Rollback is backup/WAL restore of the Catapulze database plus replayable, idempotent imports; it is never a write-back or failover to Motian-Neon.

This decision does not prove implementation or production readiness; that evidence remains open under RJC-347.`,
      }),
    },
    {
      id: "DEC-006",
      title: "[DEC-006] Bevestig Spot/Spott-product, URL, API en sandbox",
      kind: "decision",
      milestone: "gate-0",
      labels: ["gate-0"],
      status: "Backlog",
      priority: 3,
      parent: "GATE-0",
      blockedBy: [],
      description: decIssue({
        id: "DEC-006",
        prio: "P1",
        owners: "Robbie",
        readyWhen:
          "Officiële docs, sandbox, minimale write scope en unieke ID zijn beschikbaar.",
        notes: `This is a **product decision**, not an engineering task.

**Blocks all Slice B build work.** Do not spec or implement \`commit_export\` until the vendor, contract, and sandbox are confirmed.

Known: product is Spott.io (not “Spot”). Exact API/MCP, write scopes, and unique ID strategy are still open.`,
      }),
    },
    {
      id: "DEC-007",
      title: "[DEC-007] Stel scrape- en hostingbudget vast",
      kind: "decision",
      milestone: "gate-0",
      labels: ["gate-0"],
      status: "Backlog",
      priority: 3,
      parent: "GATE-0",
      blockedBy: [],
      description: decIssue({
        id: "DEC-007",
        prio: "P1",
        owners: "Robbie",
        readyWhen: "Maandbudget en alarmeringsdrempels zijn bekend.",
        notes: `This is a **product decision**, not an engineering task.

See \`de interne kostenkaart\` for the live cost card. Slice A can proceed with Trigger.dev Cloud + Upstash defaults; hard monthly caps wait on this decision.`,
      }),
    },
    {
      id: "DEC-008",
      title: "[DEC-008] Definieer raw-data-minimalisatie en retentie",
      kind: "decision",
      milestone: "gate-0",
      labels: ["gate-0"],
      status: "Backlog",
      priority: 2,
      parent: "GATE-0",
      blockedBy: [],
      description: decIssue({
        id: "DEC-008",
        prio: "P0",
        owners: "Robbie + Ryan",
        readyWhen:
          "PII-scan, toegestane velden, bewaartermijn, verwijderpad en uitzonderingen zijn vóór ingest vastgelegd.",
        notes: `This is a **product decision**, not an engineering task.

Plan conservative default (A3): Slice A drops contact fields on normalise; raw payloads retain source bytes under object-storage lifecycle (**90 days** unless Robbie sets otherwise); audit events are not deleted by the same job. Exact retention days remain open (Q3).`,
      }),
    },

    // --- Slice A ---
    {
      id: "SLICE-A",
      title: "[Slice A] Job Intelligence read path",
      kind: "epic",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "Backlog",
      priority: 2,
      parent: null,
      blockedBy: [],
      description: sliceAEpic(),
    },
    {
      id: "U1",
      title: "[U1] Workspace skeleton and safety rails",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "TodoIfCycle",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: [],
      description: sliceAUnit({
        id: "U1",
        goal: "A bun workspace that lints, typechecks, and runs tests with at most 2 workers, then exits. Secrets cannot be committed.",
        requirements: "R18. JI-001, JI-040.",
        blockedBy: "None.",
        acceptance: [
          "`bun test` runs a trivial domain test and exits 0 (no watch mode; max 2 workers).",
          "A web file importing `packages/infra` / drizzle fails `check-layering`.",
          "Secret scan catches a clearly fake token fixture; `.env.example` lists names only.",
          "Fresh clone instructions in README install and test without extra global tools beyond bun.",
          "Done: lint, typecheck, tests exit; layering and secret scan exist.",
        ],
      }),
    },
    {
      id: "U2",
      title: "[U2] Postgres core model and migrations",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "TodoIfCycle",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: ["U1"],
      description: sliceAUnit({
        id: "U2",
        goal: "Drizzle migrations create staging/curated/marts plus outbox and audit tables for BUILD_BRIEF operational entities needed in Slice A.",
        requirements: "R2, R3, R6, R7, R19. JI-002, JI-DAT-02/03/06/07.",
        blockedBy: "U1.",
        acceptance: [
          "Migrate up on empty compose Postgres; required tables exist with FKs.",
          "Entities: `bron`, `scrape_run`, `source_record` (pointer+hash, not payload), `aanvraag_observation`, `aanvraag`, `aanvraag_versie`, `aanvraag_bron_link`, `dedup_groep`, `saved_search`, `query_snapshot`, `audit_event`, `outbox_event`, `agent_context` stub.",
          "Unique `(bron_id, bron_referentie)` and unique content hash per bron; inserting duplicates fails.",
          "`aanvraag` insert without `bron_id` fails NOT NULL.",
          "SCD2 helper writes a new version and closes `geldig_tot` on the previous in one transaction with an outbox row.",
          "No contact / candidate tables in Slice A.",
          "Done: migrations apply on empty Postgres; uniqueness and SCD2 tests pass. `drizzle-kit` history is reproducible from empty.",
        ],
      }),
    },
    {
      id: "U3",
      title: "[U3] Bronregister and connector contract",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "TodoIfCycle",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: ["U2"],
      description: sliceAUnit({
        id: "U3",
        goal: "Bronnen are data. A connector can page, checkpoint, write minimised raw, and emit run metrics inside retention policy.",
        requirements: "R4, R5, R6, R16, R18, R20. JI-003, JI-004, JI-BRN-04/06/07.",
        blockedBy: "U2.",
        acceptance: [
          "Bron row: method, interval, rate limit, crawl-delay, `voorwaarden_status`, `ready|blocked|deferred`, `secret_ref`, mapping document pointer.",
          "Contract: `discover`, `fetch`, `checkpoint`, `runMetrics`. Raw path `raw/{bron}/{yyyy}/{mm}/{dd}/{run}/{id}.{json|html|pdf}`.",
          "Creating a bron in `deferred` does not schedule polls.",
          "`voorwaarden_status=verboden` cannot transition to `ready`.",
          "`activeer_bron` blocked without passing test-import and allowed voorwaarden (JI-BRN-04).",
          "Missing `secret_ref` on a login method fails validation; json-api TenderNed does not require one.",
          "Fake connector writes an object and a source_record pointer in one run.",
          "Operator can list bronnen with status and last run without seeing secret values (AE8).",
          "Done: bron lifecycle honors voorwaarden and test-import gate.",
        ],
      }),
    },
    {
      id: "U4",
      title: "[U4] TenderNed and Inhuurdesk connectors",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "Backlog",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: ["U1", "U3"],
      description: sliceAUnit({
        id: "U4",
        goal: "Two P0 connectors complete F2 against fixtures and a bounded live read.",
        requirements: "R4, R5, R6, R7, R20. JI-006, JI-018, JI-051.",
        blockedBy: "U3, U1.",
        acceptance: [
          "AE2: saved TenderNed listing+detail fixture ingested twice → exactly one SourceRecord and one curated identity (identity asserted with U5).",
          "TenderNed mapping and poll window from `docs/sources/tenderned.md` (size ≤ 100, 15 min, CPV/IDA filters as config). Client never requests `size=101`.",
          "Inhuurdesk: listing JSON including HTML description; parse tarief from text only into structured fields when a single clear max amount exists; otherwise unknown (R3).",
          "Listing hash unchanged skips detail fetch.",
          "5xx with retry/backoff then run status `failed` and metric increment; other bron still polls (KTD6 concurrency isolation).",
          "Run metrics include found/new/changed/rejected/error for both bronnen on fixture replay.",
          "CI uses fixtures. One documented live smoke outside CI (opt-in env).",
          "Done: fixture replay is idempotent for both connectors.",
        ],
      }),
    },
    {
      id: "U5",
      title: "[U5] Normalise, identity, lifecycle",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "Backlog",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: ["U2", "U3"],
      description: sliceAUnit({
        id: "U5",
        goal: "Staging observations become curated aanvragen with provenance, reversible links, and lifecycle.",
        requirements: "R3, R6, R7, R19. JI-008, JI-009, JI-050.",
        blockedBy: "U2, U3.",
        acceptance: [
          "AE6: unstructured tarief → `tarief_*` is `unknown` and the phrase stays in beschrijving.",
          "Field provenance map: canonical field → source path + parser version.",
          "Exact identity `(bron_id, bron_referentie)`. Two bronnen same title/org/start → one reviewable group, two aanvraag rows, reversible split. No auto-merge.",
          "Schema-invalid observation quarantined; not searchable.",
          "Tarief change opens SCD2 version and outbox `aanvraag.gewijzigd`.",
          "Stale after N missed polls (N in bron config, default 3). Lifecycle `active|stale|closed|unknown` is traceable.",
          "Replay of U4 fixtures yields stable IDs and zero duplicate curated identities.",
          "Done: unknown fields, reversible groups, lifecycle tests pass.",
        ],
      }),
    },
    {
      id: "U6",
      title: "[U6] Boolean parser, SearchAdapter, Manticore",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "Backlog",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: ["U2", "U5"],
      description: sliceAUnit({
        id: "U6",
        goal: "Documented Boolean search over titel+beschrijving with filters/facets, p95 gate wiring, Postgres never the query dialect.",
        requirements: "R8, R9, R10, R11. JI-010, JI-011, JI-012, JI-016.",
        blockedBy: "U2, U5.",
        acceptance: [
          "AE1: parser version V, query `(Azure OR \"platform engineer\") NOT intern` runs twice → hit IDs match; fixture asserts precedence. Also unclosed paren, empty AND, nested NOT.",
          "Invalid syntax returns structured error, no engine call.",
          "Empty index returns count 0 and empty facets with reason.",
          "Emitter to Manticore MATCH / bool JSON; filters as attributes. UI never embeds SphinxQL.",
          "Projector consumes outbox and RT-upserts; delete/close updates status attribute. Projector must not rewrite QuerySnapshots.",
          "After outbox event, search finds the new id.",
          "Adapter tests do not import drizzle. Postgres FTS exists only as rebuild/fallback adapter.",
          "Versioned benchmark profile `benchmarks/search/profile.json` exists; p95 ≤ 100 ms at SearchAdapter or explicit fail in review pack.",
          "Done: Boolean fixtures pass; adapter has no drizzle import; projector updates RT.",
        ],
      }),
    },
    {
      id: "U7",
      title: "[U7] Capability registry, REST, and MCP",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "Backlog",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: ["U3", "U6"],
      description: sliceAUnit({
        id: "U7",
        goal: "F5 and F7 handlers exist behind REST and MCP from one registry. No recruiter chrome yet.",
        requirements: "R12, R13, R14, R15. JI-014, JI-015, JI-041, JI-042.",
        blockedBy: "U6, U3.",
        acceptance: [
          "AE4: snapshot S of 17 IDs stays those 17 IDs after a later ingest adds a matching aanvraag.",
          "AE5: same arguments on REST and MCP `search_aanvragen` yield matching IDs, count, and facets (UI compared in U9).",
          "Slice A capabilities exist: `search_aanvragen`, `get_aanvraag`, `list_versies`, `read_raw` (preview/full), `list_bronnen`, `get_bron`, `create_saved_search`, `create_snapshot`, `markeer_aanvraag`, `list_alerts`, `get_bron_health`, `ack_alert`, `start_run`/`start_test_import` (operator), `complete_task` stub.",
          "Preview default on get/raw. `full: true` without recruiter role denied.",
          "Unauthenticated MCP tool call denied; authz is per call.",
          "Saved search stores parser/schema version. Snapshot freeze per R12. No Spott write path is callable.",
          "`check-capability-coverage` and `check-capability-registry` fail a PR that adds a UI action without MCP+REST wiring.",
          "Markeren writes one audit+outbox event.",
          "Done: AE4–AE5 (HTTP/MCP) pass; coverage scripts pass.",
        ],
      }),
    },
    {
      id: "U9",
      title: "[U9] Lean search UI",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "Backlog",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: ["U7"],
      description: sliceAUnit({
        id: "U9",
        goal: "F1 for recruiter: query, filters, count, pagination, detail provenance, saved search, snapshot CTA. No Spott write control.",
        requirements: "R1, R8, R9, R10, R14. JI-013.",
        blockedBy: "U7.",
        acceptance: [
          "AE3: search hit → detail shows bron, bron_referentie, scrape_run_id, normalisatieversie, and raw preview.",
          "AE5: same arguments in UI and MCP yield equal IDs; markeren from UI is visible to MCP get.",
          "UI calls REST only. No drizzle, no Manticore client.",
          "States: loading, empty, syntax error, engine error. Empty result set shows empty state, not a table of zeros.",
          "Boolean syntax error from API renders the parser message.",
          "Shareable URL holds term, filters, sort, page. Result count visible. Pagination stable.",
          "Snapshot button creates QuerySnapshot. **No export button.**",
          "Recruiter can complete F1 without opening MCP. Coverage script still passes.",
          "Done: AE3 and AE5 (UI) pass; no export control rendered.",
        ],
      }),
    },
    {
      id: "U8",
      title:
        "[U8] Observability, Motian-Neon read-only backfill, e2e, review pack",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "Backlog",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: ["U4", "U5", "U6", "U7"],
      description: sliceAUnit({
        id: "U8",
        goal: "F4 and F6 work. Slice A can be evidenced without claiming production-all-sources.",
        requirements: "R16, R17, SC1, SC5. JI-005, JI-030, JI-031, JI-052, JI-054, JI-MIG-01/02/05.",
        blockedBy: "U4, U5, U6, U7. May proceed in parallel with U9 after U7.",
        acceptance: [
          "AE7: connector 200 with zero new/changed vs a 7-day baseline drop past threshold → one silence event; a second identical event is deduped. Event contains bron, detectietijd, laatste succes, drempel, evidence, eigenaar, runbook, dedupe key.",
          "Legacy jobs are imported read-only from Motian-Neon with `v1_id` provenance into the new on-box Postgres. Catapulze never writes to Motian-Neon; recruitment tables are not imported (JI-MIG-05).",
          "Backfill duplicate v1_id is idempotent. Unreachable source → failed run, no partial curated without raw pointer.",
          "E2E: fixture bron → raw → normalise → search → snapshot (`tests/e2e/read-path.spec.ts`).",
          "Review pack template filled once: SHA, env, bron runs, reconciliation, golden queries, latency, open Gate-0 items. No Spott sandbox required.",
          "Done: e2e read-path green; silence event shape tested; review template filled once.",
        ],
      }),
    },
    {
      id: "U10",
      title: "[U10] On-box Postgres production hardening",
      kind: "build",
      milestone: "slice-a",
      labels: ["slice-a"],
      status: "Backlog",
      priority: 2,
      parent: "SLICE-A",
      blockedBy: ["U2"],
      description: sliceAUnit({
        id: "U10",
        goal: "Close the P0 production database gate without treating Compose configuration or a successful backup upload as recovery evidence.",
        requirements: "R21, SC6. DEC-005, JI-037.",
        blockedBy: "U2. May proceed in parallel with the remaining Slice A units, but production readiness remains blocked until U10 is complete.",
        acceptance: [
          "Admin, migrator, and runtime app use distinct credentials. Migrator and app are non-superuser; the app cannot create schemas, roles, or databases and receives only the required schema usage plus DML privileges.",
          "The Postgres data directory uses a protected external volume; production automation never invokes `docker compose down -v`.",
          "Port 5432 is private and an external network probe proves it is unreachable from the public internet.",
          "WAL is archived continuously to encrypted off-site storage with explicit retention and alerts for lag or failure.",
          "AE9: the latest accepted base backup plus WAL restores into an empty isolated Postgres 16 target; migration journal and integrity checks pass; recovery point, duration, environment, and commit SHA are recorded.",
          "Availability, disk, WAL/back-up lag, connections, locks, query latency, CPU, and memory are monitored with tested alert routing.",
          "Resource limits give Postgres priority over rebuildable Manticore; HA need or measured contention threatening the DB SLO triggers a move to a separate DB host or managed PostgreSQL.",
          "Done: current private-port, protected-volume, monitoring/resource-alert, continuous-WAL, and isolated-restore evidence is attached to the release pack.",
        ],
      }),
    },

    // --- Slice B placeholders ---
    {
      id: "SLICE-B",
      title: "[Slice B] Controlled Spott.io export",
      kind: "epic",
      milestone: "slice-b",
      labels: ["slice-b", "blocked"],
      status: "Backlog",
      priority: 3,
      parent: null,
      blockedBy: ["DEC-006"],
      description: sliceBEpic(),
    },
    {
      id: "SB-API",
      title: "[Slice B] API/MCP spike for Spott.io",
      kind: "placeholder",
      milestone: "slice-b",
      labels: ["slice-b", "blocked"],
      status: "Backlog",
      priority: 3,
      parent: "SLICE-B",
      blockedBy: ["DEC-006"],
      description: placeholder({
        slice: "B",
        mapsTo: "JI-020",
        goal: "Verify the real Spott.io API/MCP with a minimal sandbox read once DEC-006 names the vendor contract.",
        notes:
          "Placeholder only. Do not spec write payloads, scopes, or ID strategy until DEC-006. Acceptance later: official contract version, scopes, rate limits, and ID strategy are proven in sandbox.",
      }),
    },
    {
      id: "SB-APPROVAL",
      title: "[Slice B] Snapshot-bound approval",
      kind: "placeholder",
      milestone: "slice-b",
      labels: ["slice-b", "blocked"],
      status: "Backlog",
      priority: 3,
      parent: "SLICE-B",
      blockedBy: ["DEC-006", "U7"],
      description: placeholder({
        slice: "B",
        mapsTo: "JI-022",
        goal: "Human approval bound to an immutable QuerySnapshot (created in Slice A U7). Changed results require a new approval.",
        notes:
          "Placeholder only. Slice A already freezes snapshots; this issue adds actor, motivation, expiry, and the approval record. Standing `approval_policy` score mode is **out of this placeholder**.",
      }),
    },
    {
      id: "SB-EXPORT",
      title: "[Slice B] Idempotent export",
      kind: "placeholder",
      milestone: "slice-b",
      labels: ["slice-b", "blocked"],
      status: "Backlog",
      priority: 3,
      parent: "SLICE-B",
      blockedBy: ["DEC-006", "SB-API", "SB-APPROVAL"],
      description: placeholder({
        slice: "B",
        mapsTo: "JI-023",
        goal: "Export only newly approved aanvragen. Stable `target + canonical_vacancy_id + action_type` causes at most one create.",
        notes:
          "Placeholder only. Do not implement `commit_export` until DEC-006. Updates use a separate approved action. A schedule may only create a new pending snapshot — never export without a fresh human approval.",
      }),
    },
    {
      id: "SB-RECEIPTS",
      title: "[Slice B] Export receipts and ID crosswalk",
      kind: "placeholder",
      milestone: "slice-b",
      labels: ["slice-b", "blocked"],
      status: "Backlog",
      priority: 3,
      parent: "SLICE-B",
      blockedBy: ["DEC-006", "SB-EXPORT"],
      description: placeholder({
        slice: "B",
        mapsTo: "JI-024",
        goal: "Every success/failure is reconcilable. HTTP 200 is not proof of effect.",
        notes:
          "Placeholder only. Retries/DLQ (JI-025) and scheduled proposals (JI-026) are not issued yet. Sandbox e2e (JI-053) waits on this plus DEC-006.",
      }),
    },

    // --- Slice C placeholders ---
    {
      id: "SLICE-C",
      title: "[Slice C] Source expansion and hardening",
      kind: "epic",
      milestone: "slice-c",
      labels: ["slice-c"],
      status: "Backlog",
      priority: 4,
      parent: null,
      blockedBy: ["SLICE-A"],
      description: sliceCEpic(),
    },
    {
      id: "SC-SOURCES",
      title: "[Slice C] Remaining accepted sources (not per-bron tickets)",
      kind: "placeholder",
      milestone: "slice-c",
      labels: ["slice-c"],
      status: "Backlog",
      priority: 4,
      parent: "SLICE-C",
      blockedBy: ["SLICE-A", "DEC-002"],
      description: placeholder({
        slice: "C",
        mapsTo: "SOURCE_MATRIX.md ladder after TenderNed + Inhuurdesk",
        goal: "Expand beyond the two Slice A connectors using existing adapter categories (`feed | json-api | json-ld | html`), then rung-3 only after accounts exist.",
        notes: `Placeholder **bucket**, not 23 tickets.

Suggested later order (from SOURCE_MATRIX, not committed scope): CTM-Atom → Need Staffing → BlueTrail/Hero/Pro-Act (JSON-LD adapter) → v1-migratie → rung 3 when Robbie has accounts.

**Out:** Randstad Enterprise (ToS forbids automated search). Indeed stays JI-007 / DEC-002. Do not file one issue per bron in this import.`,
      }),
    },
    {
      id: "SC-ALERTS",
      title: "[Slice C] Anomaly alerting beyond Slice A silence events",
      kind: "placeholder",
      milestone: "slice-c",
      labels: ["slice-c"],
      status: "Backlog",
      priority: 4,
      parent: "SLICE-C",
      blockedBy: ["U8"],
      description: placeholder({
        slice: "C",
        mapsTo: "JI-031 (expand), JI-032, JI-033, JI-034",
        goal: "Route source-silence and volume-drop events to an owner, ack/escalate, then bounded recovery ladder. Screenshots/LLM only after an anomaly.",
        notes:
          "Placeholder only. Slice A U8 already emits the silence event shape. This slice adds dashboard, routing, and exception-based diagnose — not daily vision.",
      }),
    },
    {
      id: "SC-REPLAY",
      title: "[Slice C] Replay and backfill runbooks",
      kind: "placeholder",
      milestone: "slice-c",
      labels: ["slice-c"],
      status: "Backlog",
      priority: 4,
      parent: "SLICE-C",
      blockedBy: ["U8"],
      description: placeholder({
        slice: "C",
        mapsTo: "JI-036, JI-043 (retention job beyond Slice A default)",
        goal: "A chosen run/bron can be replayed without data or effect duplication. Retention/deletion proven through derived stores.",
        notes:
          "Placeholder only. Slice A has fixture replay + Motian-Neon read-only v1 backfill. This expands operator runbooks and DEC-008-complete retention.",
      }),
    },
    {
      id: "SC-LOAD",
      title: "[Slice C] Load tests against the 200k Boolean SLO",
      kind: "placeholder",
      milestone: "slice-c",
      labels: ["slice-c"],
      status: "Backlog",
      priority: 4,
      parent: "SLICE-C",
      blockedBy: ["U6", "U8"],
      description: placeholder({
        slice: "C",
        mapsTo: "JI-016 (production-scale evidence), JI-035",
        goal: "Reproduce p50/p95/p99 on a versioned 200k profile in a shared environment; fail closed if p95 > 100 ms at SearchAdapter.",
        notes:
          "Placeholder only. Slice A wires the benchmark profile and may run it on local compose. This issue is the hardening/load evidence, not a second search product.",
      }),
    },

    // --- Later stubs ---
    {
      id: "LATER-CI",
      title: "[Later] Candidate Intelligence",
      kind: "epic",
      milestone: "later",
      labels: ["later"],
      status: "Backlog",
      priority: 4,
      parent: null,
      blockedBy: [],
      description: laterCandidate(),
    },
    {
      id: "LATER-OS",
      title: "[Later] Company OS",
      kind: "epic",
      milestone: "later",
      labels: ["later"],
      status: "Backlog",
      priority: 4,
      parent: null,
      blockedBy: [],
      description: laterCompanyOs(),
    },
  ],
};

function links() {
  return `## Links
- Plan: \`${PLAN_PATH}\`
- GitHub PR: ${PLAN_PR}
- Backlog: \`docs/IMPLEMENTATION_BACKLOG.md\`
- Fasering: \`docs/BUILD_BRIEF.md\` §10
- Bronmatrix: \`docs/SOURCE_MATRIX.md\` (do **not** explode into per-source issues)`;
}

function gate0Epic() {
  return `## Goal
Hold the eight Gate 0 product decisions (DEC-001..008) as a visible decision log. These are **not** engineering tasks.

## Acceptance
- Each DEC-001..008 child exists with owner and “klaar wanneer”.
- Engineering work that is actually blocked cites the DEC via blocked-by (Slice B → DEC-006).
- Closing a DEC means the written decision is in the repo or Linear; it does not mean code shipped.

${links()}`;
}

function decIssue({ id, prio, owners, readyWhen, notes }) {
  return `## Goal
Record and close **${id}** (${prio}) as a product decision.

## Type
Product decision — **not** an implementation ticket.

## Owner
${owners}

## Klaar wanneer
${readyWhen}

## Notes
${notes}

${links()}`;
}

function sliceAEpic() {
  return `## Goal
A recruiter can find current aanvragen from the Slice A sources in one screen, with documented Boolean meaning, each hit traceable to bron / bronrecord / ingest-run / normalisatieversie, and with no duplicate ingest or snapshot effects on replay.

## Scope (in)
TenderNed + Inhuurdesk, raw object storage, normalisation, three-level dedupe, SearchAdapter + Manticore, lean UI, MCP+REST from one capability registry, QuerySnapshot (no export), Motian-Neon read-only backfill into the new on-box Postgres, run health.

## Scope (out)
Spott.io writes, Candidate Intelligence, rung-3 Playwright logins, semantic/vector search, DuckLake, 75-field completeness as a P0 gate, Indeed until JI-007.

## Children
U1–U10 (U8 and U9 may proceed in parallel after U7; U10 may proceed after U2). Sequencing: U1 → U2 → U3. U4 needs U3. U5 needs U2+U3. U6 needs U2+U5. U7 needs U6. U9 needs U7. U8 needs U4+U5+U6+U7. U10 needs U2 and remains an open production-readiness gate until its recovery and operations evidence passes.

## Success
SC1–SC6 in the plan. No Spott write path is callable. A green read path does not close U10 without current restore and operations evidence.

${links()}`;
}

function sliceAUnit({ id, goal, requirements, blockedBy, acceptance }) {
  return `## Goal
${goal}

## Requirements
${requirements}

## Blocked by
${blockedBy}

## Acceptance criteria
${acceptance.map((line) => `- [ ] ${line}`).join("\n")}

## Kind
Implementation-ready Slice A unit. Keep this U-ID in the title.

${links()}
`;
}

function sliceBEpic() {
  return `## Goal
Roadmap container for controlled Spott.io export after human approval bound to an immutable QuerySnapshot.

## Status
**Placeholder epic.** Blocked on **DEC-006**. Do not fully spec write payloads, standing approval policy, or sandbox e2e here.

## Children (placeholders only)
- API/MCP spike
- Snapshot-bound approval
- Idempotent export
- Receipts

## Out of this epic (intentionally not issued)
Standing \`approval_policy\` score mode, bounded retries/DLQ, scheduled export (a schedule may only create a pending snapshot), JI-053 sandbox e2e.

## Blocked by
DEC-006 (vendor, URL, API, sandbox, write scope, unique ID).

${links()}`;
}

function sliceCEpic() {
  return `## Goal
Roadmap container for remaining accepted bronnen plus operational hardening after Slice A.

## Status
**Placeholder epic.** Not implementation-ready. **Do not** create one issue per of the 23 bronnen in \`docs/SOURCE_MATRIX.md\`.

## Children (placeholders only)
- Remaining accepted sources (bucket)
- Anomaly alerting
- Replay / backfill
- Load tests

## Out of this epic (intentionally not issued)
Per-source tickets, Randstad Enterprise connector, Indeed (JI-007), Magnit/Circle8 until accounts exist.

${links()}`;
}

function placeholder({ slice, mapsTo, goal, notes }) {
  return `## Goal
${goal}

## Status
**Placeholder** for Slice ${slice}. Not implementation-ready. Expand into a full unit only after the parent slice is scheduled and blockers close.

## Maps to
${mapsTo}

## Notes
${notes}

## Blocked by
See Linear blocked-by relations on this issue (DEC-006 for all Slice B work).

${links()}`;
}

function laterCandidate() {
  return `## Goal
Epic **stub** for Candidate Intelligence. No build issues until DPIA / grondslag exist.

## Status
Later. Not in Job Intelligence Slice A/B/C.

## Required before any build ticket
Provider/use-case register, DPIA/grondslag, provenance and TTL per assertion, correctie/bezwaar, meaningful human review, fairness-evals.

## Hard bans (do not issue)
Auto-reject of candidates, hidden top-N ranking as a decision, automatic candidate status writes, matching/screening as a P0 feature.

## Kind
Roadmap stub only — **zero** child build issues in this import.

${links()}`;
}

function laterCompanyOs() {
  return `## Goal
Epic **stub** for Company OS: deterministic policy / decision / evidence spine.

## Status
Later. Not in Job Intelligence Slice A/B/C.

## Direction (not a spec)
Typed action catalog, identity, doelbinding, policy, evidence, idempotency, budgets, receipts, versioned prompts/skills, controlled agent runtimes. MCP does not replace this control plane.

## Kind
Roadmap stub only — **zero** child build issues in this import.

${links()}`;
}

export function issuesInCreateOrder(issues = catalog.issues) {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const ordered = [];
  const seen = new Set();

  function visit(issue) {
    if (seen.has(issue.id)) return;
    if (issue.parent && byId.has(issue.parent)) visit(byId.get(issue.parent));
    for (const blocker of issue.blockedBy) {
      if (byId.has(blocker)) visit(byId.get(blocker));
    }
    seen.add(issue.id);
    ordered.push(issue);
  }

  for (const issue of issues) visit(issue);
  return ordered;
}
