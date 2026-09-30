# RSP Job Intelligence

Bouwdossier voor de eerste Catapulze Job Intelligence-slice: vacatures/aanvragen uit ~23 bronnen verzamelen, normaliseren, ontdubbelen, instant doorzoekbaar maken (Boolean + facets) en na menselijke goedkeuring idempotent exporteren naar Spott.io — agent-native vanaf dag één.

## Documenten

| Doc | Wat |
| --- | --- |
| [`docs/BUILD_BRIEF.md`](docs/BUILD_BRIEF.md) | Productdoel, Ideal State Criteria, systeemgrens, kernmodel, fasering, open besluiten |
| [`docs/plans/2026-08-27-2022-feat-slice-a-read-path-plan.md`](docs/plans/2026-08-27-2022-feat-slice-a-read-path-plan.md) | Slice A read-path implementatieplan (`ce-plan`, implementation-ready) |
| [`docs/IMPLEMENTATION_BACKLOG.md`](docs/IMPLEMENTATION_BACKLOG.md) | Geordende taken met afhankelijkheden en acceptatiecriteria |
| [`docs/brainstorms/2026-08-27-techstack-brainstorm.md`](docs/brainstorms/2026-08-27-techstack-brainstorm.md) | 12 stack-besluiten met bewijs en omgooi-triggers |
| [`docs/AGENT_NATIVE_ARCHITECTURE.md`](docs/AGENT_NATIVE_ARCHITECTURE.md) | Tool-oppervlak, capability map, registry-contract, approval-matrix, agents-als-prompts |
| [`docs/SOURCE_MATRIX.md`](docs/SOURCE_MATRIX.md) | Geverifieerde bronmatrix (DEC-002): ladder-indeling, wat nog geregeld moet worden |
| [`docs/linear/`](docs/linear/README.md) | Linear roadmap import (Gate 0 + Slice A/B/C/Later). Slice A fully issued; later slices are containers |
| [`docs/sources/tenderned.md`](docs/sources/tenderned.md) | Ingest-recept TenderNed (eerste nieuwe bron) |
| [`docs/REQUIREMENTS_V2.json`](docs/REQUIREMENTS_V2.json) | Requirements v2 (concept 26-08) + v1→v2-veldmapping |
| [`docs/doelplaat/`](docs/doelplaat/) | Volledige export van de doelarchitectuur-artifact (model-JSON, spec v0.2, documenten, beslissingen) |
| [`docs/research/`](docs/research/README.md) | Ruwe onderzoeksrapporten met bronnen en benchmarks |
| [`docs/artifacts/`](docs/artifacts/) | Zelfstandige HTML-overzichten (techstack, redteam) |
| [`docs/SOURCE_REGISTER.md`](docs/SOURCE_REGISTER.md) | Herkomstregister van de discovery-fase |

## Stack in één regel

Bun + TypeScript + Effect-TS + Drizzle · Postgres 16 on-box in Docker (zones staging/curated/marts, SCD2, outbox) · Manticore RT achter een SearchAdapter · Trigger.dev Cloud · Hetzner + Coolify · Redis (Upstash) voor rate-limits en geversioneerde result-cache · DuckLake voor analytics/export · MCP + REST als enig datapad · capability registry met approval-als-data.

## Status

Stand per 25 september 2026. Het bronnenregister telt 49 bronnen. Productie draait on-box Postgres en Manticore op Hetzner via Coolify. De on-box poller (`apps/worker/src/poller/main.ts`) bezit polling en curatie; de on-box projector drained de search-outbox. Trigger.dev blijft alleen voor de retained jobs uit `docs/runbooks/onbox-poller.md`. De Effect-migratie loopt onder ADR-0014 met de flow-status in `docs/effectts/migration-map.md`. Durable-ingest-bewijs is gemerged voor cohorten L3a t/m L3c (PR #429 t/m #431); L3d, L3e en L3f liggen open als PR #440, #439 en #441. Lopende programma's zijn CTP-613 (Effect-waves) en CTP-505 (ontbrekende bronnen). Gate-0-besluiten DEC-001, DEC-002, DEC-003, DEC-007 en DEC-008 zijn nog open (Linear CTP-317, CTP-318, CTP-319, CTP-323, CTP-324). Deze repo is publiek op github.com/ryanlissedev/rsp-job-intelligence.

De inhoud is gebaseerd op de Ryan/Robbie-call van 27 augustus 2026, het bestaande Lovable/Neon-prototype, de gedeelde analyses en publieke bronverificatie. Transcriptuitspraken zijn requirements-input, geen automatisch genomen architectuurbesluiten.

## Lokaal draaien

De app is een Bun-monorepo (Better-T-Stack): Next.js op poort 3001, Hono/tRPC op poort 3000, Drizzle + `postgres-js`, Better Auth. Workspace-packages staan onder de scope `@ji`.

```bash
bun --version # vereist 1.3.14
bun install --frozen-lockfile
cp .env.example .env
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

De gekopieerde `_local`-credentials zijn uitsluitend voor ontwikkeling en houden de admin-, migratie- en applicatierol gescheiden. Vul in `apps/server/.env` daarnaast `BETTER_AUTH_SECRET` in (`openssl rand -base64 32`). Een vers extern volume voert de rollenbootstrap één keer uit. Drizzle gebruikt de migrator via `MIGRATION_DATABASE_URL`; de server gebruikt de beperkte app-rol via `DATABASE_URL`.

```bash
bun run docker:volume:create
docker compose up -d postgres
bun run db:migrate
bun run dev
```

| App | URL                   |
| --- | --------------------- |
| Web | http://localhost:3001 |
| API | http://localhost:3000 |

## DEC-005: production baseline voor Postgres

De lokale Compose-service is de ontwikkel- en testbasis; een productie-uitrol is pas geaccepteerd wanneer al deze gates met bewijs zijn gesloten:

- Postgres gebruikt een vooraf aangemaakt, extern beschermd volume. `docker compose down` mag containers verwijderen, maar `docker compose down -v` is voor deze omgeving verboden.
- Admin, migrator en runtime zijn afzonderlijke rollen. De runtime is geen superuser, kan geen rollen/databases/schema's aanmaken en krijgt alleen schema-gebruik plus DML op migrator-objecten.
- Poort `5432` is niet publiek: lokaal alleen private Docker-/hostnetwerkroute; in productie alleen Coolify-intern netwerk plus Trigger.dev static egress-IP’s in de Hetzner-firewall (ADR-0011).
- Continue WAL-archivering gaat naar off-site object storage en een restore naar een lege, geïsoleerde database is periodiek end-to-end getest.
- Databasegezondheid, disk, WAL/back-uplag, verbindingen, locks, querylatency, CPU en geheugen zijn gemonitord en gealarmeerd.
- CPU-, geheugen- en diskbudgetten zijn vastgelegd. Postgres krijgt voorrang; de Manticore-index is afgeleid en rebuildbaar uit Postgres plus raw storage.
- Een aparte databasehost of managed Postgres wordt de exit wanneer HA vereist is, of wanneer metingen aantonen dat disk-, RAM- of CPU-concurrentie de database-SLO bedreigt.
- Productie gebruikt sterke, unieke credentials uit de deployment secret manager; de lokale waarden uit `.env.example` zijn daar verboden.

Het externe volume en de private poortbinding zijn configuratievoorwaarden, geen bewijs dat back-up en restore al operationeel werken. Bewaar restore-evidence voordat deze omgeving als productiegeschikt wordt gemarkeerd.

Handige scripts: `bun run dev:web`, `bun run dev:server`, `bun run db:studio`, `bun run fix`, `bun run check`, `bun run gate`, `bun run wiki`, `bun test`, `bun run check-layering`, `bun run check-secrets`.

## Quality (vier werkwoorden)

| Script | Wanneer |
| --- | --- |
| `bun run fix` | Auto-fix op branch-, staged, unstaged en untracked wijzigingen (Ultracite/Oxlint/Oxfmt) |
| `bun run check` | Lint op gewijzigde bestanden + Qlty (`--no-formatters`) |
| `bun run gate` | Volledige pre-push gate: Ultracite, Qlty, types, layering, secrets, tests |
| `bun run wiki` | OpenWiki lokaal bijwerken |

`fix:all` / `check:all` formatteren of linten de hele tree — bewust escape hatch, niet voor dagelijks gebruik. Pre-commit gebruikt Lefthook met `{staged_files}`; Husky is verwijderd. Qlty-config staat in `.qlty/qlty.toml` (geen `qlty fmt`, nooit `qlty githooks install`).

`bun run check` en `bun run gate` vereisen de [Qlty CLI](https://docs.qlty.sh/cli/installation). Ze falen bewust wanneer Qlty ontbreekt, zodat een ontbrekende quality-owner nooit als groen wordt gerapporteerd.

`bun run gate` vereist daarnaast een bereikbare test-Postgres en voert de migratie- en constrainttests echt uit. Maak het externe volume eenmalig met `bun run docker:volume:create`, start lokaal alleen de testservice met `docker compose up -d postgres` en stop die na de gate met `docker compose down`. Het externe volume blijft daarbij behouden; gebruik hier geen `docker compose down -v`. Een gewone `bun test` mag zonder Postgres draaien en slaat uitsluitend die integratiesuite over. Met een bereikbare Postgres maakt de gate ook, via `tools/postgres/ensure-migration-upgrade-db.ts`, automatisch een `ji_migration_upgrade_test_*`-database aan en voert daarmee `packages/db/src/migration-upgrade.spec.ts` (de 0000→0010 upgrade-paden) echt uit in plaats van die suite stilzwijgend over te slaan; zonder bereikbare Postgres meldt de gate dat expliciet en slaat alleen die suite over.

De Claude Code **Stop**-hook en lefthook pre-push roepen dezelfde `bun run gate` aan. `tools/quality/gate.sh` laadt ontbrekende `POSTGRES_*` uit `.env` (anders `.env.example`) zodat die hooks dezelfde Compose-credentials zien als de draaiende Postgres — zonder al gezette env-vars (CI) te overschrijven.

Een verse clone heeft voor de basisvalidatie alleen **bun** nodig (geen extra globale linters of test runners):

```bash
bun install --frozen-lockfile
bun test
bun run check-types
bun run check-layering
bun run check-secrets
```

`bun test` draait met `--max-concurrency 2` en zonder `--watch`, zodat de suite stopt. `check-layering` weigert imports van `@ji/db` / drizzle vanuit `apps/web`. `check-secrets` scant getrackte bestanden op duidelijke secret-patronen; `.env.example` bevat alleen namen en placeholders.

Scripts zetten `PATH="./node_modules/.bin:$PATH"` (relatief), omdat de parent-map `clients:catapulze` een dubbele punt bevat en een absoluut `node_modules/.bin`-pad Unix-`PATH` daardoor splitst.
