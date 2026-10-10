# Postgres on-box — productiepoort

Status: **Productie opnieuw Accepted via [ADR-0011](../adr/ADR-0011-postgres-on-box-trigger-static-ips.md) / RJC-418 (2026-09-04).**
Neon Free is geen duurzaam SoR meer (RJC-404). Dit runbook dekt de lokale/CI
Docker-lane én de Coolify on-box productie-instance. Uitvoering van de
Neon→on-box cutover staat in RJC-418; hybrid corpus-rollout wacht daarop
([hybrid-corpus-rollout.md](hybrid-corpus-rollout.md)).

**Trigger.dev remainder:** Coolify runtime may already be on-box while Trigger prod still uses Neon — finish static-IP firewall + Trigger `DATABASE_URL` flip via [trigger-on-box-cutover.md](trigger-on-box-cutover.md).

Historisch: [ADR-0006](../adr/ADR-0006-neon-as-system-of-record.md) koos Neon
als SoR (2026-08-31) en markeerde dit runbook tijdelijk “local/CI only”; dat is
superseded. Motian-Neon blijft uitsluitend read-only importbron (DEC-005).
De geordende Hetzner-deploy-procedure staat in [hetzner-deploy.md](hetzner-deploy.md).

## Systeemgrens

- Catapulze schrijft alleen naar de on-box Postgres (Coolify-resource / Compose).
- Motian-Neon krijgt voor import een afzonderlijke read-only connection string en read-only databasegebruiker. Die URL wordt nooit als `DATABASE_URL` van de Catapulze-runtime gebruikt.
- Postgres is de system of record. Manticore is een afgeleide, volledig rebuildbare index uit Postgres en outbox.
- Productie en P0-tests gebruiken verschillende databases, credentials en externe volumes.
- Trigger.dev Cloud bereikt productie-Postgres alleen via static egress-IP’s in de Hetzner-firewall (ADR-0011); Coolify-apps via het interne netwerk.

## Beschermd volume en private poort

`docker-compose.yml` gebruikt een extern volume. Compose maakt of verwijdert dat volume niet; ook `docker compose down -v` laat het staan. **Productie-automatisering mag nooit `docker compose down -v` gebruiken** tegen `POSTGRES_DATA_VOLUME`. CI mag wél een **ephemere** named volume vernietigen; zie `.github/workflows/ci.yml` (job `verify`, stap “Stop isolated PostgreSQL”).

Statische checks in de repo:

```bash
bun run check:postgres-compose          # localhost 5432 bind + external volume + DB-first limits
bun run check:production-compose-guard  # fail when prod scripts/workflows use down -v
bun test tools/postgres/postgres-roles.spec.ts
```

Maak het lokale P0-volume één keer aan:

```bash
cp .env.example .env
cp apps/server/.env.example apps/server/.env
bun run docker:volume:create
docker compose up -d postgres
bun run db:migrate
```

De lokale voorbeelden zijn onderling afgestemd: Compose initialiseert `ji_admin`, `ji_migrator` en `ji_app`; Drizzle gebruikt de migrator-URL op `127.0.0.1` en de host-runtime gebruikt de app-URL op `127.0.0.1`. De initbootstrap draait alleen wanneer PostgreSQL een leeg datavolume initialiseert.

Productie gebruikt een aparte, vooraf aangemaakte naam, bijvoorbeeld:

```bash
POSTGRES_DATA_VOLUME=catapulze-postgres-production \
  bash tools/postgres/ensure-volume.sh
```

Poort 5432 bindt lokaal uitsluitend aan `127.0.0.1`. Containers verbinden via `postgres:5432` op het private Compose-netwerk. In productie (ADR-0011) luistert Coolify-Postgres op het interne netwerk; de Hetzner-firewall laat TCP 5432 alleen toe vanaf de Trigger.dev static egress-IP’s (plus eventuele operator-beheerroute). Een externe probe vanaf een niet-allowlisted IP moet 5432 gesloten tonen.

Bewijs vóór productie-ingest:

1. schrijf een markerrecord op staging;
2. voer `docker compose down -v` uit;
3. controleer dat `docker volume inspect "$POSTGRES_DATA_VOLUME"` nog slaagt;
4. start opnieuw en lees het markerrecord terug;
5. controleer dat `docker compose port postgres 5432` alleen `127.0.0.1` toont;
6. bewijs vanaf een externe host dat 5432 niet bereikbaar is.

## Credentials en rollen

- Zet alle productievariabelen in de deployment secret manager; commit nooit `.env`. De lokale wachtwoorden uit `.env.example` zijn expliciet verboden in productie.
- Genereer drie unieke, sterke wachtwoorden voor admin, migrator en app. Zet `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_MIGRATOR_PASSWORD` en `POSTGRES_APP_PASSWORD` als afzonderlijke secrets; hergebruik geen waarde.
- De server gebruikt de beperkte app-rol. Migraties gebruiken de niet-superuser migrator via `MIGRATION_DATABASE_URL`. Geen runtimeverbinding gebruikt de Postgres-admin.
- Stel `CATAPULZE_DATABASE_URL` in op de app-rol en interne host `postgres`; gebruik geen Neon-URL. URL-encode gebruikersnaam en wachtwoord wanneer ze gereserveerde URI-tekens bevatten.
- De migrator kan schemas en tabellen aanmaken, maar geen rollen of databases. Default privileges geven de app-rol DML op toekomstige tabellen, sequencegebruik en alleen schema-`USAGE`; de app-rol heeft geen schema-`CREATE`.
- Gebruik voor de Motian-import een apart secret, bijvoorbeeld `MOTIAN_NEON_READ_URL`, en dwing read-only tevens in Neon/Postgres af.

Minimale productievariabelen, allemaal uit secrets/configuratie en zonder lokale fallbackwaarden:

```text
POSTGRES_ADMIN_USER
POSTGRES_ADMIN_PASSWORD
POSTGRES_DB
POSTGRES_MIGRATOR_USER
POSTGRES_MIGRATOR_PASSWORD
POSTGRES_APP_USER
POSTGRES_APP_PASSWORD
MIGRATION_DATABASE_URL
CATAPULZE_DATABASE_URL
```

Voer schemawijzigingen uit met `MIGRATION_DATABASE_URL`; start de server daarna alleen met `CATAPULZE_DATABASE_URL`/`DATABASE_URL` van de app-rol. Bewaar de admin-URL niet in de app- of workeromgeving.

## Backup en restore — harde productie-gate

Een Docker-volume of hostsnapshot alleen telt niet als backup. Vóór de eerste productie-ingest moet één van deze paden operationeel zijn:

- voorkeursroute: wal-g met continue WAL-archivering naar een afzonderlijke, S3-compatibele off-site bucket;
- alternatief: pgBackRest met dezelfde off-site en restore-eisen.

In-repo fixture (CI/local, **geen productiebewijs**):

```bash
docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.backup.yml up -d --build postgres minio minio-init
bash tools/postgres/restore-drill.sh
```

Runbook: `docs/runbooks/postgres-restore-v1.md`  
Evidence template: `docs/review/postgres-restore-evidence-template.md`  
Monitoring stubs: `tools/postgres/monitoring/alerts.yml`

Minimale policy:

- continue WAL-archivering;
- dagelijkse fysieke base backup;
- minimaal zeven dagen point-in-time recovery;
- versleuteling in transit en at rest;
- waarschuwing bij laatste WAL-upload ouder dan 15 minuten;
- waarschuwing bij laatste base backup ouder dan 26 uur;
- backupbucket heeft afzonderlijke credentials en lifecyclebeleid.

Een restoretest herstelt altijd naar een **nieuw volume** en een alternatieve lokale poort. De test valideert:

- verwachte Drizzle-migratiejournal;
- constraints en beide `source_record`-unique indexes;
- gereconcilieerde kernrijaantallen;
- één echte API-read;
- gemeten `RPO <= 1 uur` en `RTO <= 4 uur`.

Test maandelijks tijdens P0 en minimaal ieder kwartaal daarna. Zonder recente geslaagde restoretest is de database niet productie-ready.

## Monitoring en resourceprioriteit

`pg_isready` is alleen container-liveness. Productie-readiness voert daarnaast een echte query uit en controleert de verwachte migratieversie.

Minimale signalen en alerts:

- backup- en WAL-leeftijd;
- diskgebruik: waarschuwing boven 70%, kritiek boven 80%;
- poolgebruik boven 80%;
- locks ouder dan 30 seconden;
- dead tuples en autovacuumachterstand;
- checkpoint- en write-latency;
- cgroup memory pressure en OOM-events;
- database-readiness en API-readiness.

Startbudget op een host met 32 GB RAM / 8 vCPU:

| Component | Reservation | Limiet |
|---|---:|---:|
| Postgres | 8 GB | 12–14 GB / 4 vCPU |
| Manticore | — | 8 GB / 2–2,5 vCPU |
| App, workers en monitoring | — | 4 GB totaal |
| Host/page cache | minimaal 6 GB | niet alloceren |

Postgres krijgt voorrang. Een Manticore-index mag worden verwijderd en opnieuw opgebouwd; Postgres-data niet.

## Exit naar aparte of managed database

Verplaats Postgres naar een aparte DB-host of managed dienst zodra één van deze signalen herhaald optreedt:

- Manticore rebuild/optimize breekt de database-SLO;
- memory pressure of OOM raakt Postgres;
- disk-I/O blijft langer dan 15 minuten verzadigd;
- HA wordt een expliciete beschikbaarheidseis;
- restore-, patch- of standbybeheer past niet meer binnen het operationele eigenaarschap.

Een verhuizing gebruikt dezelfde portable PostgreSQL-migraties en `postgres-js`-driver; de applicatie verandert alleen van connection string.
