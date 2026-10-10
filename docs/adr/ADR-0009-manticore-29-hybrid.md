# ADR-0009 — Manticore 29 hybrid search candidate

- Status: Proposed
- Datum: 2026-09-03
- Eigenaar: Job Intelligence platform
- Gerelateerd: ADR-0003, ADR-0007, RJC-382 en opvolger,
  [zoekengine-besluit](../research/search-engine-decision-2026-09-03.md),
  [shadow-runbook](../../tools/manticore/README-29-shadow.md)

## Voorstel

Behoud Manticore 29.0.2 hybrid search als meetbare kandidaat achter
`SEARCH_HYBRID=1`, maar schakel hem nog niet in voor productie. De
golden-set-relevantie is overtuigend beter, terwijl de gecorrigeerde lokale
hybrid p95 van 202,15 ms de grens van 200 ms mist. De feature blijft daarom default
off totdat een schone hermeting binnen budget valt en de geplande
251k-corpusmeting op de Hetzner-box is uitgevoerd.

Dit ADR is bewust **Proposed**: het legt de kandidaat, implementatie en
meetuitkomst vast, niet de productie-switch.

## Kandidaatontwerp

De 29-shadowtabellen voegen één auto-embeddingkolom toe:

```text
FLOAT_VECTOR KNN_TYPE='hnsw' HNSW_SIMILARITY='cosine'
MODEL_NAME='Xenova/paraphrase-multilingual-MiniLM-L12-v2'
FROM='titel,beschrijving'
```

Het goedgekeurde Xenova ONNX-model is lokaal gedownload en gebruikt. De
toegestane fallback `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
was niet nodig. Alleen `titel` en `beschrijving`, die al in de lexicale DDL
staan, worden ingebed; er komt geen extra bronveld in de index (DEC-008).

Bij `SEARCH_HYBRID=0` of een andere waarde dan exact `1` blijven adapter,
projector en schema-hash lexicaal. De bestaande 6.3.8-configuratie is
byte-identiek gebleven (SHA-256
`3395269d42a5f1b9b5ef94ef09b2d32cbc61a074e99984a3c5ff47b59f05accb`).
Bij `SEARCH_HYBRID=1` selecteert de generatie/checkpoint-flow de v5-hash:

```text
aanvragen-v5[all|active|archive]:beschrijving,bron_id,contracttype,document_id,embedding,index_version,laatst_gezien_op,locatie,locatie_land,sluitingsdatum,status,tarief_max,tarief_min,titel,projection_hash;embedding=hnsw/cosine/Xenova/paraphrase-multilingual-MiniLM-L12-v2/from:titel+beschrijving;wordforms=gemeenten>gemeent,duurzame>duurzaam
```

De projector schrijft dan zowel naar de lifecyclepartitie als naar de
logische basistabel. Dat extra afgeleide exemplaar is nodig omdat Manticore
29.0.2 een hybrid multi-table-query met de bestaande aggregaties en
secundaire sortering weigert met `hybrid search does not support multiple
sorters`. Deletes verwijderen eerst de partities en als laatste de
basistabel; moves schrijven de nieuwe partitie en basistabel vóór de oude
partitie wordt verwijderd.

Server en projector moeten bij activering exact hetzelfde
`MANTICORE_URL=http://manticore29:9308` en `SEARCH_HYBRID=1` krijgen. De
shadow-healthcheck moet eerst groen zijn; vervolgens blijft de projector uit
tijdens `bun run search:new-generation --apply`, waarna één projector de
reindex draint en `bun run search:reconcile-projection` de fysieke inhoud
controleert vóór de server verkeer mag aannemen. Alleen het vlaggetje omzetten
zonder target- en generatie-switch is ongeldig.

## Querygedrag

- Alleen queries met positieve vrije tekst gaan hybrid. Boolean-only,
  NOT-only en elke query met een geneste `NOT` blijven lexicaal. Een live
  probe liet zien dat de onafhankelijke KNN-tak anders een door BM25
  uitgesloten document opnieuw kan introduceren.
- Hybrid gebruikt Manticore's native `MATCH()` + `KNN()` met
  `fusion_method=rrf`. Standaardattribuutfilters staan in dezelfde query en
  worden volgens de Manticore 29-handleiding op beide retrievaltakken
  toegepast.
- Relevantie sorteert op `hybrid_score() DESC, id ASC`. Andere bestaande
  sorteermodi behouden hun attribuutsortering met `id` als tie-breaker;
  pagination, totalen en QuerySnapshot/result-digest-semantiek blijven
  ongewijzigd.
- Manticore 29.0.2 accepteert in één hybrid request niet alle vijf facetten
  samen met de vereiste sortering. De engine doet daarom één hit/total-call,
  vijf parallelle single-facet-calls en voor active scope één aparte
  archieftelling. Alle calls krijgen dezelfde query en filters.
- Resultaat- en facetcachekeys bevatten expliciet `lexical` of `hybrid`,
  zodat beide modi nooit elkaars cache-entry lezen. De vector zelf wordt via
  `_source` niet teruggestuurd.

## Nederlandse wordforms

De 29-configuratie koppelt `tools/manticore/wordforms-nl.txt` met uitsluitend:

```text
gemeenten > gemeent
duurzame > duurzaam
```

Daarmee herstellen de twee gemeten missers `gemeente jeugdzorg` en
`duurzame energie`. `gemeent` is bewust de target: 29.0.2 stemt de enkelvoudige
vorm `gemeente` daarnaartoe. Deze twee regels zijn geen schaalbare
taalstrategie. Een expliciete eigenaar voor verdere Nederlandse wordforms,
synoniemen, evaluatie en onderhoud ontbreekt nog.

## Meetopzet

Op deze Mac is `bun run relevance` sequentieel uitgevoerd tegen:

1. Manticore 6.3.8 lexicaal;
2. Manticore 29.0.2 lexicaal op de auto-embedding-DDL;
3. Manticore 29.0.2 hybrid op dezelfde DDL.

De committed golden corpus leverde 33 indexeerbare documenten; één permanent
dienstverband is volgens de bestaande corpusregels overgeslagen. Alle 43
queries zijn full-scope gescoord. Latency is gemeten op dezelfde 43 queries
in active scope. De benchmark heeft vóór en na iedere Manticore-run nul rijen
bewezen in alle tabellen die de betreffende modus bezit. Dit is een lokale
functionele beslismeting, niet de nog open productiecapaciteitsmeting op 251k
documenten. De relevance-run gebruikt een vaste scope-ID, zodat de afgeleide
numerieke Manticore-ID en daarmee de `id`-tie-break over engines en herhaalde
runs gelijk blijven; de lege-tabellen-preflight voorkomt parallelle botsingen.

### Relevantie — Recall@20 / nDCG@10

| Categorie | 6.3.8 lexicaal | 29 lexicaal | 29 hybrid |
|---|---:|---:|---:|
| exact-skill | 0,792 / 0,809 | 0,792 / 0,809 | 0,958 / 0,888 |
| nl-morphology | 0,786 / 0,705 | 0,786 / 0,705 | 0,971 / 0,882 |
| compound | 0,429 / 0,429 | 0,429 / 0,429 | 1,000 / 0,895 |
| semantic-synonym | 0,188 / 0,202 | 0,188 / 0,202 | 0,844 / 0,577 |
| phrase-filter | 0,833 / 0,869 | 0,833 / 0,811 | 0,952 / 0,890 |
| nl-en-mix | 0,000 / 0,000 | 0,000 / 0,000 | 1,000 / 0,731 |
| **Overall macro** | **0,516 / 0,514** | **0,516 / 0,505** | **0,951 / 0,809** |

### Latency en indexing

| Modus | p50 | p95 | Indexing | Embedding |
|---|---:|---:|---:|---:|
| 6.3.8 lexicaal | 1,57 ms | 2,42 ms | 636,3 docs/s | n.v.t. |
| 29 lexicaal | 2,12 ms | 3,34 ms | 1,4 docs/s | 1,4 docs/s |
| 29 hybrid | 109,43 ms | 202,15 ms | 1,4 docs/s | 1,4 docs/s |

De twee 29-indexeringspasses verschillen door normale lokale runvariatie;
beide genereren hetzelfde model-embedding per document. Met 33 documenten is
de doorvoer slechts een eerste CPU-indicatie, geen capaciteitsprognose.

## Acceptatie-uitkomst

| Criterium | Uitkomst | Bewijs |
|---|---|---|
| semantic-synonym ≥ verse 6.3.8 | **Pass** | hybrid 0,844 versus 0,188 Recall@20 |
| NL/EN-kruistaal > 0 | **Pass** | hybrid 1,000 Recall@20 en 0,731 nDCG@10 |
| geen regressie exact-skill | **Pass** | 0,958 versus 0,792 Recall@20 |
| geen regressie phrase-filter | **Pass** | 0,952 versus 0,833 Recall@20 |
| hybrid p95 ≤ 200 ms | **Fail** | 202,15 ms; 2,15 ms boven budget |
| lexicaal p95 ≤ 50 ms | **Pass** | 2,42 ms op 6.3.8; 3,34 ms op 29 |
| lege tabellen bij start/einde | **Pass** | 6.3.8 twee tabellen; 29 alle drie, vóór en na elke run |

## Gevolgen en open punten

- Productie blijft lexicaal op 6.3.8; dit voorstel autoriseert geen traffic
  switch, merge of deployment.
- Onderzoek eerst waarom vijf facet-subqueries plus de model-query op deze
  laptop boven budget uitkomen. Elke tuning moet met dezelfde golden set en
  een nieuwe schone latency-run worden bewezen.
- Herhaal throughput en latency met het 251k-corpus op de doel-Hetzner-box;
  33 documenten bewijzen geen CPX32-capaciteit of volledige reindexduur.
- Wijs een eigenaar aan voor Nederlandse linguïstiek. Zonder eigenaarschap
  groeit het minimale wordforms-bestand ad hoc en zonder regressiebeleid.
- RRF kan negaties niet veilig combineren onder het huidige contract. Queries
  met `NOT` blijven daarom bewust lexicaal totdat Manticore beide takken onder
  dezelfde uitsluiting kan garanderen of een equivalent bewezen ontwerp
  beschikbaar is. Een gerichte 29.0.2-probe liet de uitgesloten KNN-hit zelfs
  met een aparte `bool.must_not` opnieuw toe; de negatieve-only KNN-prefilter
  faalde met `query is non-computable (single NOT operator)`. Dit is een
  expliciete afwijking van de gevraagde regel dat alle free-textqueries hybrid
  gaan en blijft dus een open acceptatiegap, geen afgeronde featureclaim.
