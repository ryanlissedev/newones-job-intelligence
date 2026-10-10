# ADR-0017 — Numerieke RPO/RTO-grens voor JI-productie en een drill die ertegen faalt

- Status: Proposed; de getallen in §1 staan op `pending-owner-acceptance` (Ryan + Robbie). Het mechanisme in §2 en §3 is gebouwd en draait met deze voorgestelde getallen als default.
- Datum: 2026-09-25
- Eigenaar: JI data owner (`@ji/db`)
- Approver: Ryan (platform) en Robbie (product) voor §1; de auteur is geen approver
- Issues: CTP-654 (parent CTP-340); bouwt op CTP-632 (restore-drill) en ADR-0011 (Postgres on-box)
- Zie ook: [postgres-restore-v1](../runbooks/postgres-restore-v1.md), [neon-restore](../runbooks/neon-restore.md), [EffectTS-migratiekaart](../effectts/migration-map.md) rij Herstel

## Context

De restore-drill (`tools/postgres/restore-drill.sh`, CI-job `postgres-restore-drill`) bewijst sinds CTP-632 dat een base backup plus gearchiveerde WAL uit een off-site bucket naar een leeg doel terug te zetten is en dat een marker die na de base backup is geschreven, terugkomt. De drill schreef duur en recovery point naar een evidence-artifact, maar er bestond geen grens waartegen hij kon falen. Zonder getal is iedere drill per definitie groen, en de migratiekaart houdt de rij Herstel daarom op "RPO/RTO nog niet numeriek geaccepteerd".

Dit ADR legt twee dingen vast: een voorgestelde grens (die een besluit van de eigenaren nodig heeft) en het mechanisme waarmee de drill die grens meet en er hard op faalt (dat geen besluit nodig heeft en al geldt).

## Besluit

### 1. Voorgestelde grens (pending-owner-acceptance)

| Grootheid | Voorstel | Wat het betekent |
| --- | --- | --- |
| RPO | ≤ 15 minuten | Maximaal 15 minuten aan bevestigde writes mag verloren gaan bij herstel uit backup en WAL-archief. Haalbaar met continue WAL-archivering (`archive_timeout` ≤ 900 s) plus dagelijkse base backup. |
| RTO | ≤ 2 uur | Vanaf het besluit tot herstel tot een leeg doel dat `pg_isready` meldt en de integriteitschecks doorstaat. Meting begint bij `backup-fetch` en eindigt bij geslaagde integriteitschecks. |

Buiten deze grens vallen bewust:

- Manticore: de zoekindex is herbouwbaar uit Postgres via de projector en heeft geen eigen RPO.
- R2 raw-objecten: aparte bewijsgrens met eigen retentie (DEC-008, CTP-324); geen onderdeel van deze drill.
- Trigger.dev-runstatus en de search-outbox: replaybaar vanuit Postgres, geen eigen herstelgrens.

Accepteren of verwerpen gebeurt door de status van dit ADR te wijzigen en, bij andere getallen, de defaults in §2 mee te wijzigen in dezelfde commit.

### 2. Mechanisme (geldt nu)

De drill meet en schrijft naar `.artifacts/postgres-restore-evidence.json`:

- `rtoMs`: van de start van `wal-g backup-fetch` op het doel tot het slagen van `tools/postgres/integrity-checks.sh`. Dit is de hersteltijd; opbouwtijd van de bron, migraties en backup-push tellen niet mee.
- `rpoObservedSeconds`: verschil tussen het laatste bevestigde commit-tijdstip op de bron (marker `...-after-backup`, `created_at` op de bron) en het laatste tijdstip dat op het doel is teruggelezen (`max(created_at)` uit dezelfde markertabel). In de fixture is dit nul omdat alle WAL gearchiveerd wordt; groter dan nul betekent dat het archief achterloopt.
- `recoveryPointLsn`, `durationMs` (totale drillduur), `gitSha`, `environment`, `backupName` zoals voorheen.
- `thresholds`: de gebruikte grenzen, en `result`: `pass` of `fail`.

Grenzen komen uit `RESTORE_DRILL_MAX_RTO_SECONDS` (default 7200) en `RESTORE_DRILL_MAX_RPO_SECONDS` (default 900). Boven een grens schrijft de drill het evidence-bestand met `result: "fail"` en de overschreden grootheid, en eindigt met exit 1. De CI-stap uploadt het artifact ook bij falen (`if: always()`), zodat een rode drill altijd zijn cijfers meelevert.

### 3. Wat de drill wel en niet bewijst

De CI-drill draait tegen een kleine fixturedatabase. Hij bewijst dat het mechanisme (archief, fetch, replay, promote, integriteit) binnen de grens werkt en dat de grens afdwingbaar is. Hij bewijst niet dat een productieformaat binnen 2 uur terugkomt. Daarvoor draait de operator hetzelfde script tegen een kopie van het productiearchief volgens `postgres-restore-v1.md` en legt de run vast onder `docs/evidence/ctp-654/`. De eerste fixture-baseline staat in datzelfde pad.

## Gevolgen

- De migratiekaart rij Herstel kan van "nog niet numeriek geaccepteerd" naar "voorgesteld, mechanisme actief; acceptatie open" en, na besluit, naar "geaccepteerd".
- Een drill die door een tragere runner boven de RTO-grens komt, is rood en blijft rood. Dat is de grens die werkt; verhoog de default alleen via een wijziging van dit ADR.
- Wijziging van de backupcadans (`archive_timeout`, base-backupfrequentie) raakt de RPO-belofte en hoort dit ADR te citeren.
