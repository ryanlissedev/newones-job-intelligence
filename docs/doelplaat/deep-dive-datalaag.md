# Deep dive: Job Intelligence — Datalaag

_Zichtbare tekst van het tabblad, uitgelezen via Interceptor op 2026-08-27._

Terug naar de plaat
Laag 2 · Vacaturebronnen · deep dive · spec 0.2 + requirements

## Catapulze Job Intelligence

v1 live · v2 in specificatieCatapulze Job Intelligence — specificatie v2 (concept)versie 0.2 · 2026-08-26

Download HTMLJSON van de specJSON van de requirementsKaart op de plaat

OverzichtPipelineDatamodelBronnenDatalaagConfig & stackFasen & complianceJSON Schemav1-analyseRequirementsMapping v1 → v2

Zone 1

### Raw

Object storage (S3-compatibel)

Onbewerkte HTML/JSON/PDF per fetch, immutable, pad per bron/datum/run/hash; bijlagen.

Retentie 12 maanden (daarna alleen hash + metadata)

→

Zone 2

### Staging

Postgres, schema staging.*

Eén tabel per bron in bronvorm (JSONB) + extractie-metadata; quarantaine-tabel.

Retentie 90 dagen

→

Zone 3

### Curated (gecureerde zone)

Postgres, schema curated.*

aanvraag (huidige versie), aanvraag_versie (SCD2), bron, organisatie, aanvraag_eis, aanvraag_skill, aanvraag_bijlage, dedup_groep, scrape_run.

Retentie Onbeperkt voor niet-PII; contactvelden 90 dagen na sluiting

→

Zone 4

### Marts

Postgres views / materialized views

open_aanvragen, aanvragen_per_bron_per_dag, tarieven_per_functiegroep, bron_gezondheid, tijd_tot_sluiting.

Retentie Afgeleid

### Tabellen (curated)

| Tabel | Sleutel | Kolommen |
| --- | --- | --- |
| curated.bron | bron_id | naam, categorie, website, ingestie_type, schedule, login_vereist, voorwaarden_status, actief, config_ref |
| curated.aanvraag | aanvraag_id; unique (bron_id, bron_referentie) | alle canonieke velden (huidige versie) + bron_specifiek jsonb + zoekvector (tsvector) + embedding (vector) |
| curated.aanvraag_versie | aanvraag_id, versie | snapshot canonieke velden, content_hash, raw_payload_ref, geldig_van, geldig_tot |
| curated.organisatie | organisatie_id | naam, kvk, type, domein, sector, verrijking_ref (Clay), aliases[] |
| curated.aanvraag_eis | aanvraag_id, volgnr | soort (eis\|wens\|gunningscriterium), tekst, knockout, weging |
| curated.aanvraag_skill | aanvraag_id, skill | skill (taxonomie), bron (tekst\|afgeleid), confidence |
| curated.aanvraag_bijlage | bijlage_id | aanvraag_id, naam, mime, bron_url, raw_ref |
| curated.dedup_groep | dedup_groep_id | primaire_aanvraag_id, methode, similariteit, handmatig_bevestigd |
| curated.scrape_run | scrape_run_id | bron_id, gestart, geëindigd, status, aantal_gevonden, nieuw, gewijzigd, gesloten, fouten, circuit_status, versie_adapter |

### Laadpatroon

1. Upsert op `(bron_id, bron_referentie)` in `curated.aanvraag`.
2. Gewijzigde `content_hash` → nieuwe rij in `aanvraag_versie` (SCD2), `versie` + 1, nieuwe `raw_payload_ref`.
3. Status-afleiding: gesloten als de bron dat meldt, de sluitingsdatum verstreken is, of de aanvraag in 3 opeenvolgende succesvolle runs niet meer gezien is.
4. Ontdubbeling over bronnen op titel + opdrachtgever + startdatum + uren (+ embedding) → `dedup_groep_id`; groeperen, nooit samenvoegen.
5. PII-retentie: contactvelden 90 dagen na sluiting genulled, ook in versies.
6. Marts (materialized views) verversen na elke run.
