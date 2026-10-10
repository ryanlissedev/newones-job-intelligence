# Werk.nl (UWV vacaturebank)

- **Slug**: `werk-nl` · **bronId**: `00000000-0000-4000-8000-000000000041`
- **Naam**: Werk.nl · **liveEnv**: `WERK_NL_LIVE` · **methode**: `json-api`
- **voorwaardenStatus**: `te_toetsen` — zie "Juridisch" onderaan.
- **Issue**: CTP-587 (was GATE-0 op curl-probe; browser-PoC 2026-09-18 bewees
  technische bereikbaarheid — zie `inventory/browser-poc-wave.md`).

## Route — publieke `zoekenvacatures` JSON-API

De publieke SPA op `https://www.werk.nl/nl/vacatures/` praat met een JSON-API
onder `/werkzoekenden/mijn-werkmap/kia/publiek/zoekenvacatures/api/`. Alles
hieronder is 2026-09-18 live geverifieerd via HAR-capture + curl-replay.

| Stap | Request | Opmerking |
|---|---|---|
| Sessie-bootstrap | `GET .../api/configuration` | OAM anonymous-auth: 302 → `login.werk.nl/oam/server/obrareq.cgi` → `obrar.cgi` → terug. Volgt automatisch redirects en zet `OAMAuthnCookie`, `OAM_ID`, `.AspNetCore.Antiforgery.*`, `XSRF-TOKEN` cookies. Werkt met plain `fetch` — geen browser nodig. |
| Listing | `POST .../api/search` | Body: `{currentPage, facets:[{propertyCode:"JOB_SHIFT_TYPE",value,description}],keywords:"",location:"",sort:{by:1,direction:1},...}`. Headers: `Cookie` + `X-XSRF-TOKEN` (= XSRF-TOKEN cookie value). 20 items/pagina. |
| Detail | `GET .../api/vacature/<referenceNumber>` | Volledige vacature-JSON: titel, beschrijving, proposition (salaris, uren, contract, werklocatie), contactPerson, employer(+adres), cvOffer, applicationMethods, expirationDate. |

Minimale header-set geverifieerd: zonder cookies → 302 OAM; zonder
`X-XSRF-TOKEN` → 400; `RequestVerificationToken`-header is **niet** nodig.

## Paginatie en sharding (de 200k-cap)

- `currentPage` is 1-based; page size is upstream vast op 20
  (`api/configuration.search.maximumItemsPerPage`).
- `api/configuration.search.maxSearchCount` = 199.999. Live gemeten: pagina
  10.000 levert items 199.981–199.999, pagina 10.001 levert
  `{items: null, totalResults: 0}` — een harde resultaatcap, geen error.
- De ongefilterde catalogus telde ~240k vacatures (2026-09-18), dus >40k
  records zijn onbereikbaar zonder sharding.
- De connector shardt daarom op `JOB_SHIFT_TYPE` ∈ {1 (Kantoortijden),
  2 (Anders)} — live facetcounts 149.269 + 91.161 ≈ totalResults, beide
  ruim onder de cap. Groeit een shard ooit boven 199.999, dan moet hij op
  een tweede facet (`JOB_EDUCATION`, `JOB_CATEGORY`) gesplitst worden; de
  cursor (`werk-nl:{"s":<shardIdx>,"p":<page>,"t":<truncated>}`) maakt dat
  uitbreidbaar zonder contractwijziging.
- `pageLimitPerShard` (connector-optie) begrenst test/smoke-runs; een
  afgekapte run rapporteert `truncated` zodat ongeziene records niet als
  "missed" tellen.

## listingHashCoversDetail = false

Het listing-item bevat alleen titel, organisatie, uren, contract- en
werklocatie-labels, studyLevel en `modified`. De detail-response draagt
beschrijving, salaris, expirationDate (sluitingsdatum), contactPerson,
proposition en employer — geen van die velden is voor de listing-hash
zichtbaar. `knownHashes` wordt daarom niet doorgespeeld; elke run haalt de
detail op (zelfde redenering als tenderned, RJC-357/RJC-401).

## Veldafdekking (detail → draft)

| Draft | Bronpad |
|---|---|
| titel | `detail.title` (fallback `listing.vacatureTitle`) |
| beschrijving | `detail.description` → `proposition.function.description` (stripHtml) |
| bronReferentie | `detail.referenceNumber` |
| bronUrl | `https://www.werk.nl/nl/vacatures/<referenceNumber>` |
| opdrachtgeverNaam | `employer.organizationName` → `listing.organisation` |
| locatieTekst | `workLocation.city` → `listing.workLocationCity` → `workLocationForeignCity` → postcode → `workLocationType`-label ("Wisselende werklocatie" is eigen brontekst) |
| locatieLand | `workLocation.countryCode` → `workLocationForeignCountry` → `"NL"` bij aanwezige NL-postcode (expliciete brondata); anders UNKNOWN |
| startDatum | `proposition.contract.startDate` (date-prefix) |
| sluitingsdatum | `expirationDate` via `closingMomentInstant` (naive → Europe/Amsterdam) |
| tarief | `salary.amountIndication` ("2500-3000") → min/max; `maand` alleen bij `salary.type` 4 ("beloning conform CAO") of afwezige code — type 1 ("vast loon / uurloon") kan een uurrange zijn → `UNKNOWN` |
| contactpersonen | `contactPerson` (naam/email/telefoon/department→rol); CTP-610-beleid `sollicitant`, default extractie aan |
| lifecycle | `expirationDate` verstreken → closed |

`werkLocation.type`/`contract.type`/`salary.type`/`werktijden` zijn numerieke
codes; de overeenkomstige `/api/codelijsten/*`-lijsten gebruiken string-ids in
dezelfde volgorde (contract.type 2 = "Mogelijk vast" ✓ live geverifieerd
tegen listing-labels; `salary.type` telt posititioneel in de live-lijst
`/api/codelijsten/beloningsvorm`: 1 = "vast-loon-uurloon", 4 =
"beloning-conform-cao"). De codes blijven ook rauw in bronSpecifiek —
`salary.type` stuurt alleen de tarief-eenheid, geen index→label-tekst.

`bronSpecifiek.werkvorm` neemt het eigen `workLocationType`-label van het
listing-item verbatim over ("Vaste werklocatie"/"Wisselende werklocatie");
de numerieke `proposition.workLocation.type` blijft rauw in
`werklocatie_type_code` (geen geverifieerde codelijst-mapping).

## DEC-008

`projectWerkNlVacature`/`projectWerkNlSearchItem` whitelisten elk veld dat de
payload bereikt; upstream-only velden (score, resultDepth,
internalReferenceNumber, distance, externalReferenceId,
employerInternalVacatureId, referenceNumbers op contact/employer,
cvOffer.sources/languageSkills/workExperiences/educations, addressForeign)
bereiken de opgeslagen body nooit.

## Fixtures

- `fixtures/connectors/werk-nl/listing-page-0.json` — echte POST /api/search
  page-1 (capturedAt = werkelijke file-mtime van de capture); items
  mechanisch getrimd 20→2, facets gedropt (multi-MB lijst), `totalResults`
  is de live-telling.
- `fixtures/connectors/werk-nl/detail-56790376.json` — echte GET
  /api/vacature/56790376; `contactPerson` naam/telefoon/email verwijderd
  (PII), employer-adres behouden (gepubliceerde bedrijfszetel).

## Juridisch

UWV AGV art. 13 verbiedt geautomatiseerd verzamelen expliciet; art. 9
verbiedt hergebruik zonder schriftelijke toestemming. De technische route is
bewezen; **productie-GO is een aparte juridische beslissing** — daarom
`te_toetsen` en geen `toegestaan`. Zie `inventory/boards-route-wave2.md`
(art. 9/13 citaten) en `inventory/browser-poc-wave.md` (technisch bewijs).

## Voorwaarden

- robots.txt: www.werk.nl: HTTP 200, geen Disallow op connectorpaden (/werkzoekenden/mijn-werkmap/kia/publiek/zoekenvacatures/, /nl/vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Juridisch" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Operatie

Een volledige sweep = ~240k details + ~12k listingpagina's. `crawlDelayMs`
staat op 1000 ms om die reden; frequentie en windowing (bv.
modified-gesorteerde incrementele polls) zijn een bewuste uitgestelde keuze.
