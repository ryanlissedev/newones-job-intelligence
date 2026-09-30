# Architecture Decision Records

Deze map bevat de canonieke architectuurbesluiten die meerdere packages, uitvoeromgevingen of product-slices raken. Linear bevat een gesynchroniseerde readback voor vindbaarheid en samenwerking; bij verschil is de gepushte repositoryversie leidend. Een ADR beschrijft waarom een keuze is gemaakt, welke grens erbij hoort en welk bewijs nog ontbreekt. Een ADR is geen bewijs dat de beschreven provider-run of product-SLO al is uitgevoerd.

## Statussen

- `Proposed`: bespreekbaar; nog niet leidend.
- `Accepted`: leidend voor nieuwe wijzigingen.
- `Superseded`: vervangen door een nieuw ADR.
- `Rejected`: onderzocht maar niet gekozen.

## Index

| ADR | Status | Besluit |
|---|---|---|
| [ADR-0001](ADR-0001-performance-evidence-contract.md) | Accepted | Eén veilig, vendor-neutraal performance-evidencecontract |
| [ADR-0002](ADR-0002-execution-lanes-github-crabbox-exedev.md) | Accepted | GitHub CI als gate; Crabbox en exe.dev als gescheiden remote lanes |
| [ADR-0003](ADR-0003-performance-budgets-and-regression-policy.md) | Accepted | Eerst cohorten en baselines, daarna pas tijdregressies blokkeren |
| [ADR-0004](ADR-0004-postgres-environment-strategy.md) | Accepted (on-box productie hersteld via ADR-0011; lokale/CI-lane altijd geldig) | Docker Postgres 16 voor lokale/CI-evidence; productie-SoR opnieuw on-box per ADR-0011 |
| [ADR-0005](ADR-0005-trigger-dev-database-reachability.md) | Beslist via ADR-0011 (Postgres static-IP allowlist); Manticore via on-box projector | Trigger.dev-workers versus private Postgres en Manticore |
| [ADR-0006](ADR-0006-neon-as-system-of-record.md) | Superseded by ADR-0011 | Neon was tijdelijk production SoR; vervangen door on-box Postgres + Trigger static IPs |
| [ADR-0007](ADR-0007-search-platform-state-2026-09-01.md) | Accepted (staat-vastlegging) | Zoek-/ingest-/opslagarchitectuur op `main` per 2026-09-01: on-box projector, S3 raw store, cache-lagen, component-readiness, SearchVersion-invarianten |
| [ADR-0008](ADR-0008-cloudflare-r2-for-raw-payloads.md) | Accepted | Cloudflare R2 als productie-raw-payload-store; MinIO blijft lokale dev-target; nul applicatiecode geraakt |
| [ADR-0009](ADR-0009-manticore-29-hybrid.md) | Proposed | Manticore 29 hybrid search candidate |
| [ADR-0010](ADR-0010-bron-health-and-alert-storage.md) | Accepted | Dedicated storage voor bron_health en alert versus audit_event |
| [ADR-0011](ADR-0011-postgres-on-box-trigger-static-ips.md) | Accepted (uitvoering RJC-418 open) | Postgres on-box in Coolify; Trigger.dev static egress-IP allowlist; supersedeert ADR-0006 |
| [ADR-0012](ADR-0012-first-party-mcp-client-auth.md) | Accepted | First-party signed Better Auth sessions for MCP client access |
| [ADR-0013](ADR-0013-effectts-platform-baseline.md) | Proposed | EffectTS platformbaseline, foutsemantiek en meetcriteria (CTP-454) |
| [ADR-0014](ADR-0014-effectts-project-wide-adoption.md) | Accepted | Projectbrede EffectTS-adoptie, Effect Schema-eigenaarschap en fasering (CTP-456) |
| [ADR-0015](ADR-0015-platform-integration-contracts.md) | Proposed | Modulegrenzen, scoped identities en versioned integratiecontracten (CTP-452) |
| [ADR-0016](ADR-0016-candidate-intelligence-module-contract.md) | Proposed; startgate-items pending-owner-acceptance | Candidate Intelligence-modulecontract en toetsbare CI0-startgate (CTP-636, parent CTP-345) |
| [ADR-0017](ADR-0017-rpo-rto-herstelgrens.md) | Proposed; grens pending-owner-acceptance | Numerieke RPO/RTO-grens voor JI-productie en een restore-drill die er hard op faalt (CTP-654, parent CTP-340) |

## Runbooks

- [Performance-evidence uitvoeren](../runbooks/performance-evidence.md) — lokale timings, GitHub-artifacts en de opt-in Crabbox/exe.dev-lane veilig uitvoeren en vergelijken.
- [JSON-LD/Spott wire-contract (EffectTS baseline)](../effectts/json-ld-spott-wire-contract.md) — identiek read-contract + reviewrubric voor CTP-454/455.
- [EffectTS migratiekaart (projectbreed)](../effectts/migration-map.md) — slices, ownership, deps, rollback; productie blijft uit tot aparte enablement.
- [Postgres on-box beheren](../runbooks/postgres-on-box.md) — beschermde persistentie, private networking, WAL/backups en restoregates (productie opnieuw via ADR-0011 / RJC-418).
- [Search projector beheren](../runbooks/search-projector.md) — on-box outbox-drain naar Manticore: deploy-contract, supervisie, advisory lock, gedrag bij storingen.
- [Raw object storage](../runbooks/raw-object-storage.md) — S3-vs-filesystem raw store, content-addressing, digest-validatie, lokale MinIO-compose.
- [Component-gewijze readiness (`/readyz`)](../runbooks/readiness.md) — postgres, manticore, rawObjectStore, redis, searchProjection, elk met eigen budget en vaste `reason`-strings.
- [Search-schema-migratie](../runbooks/search-schema-migration.md) — stappenplan bij een `SEARCH_SCHEMA_HASH`-wijziging: RT-attributen toevoegen, nieuwe generatie starten, reindexeren, verifiëren.
- [Hybrid corpus-rollout](../runbooks/hybrid-corpus-rollout.md) — volledige Manticore 29 embeddings-pass; geblokkeerd op RJC-418.
- [Neon restore en rolscheiding](../runbooks/neon-restore.md) — historische Neon PITR/branch-restore en rolcontract (ADR-0006; SoR nu ADR-0011).
- [Neon migratie-inhaalslag](../runbooks/neon-migration-catchup.md) — journal-vergelijking en catch-up; hergebruik bij Neon→on-box migratie (RJC-418).
