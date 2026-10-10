# ADR-0018 — Volledige bronvastlegging: ruwe bytes, alle bronvelden en bijlagen

- Status: Proposed; §1 (bewaren van ruwe HTML en bijlagen) staat op `pending-owner-acceptance` omdat het DEC-008 (CTP-324) raakt
- Datum: 2026-10-09
- Eigenaar: Job Intelligence platform (`@ji/connectors`, `@ji/db`)
- Approver: Ryan (platform) en Robbie (product/juridisch) voor §1 en §4
- Gerelateerd: ADR-0008 (R2 raw store), DEC-008 / CTP-324 (minimalisatie en retentie), CTP-505 (missende bronnen), CTP-570 (Mercell), #468 (lastmod-skip), mijlpaal 3 (PR8–PR11)

## Context — wat er vandaag werkelijk gebeurt

Gelezen op `main` @ `8157078`.

| Onderdeel | Stand | Waar |
|---|---|---|
| Content-addressed raw store op R2 | Bestaat. Sleutel `raw/<slug>/<jjjj>/<mm>/<sha256>.<type>`, digest-verificatie bij teruglezen | `object-store.ts`, `run.ts:416` |
| Wat er als "raw" wordt opgeslagen | **Niet de bronbytes.** Alle 16 connectorfamilies schrijven `contentType: "json"`: het al geparste payload | `*/connector.ts` |
| JSON-LD-familie (35 bronnen) | Bewaart `{jobPosting, labelBlock, contactpersonen}`. De HTML van de detailpagina wordt na extractie weggegooid | `json-ld/connector.ts:365` |
| Mercell | DEC-008-whitelist laat o.a. `TenderDescriptionDocuments`, `RequirementBoxes`, `TenderPublicationDetails` en `LinkedTenders` bewust weg | `mercell/types.ts:78` |
| TenderNed | Alleen listing + detailkern; geen documenten | `tenderned/types.ts` |
| Bijlagen | Geen enkele connector vindt of haalt bestanden op. `RawContentType` kent `"pdf"` al, maar niets gebruikt het | `object-store.ts:4` |
| Bronvelden buiten het model | `aanvraag.bron_specifiek` (jsonb) bestaat, maar elke normaliser kiest zelf een handvol sleutels | `normalise/*.ts` |
| Herkomst per veld | `field(value, parserVersion, bron)` in de draft; `extractie_methode` per rij | `identity/curate.ts` |
| Replay vanaf de object store | Niet gebouwd; `replayBron` gooit op `kind: "object-store"`. Alleen fixture-replay werkt | ADR-0008 §5 |
| Retentie | `expiresAt` wordt gezet (`bron.retention_days`, default 90), maar niemand roept `deleteExpired` aan | `run.ts:435` |
| Lijstpagina's | Niet opgeslagen; alleen `listing_hash` per record | `staging.source_record` |
| Conditionele requests | Geen ETag/If-Modified-Since; wel lastmod-skip voor sitemaps (#468) | `json-ld/lastmod-skip.ts` |

Gevolgen:

1. Een betere parser helpt alleen voor nieuwe fetches. Velden die de extractor van vandaag niet oppakt (salaristabel buiten JSON-LD, eisenlijst, recruiterblok) zijn voor bestaande records weg; terughalen kost een volledige hercrawl van de bron.
2. Bij aanbestedingsbronnen zit de inhoud in de documenten. Die hebben we niet.
3. `content_hash` hasht het geparste payload inclusief `parserVersion`. Een parser-bump maakt daardoor elk record "changed" en voedt de curatie-achterstand (757k observaties, 684k ongewijzigd).

## Besluit (voorstel)

### 1. Twee lagen in de raw store: bronbytes en extractie

De connector levert naast het geëxtraheerde payload ook de bytes zoals de bron ze gaf.

```ts
// packages/connectors/src/contract.ts — additief, bestaande connectors blijven geldig
export interface RawCapture {
  readonly body: Uint8Array;              // exact wat de bron teruggaf
  readonly contentType: RawContentType;   // "html" | "json" | "pdf" (+ "xml")
  readonly url: string;                   // de werkelijk opgevraagde URL (na detailUrlRewrite)
  readonly httpStatus: number;
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface ConnectorFetchedResult {
  // ...bestaand: body (extractie), bronReferentie, contentHash, contentType, status
  readonly capture?: RawCapture;          // nieuw
  readonly assets?: readonly DiscoveredAsset[]; // nieuw, zie §3
}
```

- De runner schrijft `capture.body` gzip-gecomprimeerd naar dezelfde content-addressed store en zet `source_record.capture_ref`, `capture_hash`, `etag`, `last_modified`.
- **Twee hashes, twee doelen.** `capture_hash` (bronbytes) is voor opslag-dedup en replay. `content_hash` (extractie) blijft bepalen of een record "changed" is. HTML bevat nonces, CSRF-tokens en timestamps; als de bytehash de change-detectie zou sturen, wordt alles elke poll "changed".
- `parserVersion` gaat uit de `content_hash`-invoer en blijft als kolom op de observatie. Een parser-bump wordt dan een expliciete herverwerking (§5) in plaats van een stille golf "changed".
- `etag`/`last_modified` op `source_record` maken PR9 (conditionele GET) een kleine vervolgstap: `304` telt als gezien, zonder body en zonder observatie.

### 2. Alle bronvelden bewaren

- API-bronnen (Mercell, TenderNed, Striive, werk.nl, Indeed, ...) slaan de volledige detail-response op als `capture`. De types blijven smal; de whitelist bepaalt wat de normaliser leest, niet wat we bewaren.
- JSON-LD-bronnen: het volledige `JobPosting`-node zit al in het payload; de HTML komt erbij via §1.
- `bron_specifiek` krijgt een vaste afspraak: alles wat de bron gestructureerd publiceert en geen canonieke kolom heeft, komt er onder de bronsleutel in. `check:field-coverage` krijgt een tweede meting: welke bronsleutels komen voor in fixtures maar in geen enkele kolom of `bron_specifiek`-sleutel. Dat is de lijst van wat we laten liggen.

### 3. Bijlagen als eigen pipeline

Vinden in de connector, ophalen in een aparte lane.

```ts
export interface DiscoveredAsset {
  readonly url: string;
  readonly filename?: string;
  readonly label?: string;          // linktekst of documenttype uit de bron
  readonly declaredType?: string;   // wat de bron zegt; niet vertrouwd
  readonly sizeBytes?: number;
}
```

```sql
-- staging.source_asset: één rij per (record, bestand)
source_record_id uuid not null references staging.source_record(id) on delete cascade,
bron_id          uuid not null,
url              text not null,
filename         text,
label            text,
status           text not null default 'pending',  -- pending|stored|skipped|failed|gone
skip_reason      text,                              -- too_large|type_not_allowed|login_required|policy
sniffed_type     text,                              -- bepaald op magic bytes
size_bytes       bigint,
asset_hash       text,                              -- sha256 van de bytes
object_ref       text,                              -- assets/<sha256>, bron-onafhankelijk
text_ref         text,                              -- geëxtraheerde tekst
text_status      text,                              -- none|extracted|ocr|failed
first_seen_at / last_seen_at / fetched_at timestamptz,
unique (source_record_id, url)
```

- **Lane:** een `fetch-asset`-job in de bestaande `durable_job`-queue, met de limiter van de bron en een eigen budget. Een groot bestek mag een poll-run niet ophouden.
- **Grenzen:** allowlist op gesnuffeld type (pdf, docx, xlsx, odt, txt, zip alleen als lijst van inhoud), maximum per bestand en per record, geen redirects naar een andere host zonder allowlist, bestanden worden nooit uitgevoerd of gerenderd.
- **Dedup:** `object_ref` op `asset_hash`. Hetzelfde inkoopvoorwaarden-PDF bij 400 tenders staat er één keer.
- **Tekst:** PDF-tekstlaag eerst; OCR alleen bij scans en pas na een meting van hoe vaak dat voorkomt. De tekst gaat als apart veld naar Manticore, niet in `beschrijving`, zodat een treffer in een bijlage als zodanig te tonen is.
- **Curated:** `aanvraag` krijgt geen kolom; de UI en MCP lezen bijlagen via `aanvraag_bron_link → source_record → source_asset`. Opdrachtbewijs in FUUSE kan dan per document de bron-URL, hash en ophaaltijd tonen.

Vindplaatsen per familie:

| Familie | Bron van de bestandslijst |
|---|---|
| Mercell | `TenderDescriptionDocuments` in de detail-response (nu weggelaten) |
| TenderNed | documenten-endpoint per `publicatieId` (te verifiëren tegen de live API) |
| CTM, Opdrachtoverheid, Inhuurdesk | links in detail-payload; per bron inventariseren |
| JSON-LD / werkenbij | `<a href>` naar toegestane extensies binnen het vacatureblok van de opgeslagen HTML |

### 4. Retentie en minimalisatie — besluit nodig

Dit voorstel draait DEC-008 deels om: we bewaren meer, niet minder. Dat kan alleen samen met:

- een werkende purge-job (`deleteExpired` wordt nu nergens aangeroepen) die ook `source_asset` en de zoekindex meeneemt;
- retentie per laag: bronbytes en bijlagen korter of gelijk aan `bron.retention_days`; extractie volgt de curated levensduur;
- bijlagen alleen voor bronnen met `voorwaarden_status = 'toegestaan'` én een expliciete vlag `assets_toegestaan` op `bron`, default uit. Bestekken en functieprofielen bevatten auteursrechtelijk materiaal en namen van contactpersonen;
- geen bijlagen achter login zonder account en toestemming van de bron.

### 5. Herverwerken vanaf de store

`replayBron` krijgt de `object-store`-tak: lees `capture_ref`, draai de huidige extractor en normaliser, schrijf een observatie met de nieuwe `parserVersion`. Opgeslagen captures worden ook de bron voor fixtures, zodat een gebroken bron te reproduceren is zonder netwerk.

## Volgorde

| Stap | Inhoud | Afhankelijk van |
|---|---|---|
| A | `capture` in het contract + runner + kolommen op `source_record`; JSON-LD-familie als eerste (35 bronnen in één keer) | migratie na 0031 |
| B | `parserVersion` uit `content_hash`; eenmalige herberekening zonder observaties | A |
| C | Purge-job + retentie per laag | DEC-008 |
| D | `source_asset` + `fetch-asset`-lane; proef met Mercell | A, C, akkoord §4 |
| E | Tekstextractie + Manticore-veld | D |
| F | Replay vanaf store; coverage-meting "wat laten we liggen" | A |
| G | ETag/If-Modified-Since (PR9) op de nieuwe kolommen | A |

A en B leveren los van bijlagen al iets op: herverwerken zonder hercrawl, en geen "changed"-golf meer bij een parser-bump.

## Consequenties

- **Opslag:** HTML-detailpagina's zijn een veelvoud van het huidige JSON-payload. Meten op één dag JSON-LD-verkeer vóór brede uitrol; ADR-0008 rekende met 45–90 GB in jaar 1 en met operaties, niet volume, als kostenpost. Elke capture is twee extra Class A-writes (body + sidecar).
- **Schrijfpad:** één extra object-store-put per gewijzigde fetch. Ongewijzigde pagina's (lastmod-skip, straks 304) kosten niets extra.
- **Contract:** additief. Connectors zonder `capture` blijven werken; een spec per familie dwingt het daarna af.
- **Privacy:** ruwe HTML bevat meer persoonsgegevens dan het payload. Toegang tot captures en bijlagen blijft achter dezelfde preview-gate als raw vandaag.

## Open punten

- Bestaat het TenderNed-documenten-endpoint publiek en zonder login? Niet geverifieerd.
- Hoeveel werkenbij-sites linken werkelijk naar bestanden? Onbekend tot stap A een week draait; daarna te tellen uit de opgeslagen HTML.
- Maximale bestandsgrootte en totaalbudget per bron: voorstel 25 MB per bestand, vast te stellen na de Mercell-proef.
- Lijstpagina's opslaan is bewust buiten scope gelaten: ze leveren geen velden op die de detail niet heeft, behalve bij Mercell (`Deadline`), waar de listingrij al in het payload zit.
