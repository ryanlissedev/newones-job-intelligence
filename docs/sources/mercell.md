# Mercell s2c (ex-Negometrix) — ingest-recept (geverifieerd 2026-09-18)

Status: **gebouwd (POC, CTP-570)** — rung 1 technisch (ongeauthenticeerde
JSON-API), maar met een beleidsnoot: `s2c.mercell.com/robots.txt` is
`Disallow: /` voor de hele site. De eigenaar heeft de ToS voor deze POC
expliciet gewaived; `voorwaarden_status: toegestaan` legt dat besluit vast.
Scope: NL onderdrempelige opdrachten / DAS-minicompetities — het segment dat
TenderNed nooit bereikt (cross-check 27-08 in `docs/SOURCE_MATRIX.md`).

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `POST https://api.s2c.mercell.com/api/v1/PublishedTender/GetPublishedTendersBySpecified` | `{SearchParameters: {StartIndex, EndIndex, PropertyFilters, SearchText, SearchProperty, OrderAscending, OrderColumn, Keywords, UserId}}` → `{ResultsCount, CurrentPageResults[]}`. Ongeauthenticeerd (het Angular-portaal `s2c.mercell.com/today` roept het zelf zo aan). `Content-Type: application/json` vereist — zonder → HTTP 500. |
| Detail | `GET https://api.s2c.mercell.com/api/v1/PublishedTender/GetPublishedTenderDetails?tenderId=<id>` | ~40 velden incl. `EstimatedValue*`, `TypeOfContract`, `DisplayNumber`, `ContactPerson*` (PII — niet in fixtures). |
| Public page | `https://s2c.mercell.com/tender/<tenderId>` | SPA-route; wordt `bronUrl`. |

## Parameters (empirisch bevestigd)

- `StartIndex`/`EndIndex` = **1-gebaseerde inclusieve** rijgrenzen: `1..100`
  en `101..110` geven disjuncte windows van dezelfde 20 105-rijen tellende
  resultaatset. Page size 100 werkt (gedocumenteerd als frontend-default 10;
  100 getest, groter ongetest).
- `OrderColumn: "CreatedDate"`, `OrderAscending: false` — de default van de
  frontend; nieuwste records eerst.
- `SearchProperty: {PropertyName: "str_Today_status", PropertyValue: "1",
  PropertyDisplayName: "str_Today_opened"}` = de `/today`-view: alle
  **momenteel open** tenders (1 200 op 18-09, allemaal `Status: 1`). Dit is
  géén "vandaag gepubliceerd"-filter — publicatiedata liepen een week+ terug.
- `PropertyFilters` met `PropertyName: "ProcedureType"` wordt **stil
  genegeerd** (ResultsCount bleef 20 105 met gemengde ProcedureTypes). De
  werkelijke filternamen zijn niet geverifieerd — daarom filtert de connector
  de poll-window **client-side** op `CreatedDate` en markeert de run
  `truncated`, zodat de onbelopen staart nooit als "gemist" telt.
- `ResultsCount` op 18-09: **20 105** published tenders op de NL s2c-instantie
  (incl. enkele niet-NL kopers, bv. Jülicher Entsorgung).

## Enums (uit de portal-bundle `s2c.mercell.com/main.*.js` gereconstrueerd)

- `ProcedureType`: 2 OpenProcedure, 13 DirectNegotiation, **16
  MiniCompetitionWithinFA** (DAS/VAK-mini — het doelsegment), 17
  QualificationSystem, **18 DynamicPurchasingSystem**, 19 MarketResearch,
  **23–27 de *BelowThreshold*-procedures** (OpenTender / Restricted /
  NegotiatedAward, met/zonder contractnotice). Volledige tabel in
  `types.ts` (`MERCELL_PROCEDURE_TYPE_NAMES`).
- `TypeOfContract`: 1 Services, 2 Supplies, 3 Works.
- `PublishedTenderParticipationStatus` (listing `Status` + detail
  `PublishedTenderParticipationStatus`): 1 Open, 2 Closed.
- `PublishedTenderStatus`: 1 Published, 2 Unpublished.
- `ExplicitTenderStatus`: 3 Canceled / 7 Removed = sluitsignalen.
- `EstimatedValueType`: 1 Value, 2 Range. `CurrencyType`: 1 EUR, 2 USD, …
  (ISO-tabel; subset in `MERCELL_CURRENCY_NAMES`).

## Veldmapping → canoniek `aanvraag`

| Mercell | Canoniek | Noot |
|---|---|---|
| `TenderId` (listing+detail) | `bron_referentie` | numeriek → string; `DisplayNumber` ("T228236") in `bron_specifiek` |
| `TenderName` | `titel` | |
| `TenderDescription` (HTML) | `beschrijving` | `stripHtml`; bevat `&nbsp;`/`<br/>` |
| `OrganizationName` | `opdrachtgever_naam` | |
| `Deadline` (listing, `…Z`) | `sluitingsdatum` | **alleen in listing** — ontbreekt in detail; expliciete `Z` = echte UTC-instant; ontbreekt op sommige wijzigings-publicaties |
| `Status` / `PublishedTenderParticipationStatus` | lifecycle | 1 open → `seenOpen`; 2 closed → `bronSaysClosed`; `ExplicitTenderStatus` 3/7 ook `bronSaysClosed` |
| `ProcedureType`, `TypeOfContract`, `EstimatedValue*`, `SpecialNumber`, `TenderGuid`, `PublicationAuthorities[].Mnemonic`, `PublicationDate` | `bron_specifiek.*` | procedure/type namen via de bundle-enums |
| `ContactPerson{DisplayName,Email,Phone}` | `contactpersonen` (via `toDraftContactpersonen`, `publicatiedoel: aanbieder`) | PII — gestript uit fixtures |
| `tender/<TenderId>` | `bron_url` | |
| — | `locatie_land`, `locatie_tekst`, `start_datum` | **afwezig bij de bron** — geen land/NUTS/plaats-veld, geen contractstart → `UNKNOWN`, nooit raden |
| `EstimatedValue*` + `CurrencyType` | `bron_specifiek` (niet `tarief`) | totale geraamde opdrachtwaarde ≠ uur/maand-tarief → `tarief` UNKNOWN |

## DEC-008 whitelist

Live listing-rij = 25 keys, detail ~40 keys. `projectMercellListingItem` /
`projectMercellDetail` bouwen verse objecten met alleen de gemodelleerde
velden: `EntityMnemonic*`, `Version`, `CreatedById`/`ModifiedById`,
`OrganizationImageUrl` (blob), `ContactPersonIanaTimeZone`,
`RequirementBoxes`, `TenderPublicationDetails`, `PublicAwardStatements`,
`LinkedTenders`, `TenderDescriptionDocuments` bereiken `listingPayload` noch
de opgeslagen body nooit. `PublicationAuthorities[]` klapt in naar z'n
mnemonic-lijst.

## Poll-patroon

- `poll`-runs: `publishedSince = now − 1 dag`; listing is `CreatedDate`
  desc dus de eerste oudere rij sluit het window → `hasMore: false` +
  `truncated: true` (onbelopen staart telt nooit als gemist).
- Full/test-runs: ongefilterd door alle pagina's (20 105 records op 18-09).
- Detail-call per item (`listingHashCoversDetail: false` — EstimatedValue,
  contactpersoon en ExplicitTenderStatus zitten niet in de listing-hash).
- Beleefdheid: `crawlDelayMs: 1000`; geen auth, geen `Retry-After`/
  rate-limit-headers waargenomen.

## Fixtures

`fixtures/connectors/mercell/` — echte opnames via
`tools/fixtures/record.ts` (18-09-2026): `listing-page-0.json` (POST
StartIndex 1, EndIndex 5 — `ResultsCount` 20 105) + `detail-<tenderId>.json`
voor elk van de 5 rijen. `ContactPerson{DisplayName,Email,Phone}` per
`--strip-key` verwijderd (PII); `capturedAt` = echte file-mtime.

## Risico's / bekende gaten

1. `robots.txt Disallow: /` — technisch open, beleidsmatig bewust besloten
   (POC-waiver, CTP-570).
2. Server-side filtering op `ProcedureType`/land is ongeverifieerd — het
   DAS-mini-segment (`ProcedureType` 16/18/23–27) filtert downstream op
   `bron_specifiek.procedure_type`, niet in de query.
3. Geen locatievelden → provincie/land altijd UNKNOWN.
4. Detail zonder `Deadline` → sluitingsdatum is afhankelijk van de listing;
   een item dat alleen via detail gezien wordt heeft geen sluitingsmoment.

## Voorwaarden

- robots.txt: api.s2c.mercell.com: HTTP 404, geen robots.txt, geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie intro hierboven — eigenaar heeft ToS expliciet gewaived (CTP-570)
- Besluit: `te_toetsen`
- Besluitnemer en datum: open: CTP-570 (robots Disallow: / hele site; beleidsbesluit Robbie)
