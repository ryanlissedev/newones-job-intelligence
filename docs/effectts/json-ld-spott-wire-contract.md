# Wire-contract checklist — JSON-LD listing/detail & Spott REST list/get

Status: normatief voor CTP-454/CTP-455 read-adapters\
Peildatum: 2026-09-07\
Parent: [ADR-0013](../adr/ADR-0013-effectts-platform-baseline.md)

Beide adapters moeten **hetzelfde functionele contract** implementeren. Verschillen in transport (HTML/sitemap vs JSON REST) zijn toegestaan; verschillen in deadline-, fault-, retry-, concurrency-, cleanup-, tracing- of resultaatgedrag zijn dat niet.

## Operaties

| Adapter | List/discover | Get/detail |
| --- | --- | --- |
| JSON-LD | `fetchListing()` → discovery URLs | `fetchDetail(url)` → JobPosting + labelBlock |
| Spott REST | `listVacancies(params?)` → items + pageInfo | `getVacancy(id)` → vacancy detail |

## Checklist (per operatie)

- [ ] **Deadline / AbortSignal** — caller kan een deadline of `AbortSignal` doorgeven; bij abort stopt de operatie zonder extra attempt.
- [ ] **Faultcategorieën** — errors mappen op `auth` / `validation` / `not_found` / `rate_limit` / `transient_network` / `server_5xx` / `cancel` (ADR-0013).
- [ ] **Retry-budget** — alleen transient/429/5xx; max attempts en backoff expliciet; geen retry op auth/validation/not_found/cancel.
- [ ] **Retry-After** — bij 429: header respecteren wanneer aanwezig; anders policy-backoff binnen budget.
- [ ] **Concurrency** — JSON-LD via `RequestLimiter` / crawl-delay; Spott binnen 600 req/min; geen ongecontroleerde parallelle storms.
- [ ] **Cleanup** — timers, in-flight fetch en limiter-claims vrijgeven bij succes, fout én cancel.
- [ ] **Tracing** — critical-path of equivalent label voor discover/fetch/list/get wanneer het pad al instrumenteert; geen PII in spans/artifacts.
- [ ] **Wire-resultaat** — succes = typed payload; falen = gecategoriseerde error (geen swallowed empty success).

## Fixture / sandbox

- Default tests: fixtures only (`SPOTT_LIVE` unset; JSON-LD `liveEnabled` false).
- Geen PII in fixtures of baseline-artifacts.
- Geen productieactivatie vanuit de harness.

## Reviewrubric (onafhankelijke reviewer)

Per variant (huidige Promise-adapter vs toekomstige Effect-adapter) moet de reviewer kunnen aanwijzen:

1. **Retry-eigenaar** — wie beslist over request-retry vs Trigger-task-retry, en wat is het totaalbudget?
2. **Cancellationpad** — waar wordt `AbortSignal`/deadline gehonoreerd en gestopt?
3. **Cleanup-eigenaar** — wie released timers/fetch/limiter state?

Vastgelegde uitkomst per variant hoort in het baseline-artifact (`reviewRubric`).

Gemeten native uitkomst + Effect-blocked notitie: [`docs/evidence/ctp-454/review-rubric.md`](../evidence/ctp-454/review-rubric.md).
