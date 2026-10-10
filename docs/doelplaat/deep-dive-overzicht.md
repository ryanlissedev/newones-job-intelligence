# Deep dive: Job Intelligence — Overzicht

_Zichtbare tekst van het tabblad, uitgelezen via Interceptor op 2026-08-27._

Terug naar de plaat
Laag 2 · Vacaturebronnen · deep dive · spec 0.2 + requirements

## Catapulze Job Intelligence

v1 live · v2 in specificatieCatapulze Job Intelligence — specificatie v2 (concept)versie 0.2 · 2026-08-26

Download HTMLJSON van de specJSON van de requirementsKaart op de plaat

OverzichtPipelineDatamodelBronnenDatalaagConfig & stackFasen & complianceJSON Schemav1-analyseRequirementsMapping v1 → v2

75

Canonieke velden

19 verplicht

29

Bronnen

7 in v1 · 23 nieuw · werkenbij-sites

6

Broncategorieën

elk met eigen adapter-type

10

Pipeline-stappen

idempotent en herstartbaar

4

Datalagen

raw → staging → curated → marts

5

Fasen

v2.0 t/m v2.4

110

Requirements

90 must · 18 should · 2 could

14

Requirement-domeinen

scope t/m migratie

62

v1-kolommen gemapt

11 nieuwe canonieke velden

33

v1-tabellen geanalyseerd

240.131 aanvragen · 26-08-2026

### Doel

Aanvragen en vacatures verzamelen van brokers, MSP's, DAS-/tenderplatformen, overheidsportalen, jobboards én werkenbij-sites; normaliseren naar één canoniek model; betrouwbaar wegschrijven naar de datalaag; analyse en search erop.

### Principe

Eén canoniek model voor alle bronnen; alles wat daar niet in past gaat verliesvrij mee in bron_specifiek en blijft herleidbaar naar de ruwe payload.

### Wat v1 ons leert

Op 25-08-2026 stonden alle v1-scrapers op "Achterstallig" en MiPublic op "Circuit geopend". v2 maakt scheduling en freshness eerste-klas concepten met alerts, isoleert bronnen van elkaar (circuit breaker, half-open herstel) en bewaart ruwe payloads met versiebeheer zodat herverwerken altijd kan.

Op 26-08-2026 zijn de v1-app en het volledige Neon-schema geanalyseerd (33 tabellen, 240.131 aanvragen): zie v1-analyse, de 110 requirements en de veldmapping van alle 62 `jobs`-kolommen.

### Veldgroepen

| Col 1 | Col 2 |
| --- | --- |
| Identificatie & herkomst | 15 velden |
| Kern van de aanvraag | 9 velden |
| Locatie & werkplek | 5 velden |
| Omvang & looptijd | 8 velden |
| Tarief & vergoeding | 9 velden |
| Inhuurvorm & voorwaarden | 8 velden |
| Eisen, wensen & beoordeling | 7 velden |
| Tijdlijn & status | 4 velden |
| Contact (PII) | 3 velden |
| Bijlagen & bron-specifiek | 2 velden |
| Kwaliteit & verrijking (afgeleid) | 5 velden |

### Open vragen

- Welke minimale veldenset is nodig om een aanvraag 'werkbaar' te noemen voor het bemiddelingsproces? (voorstel: titel, opdrachtgever of intermediair, locatie of remote, uren, start, sluitingsdatum, tarief_max of tariefindicatie)
- DWH-technologie: Postgres als DWH in fase 1 is voldoende — akkoord, of direct een apart analytisch platform?
- Welke werkenbij-sites (bedrijvenlijst) hebben prioriteit — uit Clay of handmatig?
- Wie beoordeelt de juridische toets per broker-portaal en wat is het besluitproces?
- Moet Job Intelligence ook historische (gesloten) aanvragen bewaren voor tariefanalyse? (voorstel: ja, niet-PII onbeperkt)
- Pushen we aanvragen automatisch naar Spott.io of alleen na menselijke kwalificatie?

### Status

concept — ter review door Robbie en Julian; 0.2 voegt v1-analyse, requirements en veldmapping toe · versie 0.2 · 2026-08-26
