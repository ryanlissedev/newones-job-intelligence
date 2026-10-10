# Deep dive: Job Intelligence — Config & stack

_Zichtbare tekst van het tabblad, uitgelezen via Interceptor op 2026-08-27._

Terug naar de plaat
Laag 2 · Vacaturebronnen · deep dive · spec 0.2 + requirements

## Catapulze Job Intelligence

v1 live · v2 in specificatieCatapulze Job Intelligence — specificatie v2 (concept)versie 0.2 · 2026-08-26

Download HTMLJSON van de specJSON van de requirementsKaart op de plaat

OverzichtPipelineDatamodelBronnenDatalaagConfig & stackFasen & complianceJSON Schemav1-analyseRequirementsMapping v1 → v2

### Bronconfiguratie (voorbeeld Striive)

Elke bron is een configuratie in het bronregister; bron-specifieke code alleen in de adapter.

bronnen/striive.jsonKopieer JSON

```
{
  "bron_id": "striive",
  "naam": "Striive / HeadFirst Group",
  "categorie": "msp_broker",
  "actief": true,
  "ingestie": {
    "type": "playwright",
    "listing_url": "https://striive.com/nl/opdrachten",
    "detail_selector": "a[href*='/opdrachten/']",
    "auth": {
      "type": "form",
      "secret_ref": "vault://striive/leverancier"
    },
    "rate_limit": {
      "requests_per_min": 20,
      "concurrency": 2
    },
    "respect_robots": true
  },
  "schedule": {
    "cron": "*/5 * * * *",
    "jitter_sec": 60,
    "freshness_sla_min": 15
  },
  "parser": {
    "adapter": "striive_v2",
    "fallback_llm": true,
    "llm_schema": "aanvraag.schema.json"
  },
  "dedup": {
    "sleutels": [
      "bron_referentie"
    ],
    "cross_source": true
  },
  "circuit_breaker": {
    "open_after_failures": 5,
    "half_open_after_min": 30
  },
  "voorwaarden": {
    "tos_url": "https://striive.com/nl/algemene-voorwaarden",
    "status": "te_toetsen",
    "eigen_account": true
  },
  "retentie": {
    "raw_maanden": 12,
    "contact_dagen": 90
  }
}
```

### Stack (voorstel)

| Laag | Keuze | Waarom |
| --- | --- | --- |
| Taal & modellen | Python 3.12 · Pydantic v2 (canoniek model = één bron van waarheid, genereert JSON Schema) | Eén definitie voor validatie, LLM-structured-output en documentatie |
| Fetch | Playwright (Chromium) voor login/JS-sites · httpx voor API/RSS/JSON-LD | v1 draait al op Playwright; httpx is goedkoper waar het kan |
| Extractie | Adapters per bron (selectors/JSON-mapping) · LLM-fallback via LiteLLM met structured output | Deterministisch waar mogelijk, LLM waar tekst ongestructureerd is; modelrouting blijft inwisselbaar |
| Opslag | Postgres 16 (+ pg_trgm, pgvector) · S3-compatibele object storage (bv. Cloudflare R2, Hetzner Object Storage, MinIO) | Cloud-agnostisch, open formaten, één database voor staging/curated/marts/search in fase 1 |
| Orkestratie | Eigen scheduler op Postgres-queue (SKIP LOCKED) met per-bron cron, jitter, retries en circuit breaker; later optioneel Prefect/Dagster | Klein en beheersbaar; v1-problemen (achterstallige runs) worden expliciet gemodelleerd |
| Search | Postgres full-text (tsvector, Nederlands) + pgvector embeddings + filters; later eventueel OpenSearch/Typesense | Geen extra systeem nodig tot volumes dat vragen |
| API & agents | FastAPI (search, aanvraag, bron_status) · MCP-server met tools search_aanvragen, get_aanvraag, bron_status, mark_relevant | Company OS-koppelvlak vanaf dag één |
| Dashboards | Metabase of Grafana op marts | BI naast de harness, rechtstreeks op de gecureerde zone |
| Observability | OpenTelemetry → Grafana/Loki · Langfuse voor LLM-calls · heartbeat via externe monitor | Observability & evals uit laag 3 |
| Hosting & secrets | Docker Compose op VPS (bv. Hetzner) of Fly.io · secrets in 1Password/Doppler | Low-risk start; verhuisbaar |

### Scheduling & betrouwbaarheid

- Per-bron cron + jitter + freshness-SLA; "achterstallig" is berekend en alarmeert.
- Postgres-wachtrij (`SKIP LOCKED`); één bron blokkeert nooit de rest.
- Retries met backoff; circuit breaker open na 5 fouten, half-open na 30 min.
- Dead man's switch op de scheduler zelf.
- Adapter-drift-alert bij te veel LLM-fallback of quarantaine; evals per adapter.
