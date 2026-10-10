# DuckLake — verdict (b): export/archief/analytics-laan, nu starten

Datum 2026-08-27. Bronnen: ducklake.select (+ /2026/04/13/ducklake-10/, /release_calendar, /docs/stable/{specification/introduction, duckdb/introduction, duckdb/usage/choosing_a_catalog_database, duckdb/usage/connecting, duckdb/maintenance/*}), motherduck.com/blog/ducklake-architecture-deep-dive, duckdb.org/docs/current/core_extensions/postgres/overview.html, duckdb.org/docs/current/clients/node_neo/overview, github.com/oven-sh/bun/issues/17216, github.com/duckdb/ducklake/issues/336, definite.app/blog/duck-lake-vs-iceberg.

## Wat het is

Spec **v1.0 (april 2026)**, "production-ready, guaranteed backward-compatibility", MIT; DuckDB ≥ 1.5.2; v1.1 sept 2026, v2.0 niet in zicht. ~30 catalogus-tabellen in een ACID-SQL-database (DuckDB single-client, SQLite lokaal multi-process, **PostgreSQL 12+ voor multi-user**; MySQL afgeraden) + Parquet op object/block storage. Commit: Parquet eerst, dan korte catalogus-transactie (~100 tx/s); optimistic concurrency; half-geschreven bestanden onzichtbaar. Time travel = `SNAPSHOT_VERSION` bij ATTACH. Geen indexes/PK/FK/CHECK. Ecosysteem: DuckDB native, Spark, Trino, DataFusion, pandas, MotherDuck; Iceberg-compatibele bucket-partitioning.

## Fit

- Zelfde Postgres-instantie als SoR + catalogus: ja, **aparte database** (`ducklake_catalog`) voor backups/rollen; analytics raakt `curated` nooit (JI-NFR-03).
- Writes: DuckDB CLI als subprocess vanuit Bun; `ATTACH 'dbname=catapulze' AS pg (TYPE postgres, READ_ONLY)`; `INSERT … SELECT … WHERE valid_from > watermark` (binary COPY, filter pushdown, ctid-parallel). Geen CDC; latency = één batch na elke ingest-run.
- **Complement, geen vervanging** van Postgres-MVs (JI-DAT-10 < 2 min refresh). DuckLake: JI-DAT-11 (KPI-snapshots = snapshots), JI-DSH-05 (kwartaaltrends op columnar), JI-INT-07/JI-NFR-07 (export ís de tabel).
- Refresh: 20k rijen/dag → één 10–30 MB Parquet per tabel per dag; maandelijks `CHECKPOINT` (flush → expire_snapshots → merge_adjacent_files ~500 MB → rewrite → cleanup); catalogus af en toe `VACUUM`.
- **Bun-bindings ontbreken** (`@duckdb/node-api` alleen Node; Bun-segfault gesloten als duplicate) → CLI-subprocess `duckdb -json`.
- Chat-over-data (JI-DSH-07): `duckdb -readonly`, alleen SELECT, `SNAPSHOT_VERSION` per sessie gepind.

## Vergelijking

| | DuckLake | PG-marts only | Iceberg + catalogus | Plain Parquet |
|---|---|---|---|---|
| Extra infra | 1 PG-db + bucket | geen | REST-catalogus (Polaris/Lakekeeper/Glue) | geen |
| Ops (3 pers.) | laag | laagst | hoog | laag |
| Time travel | native | geen | native | geen |
| JI-NFR-03 | ja | breekt bij schaal | ja | ja |
| Fit | export/analytics | dashboard-marts | over-built single-engine | fallback |

Migratie naar Iceberg "weken, geen maanden" — het is Parquet.

## Risico's

Spec-churn laag post-1.0 (pin versies) · Bun-bindings (subprocess) · small-files (daily batch + CHECKPOINT; bug #336 gefixt) · backup-consistentie: Parquet immutable en vóór catalogus-commit → `pg_dump` van de catalogus is consistent zolang `cleanup_old_files`-retentie > backup-venster; geen backup-guidance in docs (eigen runbook) · catalogus deelt failure-domain met SoR (acceptabel op één box).

## Snippet

```
Writer: Bun-worker → na ingest-run → `duckdb < export.sql`
  INSTALL/LOAD ducklake, postgres, httpfs;
  CREATE SECRET hetzner (TYPE s3, ENDPOINT 'fsn1.your-objectstorage.com', ...);
  ATTACH 'ducklake:postgres:dbname=ducklake_catalog' AS lake (DATA_PATH 's3://catapulze-lake/');
  ATTACH 'dbname=catapulze' AS pg (TYPE postgres, READ_ONLY);
  INSERT INTO lake.curated_vacancies SELECT * FROM pg.curated.vacancies
    WHERE valid_from > (SELECT max(valid_from) FROM lake.curated_vacancies);
  INSERT INTO lake.kpi_daily SELECT current_date, ... ;   -- JI-DAT-11
Schedule: per run (append) · maandelijks CHECKPOINT · wekelijks pg_dump ducklake_catalog
Layout: s3://catapulze-lake/{schema}/{table}/ (partition BY year(valid_from), month)
Readers: dashboards → PG-MVs; kwartaal/BI/MCP → duckdb -readonly ATTACH lake (READ_ONLY)
```
