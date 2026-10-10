# Zoekengine-besluit: Manticore 29 of OpenSearch? (2026-09-03)

Vraag van Ryan: heeft Manticore alles wat we nodig hebben, en zo niet, moeten we
nu naar OpenSearch? Dit document toetst de eisen uit `docs/BUILD_BRIEF.md`,
`docs/research/search-architecture-advisory-2026-08-31.md` (SLO's) en de
golden-set-categorieën (`benchmarks/relevance`) tegen de actuele documentatie
van beide engines. Bronnen onderaan.

## Eisen

| # | Eis | Bron |
|---|---|---|
| E1 | Geneste Boolean over titel + volledige omschrijving, phrase, prefix | BUILD_BRIEF §35 |
| E2 | Facetten (platform, status, contract, provincie, skills, tarief, uren, datum) | BUILD_BRIEF §56 |
| E3 | Deterministische paginering en onveranderlijke QuerySnapshot (indexversie) | BUILD_BRIEF §141, migratie 0007 |
| E4 | p95 lexicaal ≤ 50 ms, hybrid ≤ 200 ms, op 200k docs; schaalpad 2,5–15M | advisory SLO-tabel, DEC-004 |
| E5 | Nederlandse morfologie; semantische synoniemen (`se-*`) en NL/EN-kruistaal (nu 0,000) | golden set, ADR-0007 |
| E6 | Hybrid search (BM25 + vector) met lokaal draaiend, meertalig embeddingsmodel — geen per-query API-kosten | Ryan 2026-09-03 |
| E7 | Draait naast server/web/projector/Redis op één Hetzner CPX32 (4 vCPU, 8 GB) | hetzner-deploy runbook |
| E8 | Vervangbaar achter `SearchAdapter`; outbox/projector-flow blijft | ADR-0007 |

## Matrix

| Eis | Manticore 29.0.2 | OpenSearch 3.x |
|---|---|---|
| E1 Boolean/phrase/prefix | Ja, bestaand (`MATCH()`, adapter, golden set) | Ja (`query_string`); adapter en Boolean-parser opnieuw mappen |
| E2 Facetten | Ja, één pass (`FACET`), bestaand | Ja (aggregations) |
| E3 Determinisme | Sort + id, bestaand; generatie/checkpoint-mechanisme werkt op RT-tabellen | Eén shard + sort + id; `search_after`; snapshot-koppeling opnieuw bouwen |
| E4 Latency | 6.3.8 en 29 halen p95 ≤ 100 ms op 20k (laptop); 29 sneller op boolean (3–6 ms vs ~40 ms). 200k-run op de box staat nog open | Doorgaans ruim binnen SLO, maar JVM-heap-vloer (engine-tabel: ~8 GB) |
| E5 Nederlands | Stemmer `libstemmer_nl` (in gebruik). **Geen Nederlandse lemmatizer** (alleen en/ru/de). Wordforms/synoniemen en fuzzy search aanwezig. De `se-jeugdzorg`/`se-duurzameenergie`-regressie op 29 komt door een stemmingsverschil, niet door een ontbrekende feature | `dutch`-analyzer (Snowball), synoniemen, hunspell mogelijk. Zelfde klasse: stemmen, geen echte lemmatisering |
| E6 Hybrid + lokaal meertalig model | **Ja**: native `MATCH()`+`KNN()` met RRF-fusie in één query, auto-embeddings bij insert. Lokale modellen: ONNX (elk HF-model met `.onnx`, bijv. `Xenova/*`) of sentence-transformers "elk BERT-gebaseerd HF-model" → `paraphrase-multilingual-MiniLM-L12-v2` is bruikbaar. Remote: OpenAI/Voyage/Jina. KNN met pre-/postfilter. Alleen RRF als fusie (geen gewogen som) | **Ja**: hybrid query met RRF of normalisatie-processor; ML Commons met voorgetrainde modellen, o.a. `paraphrase-multilingual-MiniLM-L12-v2`, `distiluse-base-multilingual-cased-v1` en neural-sparse multilingual v1 (sterk voor NL). Model draait op een ML-node in de JVM |
| E7 Eén 8 GB-box | Laag geheugen; embeddingsmodel draait in searchd. Aandachtspunt: CPU-doorvoer van auto-embeddings bij 251k docs (forum meldt traagheid; ONNX-pad is geoptimaliseerd) — meten | Praktisch niet: JVM-heap + ML-model + app-containers passen niet in 8 GB; tweede/grotere server nodig |
| E8 Adapter | Bestaand, plus outbox/projector, schema-hash, generaties | Nieuwe adapter-implementatie (SQL → DSL), nieuwe projector-target, nieuwe runbooks; ~weken werk en dubbele run tijdens overgang |

## Oordeel

1. Manticore 29 dekt alle acht eisen. De enige echte tekortkoming ten opzichte
   van OpenSearch is het ontbreken van neural-sparse (SPLADE-achtige)
   retrieval; dense hybrid met een meertalig model is er wel.
2. De twee gaten die we vandaag meten (semantische synoniemen, NL/EN-kruistaal)
   zijn geen lexicale features maar precies waar hybrid search voor bestaat.
   Het is dus geen reden om van engine te wisselen; het is een reden om de
   openstaande hybrid-eval te doen.
3. OpenSearch is in dit stadium een verkeerde ruil: het lost E5/E6 niet beter op
   dan Manticore 29, kost een tweede machine en weken aan adapter-, projector-
   en runbookwerk, en gooit de gemeten baseline en het golden-set-instrument
   deels weg. Het advies van 2026-08-31 zei hetzelfde: OpenSearch pas als HA,
   multi-tenancy of schaal leidend worden.

**Besluitvoorstel:** niet switchen. Wel de 6.3.8 → 29-overgang afronden op basis
van een hybrid-meting op de box, niet op een lexicale vergelijking alleen.

## Concreet plan (opvolger van RJC-382)

1. Shadow `manticore29` op de Hetzner-box (compose-profiel bestaat; als Coolify-service toevoegen) met een tweede tabel met `FLOAT_VECTOR KNN_TYPE='hnsw' MODEL_NAME='Xenova/paraphrase-multilingual-MiniLM-L12-v2' FROM='titel,omschrijving'` (ONNX-pad; fallback `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`).
2. Na de eenmalige Motian-import de projector ook naar de shadow laten draineren; meet embeddings-doorvoer (docs/s, CPU) — dit is het enige echte risico op een CPX32.
3. Golden set draaien in drie configuraties: 6.3.8 lexicaal, 29 lexicaal, 29 hybrid (RRF). Acceptatie: `semantic-synonym` ≥ verse 6.3.8 (0,500/1,000 op de twee regresserende queries), NL/EN-kruistaal > 0, geen regressie op exact-skill/phrase-filter, p95 hybrid ≤ 200 ms en lexicaal ≤ 50 ms op het 251k-corpus, lege tabellen bij start (baseline-hygiëne).
4. Goedkope lexicale flankering, onafhankelijk van hybrid: `wordforms` voor de gemeten stemmingsmissers (jeugdzorg, duurzame energie) in beide engines.
5. Bij groen: switch `MANTICORE_URL` naar 29 via de bestaande generatie/checkpoint-flow; 6.3.8 blijft één ronde als fallback.
6. OpenSearch pas heroverwegen bij: HA-eis, multi-tenancy, >2,5M docs met meerdere nodes, of wanneer neural-sparse aantoonbaar nodig is.

## Bronnen

- Manticore hybrid search: https://manticoresearch.com/blog/hybrid-search/ en https://manual.manticoresearch.com/Searching/KNN (RRF, `MODEL_NAME`/`FROM`, ONNX- en sentence-transformers-modellen, remote OpenAI/Voyage/Jina, pre-/postfilter)
- Manticore datatypes/auto-embeddings: https://manual.manticoresearch.com/Creating_a_table/Data_types
- Manticore talen/morfologie: https://manual.manticoresearch.com/Creating_a_table/NLP_and_tokenization/Supported_languages (Dutch via stemmer; lemmatizers alleen en/ru/de)
- Manticore changelog 29.0.2 (14 aug 2026, sharded tables): https://manual.manticoresearch.com/Changelog
- Auto-embeddings-doorvoer (forum, apr 2026): https://forum.manticoresearch.com/t/autoembeddings-very-slow-performance/3119
- OpenSearch hybrid search (RRF): https://docs.opensearch.org/latest/vector-search/ai-search/hybrid-search/index/
- OpenSearch voorgetrainde modellen (multilingual MiniLM, distiluse, neural-sparse multilingual v1): https://docs.opensearch.org/latest/ml-commons-plugin/pretrained-models/
- OpenSearch taal-analyzers (Dutch): https://docs.opensearch.org/latest/analyzers/language-analyzers/index/
- Intern: `docs/research/manticore-29-comparison-2026-09-01.md`, `docs/research/manticore-relevance-baseline-correction-2026-09-01.md`, `docs/research/manticore-latency-2026-09-01.md`, `docs/adr/ADR-0007-search-platform-state-2026-09-01.md`, `tools/manticore/README-29-shadow.md`
