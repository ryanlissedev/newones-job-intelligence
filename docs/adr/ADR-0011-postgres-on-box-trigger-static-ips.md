# ADR-0011 — Postgres on-box in Coolify + Trigger.dev static egress allowlist

- Status: Accepted (besluit Ryan 2026-09-04; uitvoering open onder RJC-418)
- Datum: 2026-09-04
- Eigenaar: Job Intelligence platform (besluit: Ryan, 2026-09-04)
- Gerelateerd: DEC-005, ADR-0004, ADR-0005, ADR-0006, RJC-404, RJC-405, RJC-418,
  [postgres-on-box.md](../runbooks/postgres-on-box.md),
  [neon-migration-catchup.md](../runbooks/neon-migration-catchup.md),
  [Trigger.dev Static IPs](https://trigger.dev/changelog/static-ips)

## Besluit

**Catapulze’s production system of record verhuist van Neon Free terug naar een
dedicated Postgres-resource on-box in Coolify op de Hetzner-box.** Trigger.dev
Cloud (betaald account) bereikt die database via **vaste egress-IP’s** die in de
Hetzner-firewall `catapulze-prod` alleen op TCP 5432 worden toegelaten. Coolify-
apps op de box blijven via het interne `coolify`-netwerk praten; 5432 is niet
publiek voor andere bronnen.

Dit **supersedeert ADR-0006** voor het productie-SoR. DEC-005 / ADR-0004’s
on-box-richting is daarmee weer leidend voor productie, met één nieuw
bereikbaarheidsmechanisme dat ADR-0005 in 2026-08-31 nog als onbewezen
markeerde: Trigger.dev static IPs (paid plans).

## Context

1. **Neon Free is vol.** RJC-404: Motian-import stopte op
   `PostgresError 53100` (project size limit 512 MB). Stand ~62k rijen / ~440 MB
   na snoei — genoeg voor PoC-polls, niet voor de resterende ~190k Motian-rijen
   noch voor hybrid-reindex van het volle corpus.
2. **CX43 heeft ruimte.** Gemeten 2026-09-04: ~111 GB vrij, ~12 GB RAM
   beschikbaar. Geen tweede server nodig voor Postgres naast Manticore 29 en de
   on-box projector.
3. **Trigger.dev static IPs bestaan nu op paid plans.** ADR-0005/0006 kozen Neon
   omdat cloud-workers toen geen vaste egress hadden. Dat argument is voor dit
   account achterhaald: Regions-pagina toont static IPs per AWS-regio; die
   worden als bron in de Hetzner-firewall gezet. Free-tier dynamic IPs blijven
   onbruikbaar voor allowlisting — daarom blijft dit een paid-only pad.
4. **Wat we inleveren t.o.v. Neon.** Branching-as-rollback (vervangen door
   `pg_dump` vóór elke migratie), PITR, scale-to-zero. Round-trip vanaf de box
   daalt van ~17 ms naar < 1 ms.

## Scope (RJC-418)

1. Coolify Postgres-resource (PG major gelijk aan huidige Neon) in project
   `catapulze-ji`, volume op NVMe, Coolify-geplande backups naar Cloudflare R2.
2. Trigger.dev static IPs inschakelen; IPs als bron in firewall
   `catapulze-prod` (<hetzner-firewall-id>) op TCP 5432.
3. Rollen conform ADR-0006’s least-privilege-contract
   (`tools/postgres/neon-roles.sql` / equivalent): `ji_migrator`, `ji_app`,
   `ji_readonly`; alleen migrator krijgt `MIGRATION_DATABASE_URL`.
4. Migratiepad: `pg_dump` Neon → restore on-box → journal-vergelijking per
   [neon-migration-catchup.md](../runbooks/neon-migration-catchup.md) →
   `/readyz` groen → DNS/env-switch van `DATABASE_URL`,
   `PROJECTOR_DATABASE_URL`, `MIGRATION_DATABASE_URL` in Coolify (preview vs
   non-preview) en Trigger.dev prod.
5. Restore-drill op de R2-backup vóór de switch (RJC-405 punt 3).
6. Daarna pas: volledige Motian-kopie (RJC-405 punt 1) en hybrid-rollout op het
   hele corpus (~95 min embeddings-operatorraming; zie
   [hybrid-corpus-rollout.md](../runbooks/hybrid-corpus-rollout.md)).

## Gevolgen

- ADR-0006 status → **Superseded by ADR-0011**. De Neon-runbooks blijven
  historisch en als rollback/export-referentie; nieuwe productie-ops volgt
  [postgres-on-box.md](../runbooks/postgres-on-box.md) + dit ADR.
- ADR-0004’s on-box-productiedeel is opnieuw Accepted via dit ADR; de
  lokale/CI Docker-lane was nooit superseded en blijft ongewijzigd.
- ADR-0005’s Postgres-bereikbaarheidsvraag is opnieuw beantwoord: static-IP
  allowlist i.p.v. managed public endpoint. Manticore blijft on-box via de
  projector (ADR-0007); cloud-workers hoeven Manticore niet te bereiken.
- Coolify-compose mag opnieuw een productie-Postgres-service voeren; de
  private-poortregel wordt “5432 alleen vanaf Trigger static IPs + coolify-
  netwerk”, niet “geen listener op 5432”.
- Neon-project pas verwijderen na ≥1 week stabiel on-box draaien.

## Open uitvoering (geen “done” tot bewezen)

- Coolify-resource + env-switch voor server/projector/migrator mag al groen
  zijn (`/readyz` 200). Resterende poort: Trigger.dev static IPs + Hetzner
  firewall `catapulze-prod` TCP 5432 + Trigger prod `DATABASE_URL` flip —
  one-shot: [trigger-on-box-cutover.md](../runbooks/trigger-on-box-cutover.md).
- Daarna: Trigger.dev `poll-bron` succeeded, projector-lag 0, R2 restore-
  drill (RJC-405) — rest van RJC-418 DoD.
- Hybrid corpus-rollout en Motian-full-copy blijven geblokkeerd tot die DoD.
