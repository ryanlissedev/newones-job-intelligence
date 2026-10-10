# Vattenfall — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://careers.vattenfall.com/vacanciessitemap.xml` | XML-urlset; de fixture bevat 310 URLs, waarvan 20 Nederlandse vacature-URLs. |
| Detail | `https://careers.vattenfall.com/global/job/<slug>-in-<plaats>-jid-<nummer>` | Detailpagina met JobPosting JSON-LD. |

Alleen URLs met de exacte Nederlandse vorm en plaats `amsterdam`, `arnhem`, `diemen`, `ijmuiden` of `slootdorp` worden ontdekt. Andere sitemap-entries worden uitgesloten.

## Veldmapping

| JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Detailpagina. |
| `description` | `beschrijving` | Detailpagina. |
| URL-pad | `bronReferentie` | URL-gebaseerd. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Letterlijk overgenomen. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `Vattenfall`. |
| `jobLocation.address.addressLocality` | `locatieTekst` | `locatieLand` is gedeeld `NL`. `addressCountry` ontbreekt in de samples. |
| `baseSalary` | `tarief` | Niet gepubliceerd in de drie samples; de vrije beschrijvingsprose van de Amsterdam-sample zegt letterlijk "ranges from €4862 and €6077 gross per month", maar de gedeelde `parseTariefFromText`-fallback leest daar een tarief van `4862` per **uur** uit (verkeerde eenheid, verkeerde bovengrens) — een false positive van dezelfde soort als CTP-605 (BlueTrail). Gedeelde normaliser-code, buiten deze Path-A-recipe; letterlijk vastgelegd in de fixture en de testassertion, niet hier gefixt. |
| `validThrough` | `sluitingsdatum` | Gedeeld genormaliseerd als closing instant. |
| `employmentType` | `bronSpecifiek.contract_type` | Array (`["Full-time"]`); de gedeelde normaliser leest alleen strings, dus UNKNOWN. |

## Crawl en datakwaliteit

`crawlDelayMs` is 2000 en `voorwaardenStatus` blijft `te_toetsen`. De sitemap bevat uitsluitend URL/lastmod-metadata; JobPosting-velden staan op de detailpagina. Daarom is `listingHashCoversDetail: false` en worden known hashes niet doorgestuurd.

Vattenfall zet `validThrough` in deze samples precies 100 jaar na `datePosted`. Dit is een bron-placeholder, geen betrouwbare sollicitatiedeadline; de connector neemt de gepubliceerde waarde zonder special-casing over.

## Durable JSON-LD-cohort (CTP-638, bewezen 2026-09-21)

Vattenfall is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd —
de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:**
`https://careers.vattenfall.com/vacanciessitemap.xml` → 200, ~64 KB urlset met
detaillinks.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3b.spec.ts`,
6 specs per bron): discovery is één enkele sitemap-pass — `discover()` geeft het
hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is
géén pagina-cursor: een duurzame herval op hetzelfde `scrapeRunId` leest de
sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel
(`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items
— exact-één, geen verlies. Een head-insert wordt al door de herval zelf gezien;
een delisting valt uit de enumeratie en telt via `complete: true` meteen mee in
de missed-poll-reconcile. **Resterende kloof (eerlijk):** alleen een kill tussen
de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint
achter; die herval rapporteert `resumed` en slaat de reconcile voor die run over
— een in dat venster verdwenen record wacht op de volgende verse poll.
Zelfherstellend, nooit stil verouderd.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
sitemap-opname (310 `<loc>`-entries; 20 Nederlandse vacature-URL's na
uitsluiting op plaats), waarvan er 3 een detail-fixture hebben
(`analytics-engineer-...-jid-50838`, `monteur-stadswarmte-...-jid-51914`,
`service-technician-onshore-wind-turbines-...-jid-48727`). De integratiespec
scope de écht geparse listing daarom op de detail-backed URL's; elke
gepersisteerde payload is een echte opname. Er is géén opgenomen
soft-404/reject-fixture voor deze bron — alle drie de detail-URL's persisteren.
Heel-corpus-enumeratie is los vastgelegd in de connector-spec.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/json-ld-cohort-l3b.integration.spec.ts` — 5 specs per
bron, groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → alles `unchanged`, geen duplicaten of extra versies; gewijzigd
detail-payload → `changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte
curated rij; gefaalde listing-read → run `failed` (`DISCOVER_FAILED`, gezien aan
het begin van de retake) → herval via `reopenFailed` (fence +1) → volledige
her-enumeratie; abort mid-item → `failed` (`RAW_STORE_WRITE_FAILED` —
persistence-abort is nooit benign, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp638_visual_l3b` (door deze
lane aangemaakt én gedropt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API :3000 + web :3001 zonder
`NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet `Vattenfall 3`;
`?source=vattenfall` rendert de 3 rijen. Captures: `/tmp/ctp638-visual/` (H.264
MP4 + PNG, geopend en in frame bevestigd). Archief-toggle niet van toepassing —
alle seeds zijn actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt voor de
inline poll). `VATTENFALL_LIVE` blijft uit — dit bewijs is fixture-only.
Operator-canary en release-gate blijven open.

## Voorwaarden

- robots.txt: careers.vattenfall.com: HTTP 200, geen Disallow op connectorpaden (/, /global/job/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
