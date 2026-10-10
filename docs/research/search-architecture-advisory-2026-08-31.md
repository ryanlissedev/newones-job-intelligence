# Extern zoekarchitectuur-advies (2026-08-31)

> Door Ryan aangeleverd extern advies over het zoekpad richting 1M vacatures.
> Hier vastgelegd omdat RJC-378, RJC-382 en RJC-383 ernaar verwijzen. Status per
> punt aangevuld door het team; het advies zelf is niet herschreven.

## Kernboodschap

Bij 1M vacatures is de corpusomvang niet het grootste risico — dat zijn: de oude
engineversie, de beperkte benchmark, het 100-id-venster, de extra
Postgres-hydration en de frontend-filtering. Eerst het hot path corrigeren;
daarna laat een bake-off eerlijk zien of een enginewissel nog iets toevoegt.

## De aanbevolen doelarchitectuur

De engine levert complete resultaatkaarten — filtering, ranking, sortering,
paginering, highlights, facetten in één antwoord. Postgres blijft de
gezaghebbende bron voor wijzigingen en de detailpagina, maar verdwijnt uit het
kritieke leespad (covering index: alle lijstvelden in het search-document).

Verdere hoofdpunten:

1. **Alle filtering/sortering vóór de top-k** in de engine (land/plaats, status,
   bron, contractvorm, tariefrange, datum; sortering op relevantie/recentheid/
   tarief). Anders zoek je "beste 100" en filtert daarna weg → ontbrekende
   resultaten en te lege pagina's.
2. **Actief/archief splitsen**: standaard zoeken in `vacancies_active`,
   "zoek ook in archief" als expliciete optie. Kleinere working set, goedkopere
   facetten.
3. **Resultaten scheiden van totalen/facetten**: eerste resultaten ~100 ms,
   facetten+totaal ~250 ms, dure verrijking later. Waargenomen snelheid = eerste
   nuttige resultaten.
4. **Queryrouter** zodra hybrid er is: recruiter-Boolean → alleen BM25;
   filter-only → filterindex; natuurlijke taal → BM25+vector+RRF; automatische
   matching → apart, asynchroon pad met reranker over alleen de top-100.
   Productregel: resultaatvolgorde mag hybrid zijn, totalen en facetten worden
   over de lexical query + harde filters berekend.
5. **Twee-stapsranking**: harde filters → BM25 top-300 + vector top-200 → RRF →
   top-50–100 → lichte business-reranker → top-20. Nooit een LLM/cross-encoder
   over de volle miljoen.

## Engine-opties (samenvatting van het advies)

| Optie | Oordeel |
|---|---|
| **Manticore 29** | Eerste keuze: adapter/outbox/facetten/Boolean bestaan al; 29.x heeft native hybrid (BM25+KNN+RRF, filters op beide paden). Geen in-place upgrade vanaf 6.3.8 — tweede instance, herindex, shadow queries, dan omzetten. |
| Typesense | Sterk bij gestructureerde chips-UX; vrije recruiter-Boolean is de beperking. Vendor-benchmark ~11 ms op 2,2M docs / 4 vCPU. |
| ParadeDB-searchreplica | Beste Postgres-centrische optie, via logical replication naast Neon (pg_search is dicht voor nieuwe Neon-projecten). Niet op de primary draaien. |
| OpenSearch | Volwassen clusteroptie; pas aantrekkelijk als HA/multi-tenancy/schaal leidend worden. |
| Vespa | Sterkste kandidaat als ranking/matching het kern-IP wordt (multi-fase ranking, grouping over volledige matchset). Te veel voor alleen snelle search. |
| Eigen Tantivy-service | Escape hatch achter de SearchAdapter (~5–7 pw vs ~1 pw integratie). Niet de eerste stap. |
| Postgres FTS + pgvector | Goede baseline, minder veilige eindkeuze. |

## Voorgestelde SLO's

| Onderdeel | Doel |
|---|---|
| Lexical engine p95 | ≤ 50 ms |
| Eerste complete resultaatpagina p95 | ≤ 120 ms |
| Facetten + totaal p95 | ≤ 250 ms |
| Hybrid p95 (zonder zware reranker) | ≤ 200 ms |
| Automatische matching | asynchroon, geen UI-SLO |
| Index/update-zichtbaarheid | ≤ 5 s |
| Beschikbaarheid | ≥ 99,9% |

## Benchmarkeisen (advies)

Eén reproduceerbare corpusset van 1M realistische vacatures door minimaal
Manticore 29, Typesense en een ParadeDB-replica; meet p50/p95/p99, CPU/RAM,
indexgrootte en -snelheid, update-latency, facet-latency, exactheid totalen,
timeouts, replicatie-lag, nDCG@20 en recall@50; concurrency 1/10/25/50; en test
tijdens actieve ingest — snel op een statische index kan alsnog instorten onder
honderden updates per minuut.

## Status per punt (team, 2026-08-31)

- **Fan-out**: opgelost — PR #80 bracht 203 HTTP-calls per zoekopdracht terug
  naar 3 (RJC-379, Done). De covering index is de logische opvolger (3 → 1).
- **Venster/totaal/sortering client-side**: bevestigt RJC-378; het advies is
  daar als aanvulling vastgelegd, samen met de SLO's voor DEC-004.
- **Manticore-versie**: geverifieerd — wij pinnen 6.3.8, upstream zit op 29.x.
  Side-by-side-evaluatie met covering index en shadow queries: RJC-382.
- **Actief/archief**: RJC-383; hangt samen met RJC-376/377 (sluitingslogica).
- **Relevantie meetbaar**: de golden set (PR #84) levert het instrument dat de
  bake-off uit dit advies eerlijk maakt — eerste cijfers: in-memory 0.457
  R@20, Manticore 6.3.8 0.523; NL/EN-kruistaal 0.000 op beide.
- **Queryrouter/hybrid/matching**: nog niet getickt; aan de orde na RJC-382.
