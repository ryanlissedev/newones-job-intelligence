# Deep dive: Job Intelligence — Pipeline

_Zichtbare tekst van het tabblad, uitgelezen via Interceptor op 2026-08-27._

Terug naar de plaat
Laag 2 · Vacaturebronnen · deep dive · spec 0.2 + requirements

## Catapulze Job Intelligence

v1 live · v2 in specificatieCatapulze Job Intelligence — specificatie v2 (concept)versie 0.2 · 2026-08-26

Download HTMLJSON van de specJSON van de requirementsKaart op de plaat

OverzichtPipelineDatamodelBronnenDatalaagConfig & stackFasen & complianceJSON Schemav1-analyseRequirementsMapping v1 → v2

1

### Discover

Vind nieuwe en gewijzigde aanvragen per bron: API-paginering, RSS, listing-crawl (Playwright/HTTP), sitemap of ATS-endpoint.

Output Lijst van (bron_referentie, url, listing-hash)

Faalmodus Login verlopen, layout gewijzigd, rate limit → circuit breaker per bron

2

### Fetch & bewaar ruw

Haal detailpagina/JSON op (alleen bij nieuw of gewijzigde listing-hash) en schrijf de ruwe payload onveranderd naar de raw-zone.

Output Object in object storage: raw/{bron}/{jjjj}/{mm}/{dd}/{run}/{hash}.html|json

Faalmodus Blokkade/anti-bot → backoff, proxy-beleid per bron

3

### Extract

Structureer de payload: (a) API/JSON-LD direct mappen, (b) HTML-parser per adapter, (c) LLM-extractie naar het canonieke JSON Schema als fallback of voor vrije tekst (eisen/wensen, tarief in lopende tekst).

Output Bron-gevormd record in staging + extractie_methode + confidence

Faalmodus Parser breekt → automatisch terugvallen op LLM + alert 'adapter drift'

4

### Normaliseer

Eenheden, datums, enums, valuta, locaties (plaats→provincie), taal; HTML→markdown; skills naar taxonomie; PII-velden markeren.

Output Canoniek record (Pydantic-model)

Faalmodus Onbekende enumwaarde → 'onbekend' + registratie voor taxonomie-onderhoud

5

### Valideer & score

JSON Schema-validatie, verplichte velden, plausibiliteit (tarief 20–250 €/u, uren 4–40), compleetheid_score.

Output Geaccepteerd record of quarantaine met reden

Faalmodus Quarantaine loopt op → dashboardsignaal per bron

6

### Ontdubbel

Exact op (bron_id, bron_referentie); over bronnen heen fuzzy op titel + opdrachtgever + startdatum + uren (+ embedding-similariteit) → dedup_groep_id. Nooit samenvoegen, alleen groeperen.

Output dedup_groep + 'primaire' bron per groep

Faalmodus Fout-positieven → groepering handmatig te corrigeren; audit-log

7

### Classificeer & verrijk

functiegroep, relevantie_score + reden (LLM via LiteLLM), skills, opdrachtgever_type; optioneel organisatie-verrijking (Clay/KvK).

Output Verrijkt canoniek record

Faalmodus Model-drift → evals op vaste set; menselijke steekproef

8

### Laad in de datalaag

Upsert in curated.aanvraag; bij gewijzigde content_hash nieuwe rij in aanvraag_versie (SCD2); run-metadata in scrape_run; marts verversen.

Output Curated + marts actueel

Faalmodus Transactie mislukt → run gemarkeerd als 'partial', herstart idempotent

9

### Serve

Search-API (full-text + vector + filters), MCP-tools voor agents, dashboards op marts, push van relevante aanvragen naar Spott.io en notificaties.

Output Zoekresultaten, ATS-records, alerts

Faalmodus Spott-API onbeschikbaar → outbox-patroon, retry

10

### Monitor

Per bron: laatste succesvolle run, freshness-SLA, foutpercentage, aantal nieuw/gewijzigd/gesloten, circuit-breakerstatus; alerts via mail/Teams.

Output Dashboard + alerts

Faalmodus Scheduler zelf valt uit → externe heartbeat-check (dead man's switch)
