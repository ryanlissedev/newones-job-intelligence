# ADR-0006 — Neon als production system of record

- Status: **Superseded by [ADR-0011](ADR-0011-postgres-on-box-trigger-static-ips.md)** (2026-09-04)
- Datum: 2026-08-31
- Eigenaar: Job Intelligence platform (besluit: Ryan, 2026-08-31)
- Gerelateerd: ADR-0004, ADR-0005, ADR-0011, DEC-005, RJC-371, RJC-373, RJC-418, interne kostenkaart (intern operator-document, niet in deze repo), het verificatierunbook van 2026-08-31 (intern, niet in deze repo) (intern operator-document, niet in deze repo)

> **Superseded-notitie (2026-09-04).** Ryan koos opnieuw voor Postgres on-box in
> Coolify nadat Neon Free de 512 MB-limiet raakte (RJC-404) en Trigger.dev static
> egress-IP’s op het paid plan allowlisting mogelijk maakten. Zie ADR-0011 /
> RJC-418. De tekst hieronder blijft het historische Neon-besluit; volg ADR-0011
> voor nieuwe productie-ops.

## Besluit

**Neon (managed Postgres) wordt de productiedatabase en het system of record van Catapulze.** Dit vervangt het productiedeel van [ADR-0004](ADR-0004-postgres-environment-strategy.md): er komt géén dedicated on-box PostgreSQL 16-productie-instance. De lokale en CI-lane van ADR-0004 — digest-gepinde Docker Postgres 16 voor correctness- en performance-evidence zonder provideraccount — blijft onverkort van kracht.

Dit is een expliciete omkering, geen stille consistentie-correctie. ADR-0004's eigen escape-hatch-voorwaarden (regel 72–81: gemeten HA-, RTO/RPO-, contentie- of ops-bewijs) zijn **niet** vervuld; dat stelt [ADR-0005](ADR-0005-trigger-dev-database-reachability.md) (sectie "Opties", optie A) zelf vast. De doorslag is een andere: bereikbaarheid voor de gekozen cloud-orchestrator, hieronder onderbouwd. De eigenaar heeft dit besluit met dat bewijs in de hand genomen.

## Context en onderbouwing

ADR-0005 legde vast dat twee geaccepteerde besluiten samen niet uitvoerbaar waren:

1. ADR-0004 eist een private poort 5432 zonder publieke listener (ADR-0004 regel 21 en 61);
2. [orchestration.md](../research/orchestration.md) regel 51 kiest **Trigger.dev Cloud** als orchestrator.

Een gedeployde Trigger.dev Cloud-worker draait buiten onze box, zonder vastgelegde egress-IP's, en kan een private on-box Postgres per constructie niet bereiken (ADR-0005, "Context"). De alternatieven bleken zwaar of onbewezen: een hybride/self-hosted productieworker aan Cloud (optie C1) is geen aantoonbaar shipped product — ADR-0005 regel 54 en open vraag 1 markeren dit expliciet als onbevestigd — en volledige self-host (optie B) kost volgens de v4-compose-richtwaarden ~14 GB over meerdere stateful services (webapp 3+ vCPU/6 GB, worker 4+ vCPU/8 GB, plus supervisor, registry, MinIO, s2-lite, optioneel ClickHouse; [orchestration.md](../research/orchestration.md) regel 38) zonder checkpoint-ondersteuning, in directe resourceconcurrentie met Postgres en Manticore op één box (ADR-0005, optie B).

Neon lost de kern op: een publiek TLS-endpoint dat cloud-workers per constructie kunnen bereiken. Daarmee wordt ADR-0005's **optie A** de gekozen route en is de cloud-migratie niet langer geblokkeerd op orchestratie (ADR-0005, "Gevolgen", eerste punt).

Het besluit steunt op reeds verzameld, lokaal bewijs uit het Neon + Trigger.dev-verificatierunbook van 2026-08-31 (intern operator-document, niet in deze repo):

- de volledige pipeline (poll → staging → curate → outbox → Manticore-drain) draait end-to-end tegen Neon en is idempotent op herhaalde runs (Lane A: `curated.aanvraag` stabiel op 4 na twee runs; Manticore-index bereikbaar met 223 documenten);
- een lokale Trigger.dev-worker registreert alle vier de taken tegen Neon; de cron `schedule-slice-a-polls` vuurde tweemaal succesvol met live Neon-queries (Lane B);
- de ene faalrun was een correcte business-rule-afwijzing (`actief=false`), geen infrastructuurfout (Lane B, "Explicit `poll-bron` invocation").

## Wat dit besluit opgeeft

Eerlijk benoemd, want dit zijn de kosten van de omkering:

1. **On-box-controle over de productiedatabase.** ADR-0004 regel 18–28 gaf ons eigenaarschap over volume, WAL-archivering, rollen, monitoring en het restorepad. Bij Neon liggen storage, failover en PITR bij de provider; wij houden alleen rollen, schema en query-gedrag.
2. **De "5432 blijft privé"-houding is voor het SoR een gepasseerd station.** De productie-database wordt bereikt over Neons publieke, TLS-verplichte pooled endpoint (`*.pooler.*.aws.neon.tech`, `sslmode=require`; runbook, sectie "What this does NOT prove"), niet over een private 5432 op onze box. Het aanvalsoppervlak verschuift van netwerkisolatie naar credential- en TLS-hygiëne — precies het punt dat ADR-0005 bij optie A als securitynadeel noteerde. Voor diensten die wél op de box blijven (Manticore, Redis) blijft de private-poortregel gelden (de operator-access-handoff (intern, niet in deze repo) (intern operator-document, niet in deze repo) regel 52).
3. **Kosten.** Neon Launch is in interne kostenkaart (intern operator-document, niet in deze repo) regel 16 geraamd op **€60 → 160 → 250/mnd** (P0 → jaar 1), naast de Hetzner-box die voor Manticore en de apps nodig blijft. interne kostenkaart regel 56 telde Neon juist als bespaarpost van de nieuwe SoR-raming; die post keert nu terug en de scenario-totalen (interne kostenkaart regel 44–50, al gemarkeerd "opnieuw te herleiden" na de CCX33-correctie) moeten óók hiervoor worden herrekend. Daar staat tegenover dat de on-box-posten uit interne kostenkaart regel 56 (beschermd extern volume, continue WAL/off-site-back-up, restore-tests, monitoring) voor het SoR vervallen; die verrekening is nog niet gemaakt.
4. **Lock-in.** De runtime gebruikt bewust `postgres-js` via Drizzle zonder Neon-specifieke driver ([slice-a-plan](../plans/2026-08-27-2022-feat-slice-a-read-path-plan.md) regel 372), dus de SQL-laag blijft portable. Operationele afhankelijkheden (PITR, branching, pooler-gedrag, prijsmodel per CU-uur) zijn wél Neon-specifiek. Een gekwantificeerde exit-kostenraming bestaat niet in de repo — **niet gesourced; op te stellen vóór jaar-1-schaal.**

## Nieuwe verplichtingen

1. **Connectielimieten en pooling.** Alle runtimeverbindingen (server, workers, backfill) gebruiken het pooled endpoint; het runbook-bewijs liep al via de pooler. Een vastgelegd connectiebudget per component en het gedrag bij pooler-saturatie ontbreken — vastleggen vóór productie-ingest. Neons limieten per compute-tier zijn niet in de repo gedocumenteerd (**niet gesourced; verifiëren bij neon.com/docs**).
2. **Backup en restore.** De CI-job `postgres-restore-drill` ([.github/workflows/ci.yml](../../.github/workflows/ci.yml) regel 161–190, script [tools/postgres/restore-drill.sh](../../tools/postgres/restore-drill.sh)) draait tegen een Docker/wal-g/MinIO-fixture. Die job **blijft betekenisvol** voor wat hij altijd bewees: dat het in-repo wal-g-restorepad van de lokale/CI-lane werkt ([postgres-restore-v1.md](../runbooks/postgres-restore-v1.md)). Hij bewijst **niets** over productie-restore op Neon. De productie-restoregate (RPO ≤ 1 u / RTO ≤ 4 u, [postgres-on-box.md](../runbooks/postgres-on-box.md)) moet opnieuw worden gedefinieerd in Neon-termen: PITR-venster op het gekozen plan, een periodieke restore-drill naar een Neon-branch of een aparte instance, en een off-provider export (bijv. periodieke `pg_dump` naar Hetzner Object Storage) zodat een Neon-accountverlies niet het enige exemplaar van de data raakt. **Procedure bestaat nog niet; niet gesourced.**
3. **Rollen en least privilege.** ADR-0004's rolscheiding (besluit punt 3: migratie-, runtime-, read-only- en backuprollen) verhuist mee naar Neon. Concreet: een migrator-rol voor Drizzle-migraties, een app-rol voor de runtime, en een **read-only rol voor consumers die alleen lezen** (rapportage, verificatiequeries zoals de read-only checks in het runbook). De on-box bootstrap (`tools/postgres/init/10-bootstrap-roles.sh`) is Docker-init-gebonden; het Neon-equivalent moet als gedocumenteerd script of runbookstap worden aangemaakt.
4. **Credentialbeheer.** De Neon-`DATABASE_URL` wordt via 1Password (`op read`) geïnjecteerd en staat nooit in git (runbookpraktijk, 2026-08-31; conform de bestaande regel in [AGENTS.md](../../AGENTS.md) dat secrets in `.env`-bestanden buiten git blijven). Het exacte 1Password-item/veld voor de productie-URL is niet in de repo vastgelegd — vastleggen bij de rotatie onder RJC-371.

## Open punten — eerlijk

- **RJC-371: er wordt op dit moment een gelekte Neon-credential geroteerd.** De aanleiding staat gedocumenteerd in het verificatierunbook zelf (sectie "Incident: two accidental secret exposures during this run"): de volledige Neon-`DATABASE_URL` inclusief wachtwoord is tijdens de verificatiesessie in tooloutput beland. Dit is direct relevant voor dit ADR: de credential die het SoR ontsluit is precies het aanvalsoppervlak dat punt 2 hierboven beschrijft. Dit ADR is pas operationeel gedekt als de rotatie is afgerond en de nieuwe credential alleen via de secret manager bestaat.
- **Cloud-worker → Neon is aannemelijk maar onbewezen.** Al het bewijs is lokaal; het runbook stelt expliciet dat een gedeployde Trigger.dev-worker niet is getest ("What this does NOT prove"). Het beslissende bewijs uit ADR-0005 optie A blijft staan: een gedeployde run met volledig schrijfpad tegen Neon.
- **Manticore is met dit besluit níet opgelost.** ADR-0005 optie A zegt het letterlijk: een cloud-worker moet ook Manticore bereiken, en die staat privé. Er is een aparte keuze nodig (publieke ingress met auth, tunnel, of de drain on-box laten draaien); dit ADR neemt die keuze niet.
- **RJC-373: er bestaat nergens een `TRIGGER_SECRET_KEY`**, dus taken zijn niet programmatisch te triggeren en gedeployd bewijs is geblokkeerd tot die sleutel er is (ADR-0005, "Gevolgen").
- **De interne kostenkaart-totalen moeten worden herrekend** met Neon terug in de raming (zie "Wat dit besluit opgeeft", punt 3) en getoetst aan JI-NFR-06 (infra fase 1 < €300/mnd, interne kostenkaart regel 50).

## Gevolgen

- ADR-0004 krijgt een superseded-notitie: het on-box-productiedeel vervalt, de lokale/CI-Docker-lane en de Motian-Neon-read-only-importregels blijven gelden. De Motian/Lovable-Neon-database van het prototype blijft een strikt read-only importbron en wordt **niet** het nieuwe SoR; dit ADR gaat over een eigen Catapulze-Neon-instance.
- ADR-0005's bereikbaarheidsvraag is hiermee beantwoord: optie A is gekozen; alleen het Manticore-deel van die vraag blijft open.
- De Coolify-compose voor de Hetzner-box verliest de productie-Postgres-service; runbooks die de on-box-productiegate beschrijven ([postgres-on-box.md](../runbooks/postgres-on-box.md), [coolify-local.md](../runbooks/coolify-local.md)) krijgen een scopenotitie.
- Lokale en CI-tests blijven volledig zonder provideraccount draaien (ADR-0004, "Gevolgen") — dat was de helft van ADR-0004 die dit besluit bewust intact laat.

## Consequences realised (2026-09-01)

De gevolgen hierboven zijn inmiddels (deels) geïmplementeerd:

- **S3 raw store (#92, RJC-386).** `createRawObjectStore` kiest een
  S3-compatible backend zodra `RAW_S3_BUCKET` is gezet; de server weigert in
  productie te starten op de filesystem-fallback. Zie
  [`docs/runbooks/raw-object-storage.md`](../runbooks/raw-object-storage.md).
- **On-box projector (#96, RJC-387).** Lost het in "Open punten — eerlijk"
  genoemde Manticore-vraagstuk op: de worker stopt na de outbox-commit, een
  losstaand projectorproces on-box leest de Neon-outbox over TLS en schrijft
  lokaal naar Manticore. Zie
  [`docs/runbooks/search-projector.md`](../runbooks/search-projector.md).
- **Component-gewijze readiness (#99, RJC-391).** `/readyz` controleert nu
  postgres, manticore, rawObjectStore, redis en searchProjection afzonderlijk
  in plaats van alleen Postgres. Zie
  [`docs/runbooks/readiness.md`](../runbooks/readiness.md).

Zie [ADR-0007](ADR-0007-search-platform-state-2026-09-01.md) voor de volledige
staat van de zoek-/ingest-/opslagarchitectuur op deze datum.

## Operationele gereedheid (2026-09-01, RJC-381)

De twee resterende harde gaten uit "Nieuwe verplichtingen" (backup/restore,
punt 2; rollen, punt 3) zijn nu gedeeltelijk gedicht. Volledig
procedureboek: [`docs/runbooks/neon-restore.md`](../runbooks/neon-restore.md).

**Bewezen (echte rehearsal, evidence in het runbook):**

- **Off-provider export.** `tools/postgres/neon-export.ts` (bash;
  `pg_dump -Fc` + optionele `--verify`-restore in een wegwerpbare lokale
  Postgres-cluster, geen docker) draaide echt tegen Neon: 106.630 bytes in 2s,
  lokale restore in 1s, rijaantal en checksum van `curated.aanvraag` kwamen
  overeen.
- **Rolscheiding voorbereid en lokaal getest.** `tools/postgres/neon-roles.sql`
  maakt `ji_migrator`/`ji_app`/`ji_readonly` idempotent aan met de
  least-privilege-grants uit ADR-0004, gegeneraliseerd van het lokale
  `public`-only bootstrapscript naar dit projects vier schema's
  (`public`, `curated`, `staging`, `marts`). Lokaal (niet tegen Neon) bewezen:
  `ji_app` kan lezen/schrijven maar geen DDL, `ji_readonly` kan alleen lezen,
  `ji_migrator` kan DDL, en een tweede run is een no-op.

**Nog niet bewezen — expliciete gaten:**

- **PITR/branch-restoredrill.** Deze sessie had een Neon-Postgresverbinding
  maar geen Neon API-key/`neonctl`-authenticatie/Console-toegang, dus de
  daadwerkelijke branch-restore (`neon branches create --parent
  production@<timestamp>`) is niet uitgevoerd. Het runbook documenteert de
  exacte, bronvermelde CLI/Console-stappen; een operator met Console-toegang
  moet de drill zelf draaien, de gemeten RTO vastleggen en het geconfigureerde
  retentievenster in Console → Settings → Instant restore aflezen (Neon's
  eigen documentatie noemt 6u/Free, 1 dag/betaald, instelbaar tot 7 dagen op
  Launch — niet geverifieerd voor dít project).
- **Rolscheiding nog niet uitgevoerd op Neon zelf.** Bewust: de opdracht
  verbood het uitvoeren van rolwijzigingen op Neon tenzij aantoonbaar veilig
  en omkeerbaar. Het script staat klaar; een operator (Ryan) draait het één
  keer met de owner-connectiestring en wijzigt daarna
  `MIGRATION_DATABASE_URL`/`DATABASE_URL` naar de nieuwe rollen. Tot die stap
  draait alles nog als `neondb_owner` — functioneel werkt dit, het risico is
  blast radius (een lek geeft nu DDL/owner-rechten, niet alleen DML), niet
  functionaliteit.
- **Schemaversie-gat — gekwantificeerd en gerehearst, harde deploy-blocker.**
  Neons migratiejournaal (`drizzle.__drizzle_migrations`) toont 6 toegepaste
  migraties (`0000`–`0005`); `main` heeft er 12 (`0000`–`0011`). Concreet:
  `curated.outbox_event` mist `sequence_number` en de bulk-projectorkolommen
  (`0006`, `0008`), `curated.query_snapshot` mist `search_generation`/
  `search_applied_sequence`/`search_scope` (`0007`, `0010`) — die tabel heeft
  vandaag 0 rijen op Neon, dus geen backfillrisico —, `staging.source_record`
  mist `missed_polls` en de twee FK-kolommen naar `curated.scrape_run`
  (`0009`, 145 rijen, alle nieuwe kolommen `NULL` dus geen FK-validatie
  nodig), en `curated.aanvraag` mist `locatie_tekst`/`sluitingsdatum`
  (`0011`, 4 rijen). Dit blokkeert deploy van `main`-code tegen Neon
  onmiddellijk (niet geleidelijk), en blokkeerde ook een deel van de
  gevraagde restore-verificatie (`max(sequence_number)` kon niet draaien).
  **Gerehearst, niet alleen afgeleid:** een volledige `pg_dump`/`pg_restore`
  van Neon naar een lokale wegwerp-cluster, gevolgd door een echte
  `bun run db:migrate`-run — slaagde, journaal ging van 6 naar 12, rijaantallen
  ongewijzigd, `sequence_number` correct gevuld. Volledige procedure,
  operator-commando's en Neon-branch-als-rollback in
  [`docs/runbooks/neon-migration-catchup.md`](../runbooks/neon-migration-catchup.md).
  **Niet tegen Neon zelf uitgevoerd** — dat is aan een operator (Ryan).
