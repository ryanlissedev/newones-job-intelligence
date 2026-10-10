# Wave · Contactpersoon-verwerking (CTP-610)

Status: **geïmplementeerd 2026-09-18** (alle gates groen; PR volgt). Business-behoefte: bij plaatsing
van kandidaten is de contactpersoon op een vacature commercieel waardevol
(aanspreekpunt voor het aanbod). Vandaag landt die data nergens: connectors
whitelisten hem weg (DEC-008) en het domeinmodel kent geen veld.

Deze wave maakt van contactpersoon-verwerking een expliciete, per bron getoetste
feature in plaats van een neveneffect van een parser.

## Beslissingen (eigenaar, 2026-09-18)

1. **Opslag: jsonb nu.** `contactpersonen` als jsonb-lijst op
   `curated.aanvraag`. Geen eigen entiteit tot dedup van personen over
   vacatures dat vereist.
2. **Export: ja, gaat mee.** Contactdata gaat mee in klant-exports (Spott).
3. **Art. 14-mechanisme: eigen implementatie.** Een in-repo, configureerbaar
   mechanisme dat we zelf aanpassen — geen externe tool, geen harde juridische
   blokkade vóór fase 2.
4. **Scope: alle vacatures.** Werkenbij-contactpersonen zijn in scope; er is
   geen twee-fasen-scheiding tussen aanbestedingsplatformen en werkenbij.
   Dubbele vacatures worden niet gefilterd maar **als dubbeling aangegeven in
   de UI** (oppervlak van de bestaande `dedupGroepId`).

## Uitgangspunten die niet veranderen

- **Fixtures blijven PII-vrij.** Redactie in git is absoluut: fixtures zijn
  testdata, permanent en gedistribueerd. Ook als de pipeline contactvelden gaat
  verwerken, horen echte namen/mails/telefoons niet in de repository.
- **DEC-008 whitelisting blijft.** Contactvelden worden per bron *expliciet*
  toegevoegd aan de payload-whitelist, nooit impliciet meegenomen.
- **Afwezig blijft afwezig.** Een bron zonder contactveld levert UNKNOWN/null,
  nooit een gegokte waarde.
- **`voorwaardenStatus` wordt gedocumenteerd, niet als harde poort.** Per
  beslissing 3 is er geen externe juridische blokkade vóór extractie; de toets
  staat vastgelegd per bron en het art. 14-mechanisme is per bron
  configureerbaar.

## Juridische analyse (kort)

- Zakelijke contactdata (naam, e-mail, telefoon van een recruiter of
  aanbestedingscontact) is persoonsdata onder de AVG.
- Verwerking vereist een grondslag; gerechtvaardigd belang is de kandidaat,
  maar vraagt een vastgelegde belangenafweging per broncategorie.
- Art. 14 AVG (informatieplicht bij niet-rechtstreeks verkregen data) is bij
  bulk-inname praktisch lastig; de wave moet een werkbaar antwoord kiezen
  (verklaring op de site, eerste-contact-verklaring, of beperking tot bronnen
  waar de publicatie het doel zelf dekt).
- Retentie: een contactpersoon is geen vacature-eigenschap. Sluiting van de
  vacature beëindigt niet automatisch de grond voor bewaren, maar "voor altijd"
  is geen optie. Een bewaartermijn hoort bij het ontwerp.

## Belangrijk onderscheid: doel van de publicatie

| Categorie | Voorbeelden | Verdedigbaarheid |
|---|---|---|
| Aanbestedings-/inhuurplatformen | TenderNed, Opdrachtoverheid, CTM, Inhuurdesk | Contactpersoon staat er **voor aanbieders** (vragen, inschrijving). Ons gebruik als aanbieder sluit aan bij het publicatiedoel. Sterkste positie. |
| Werkenbij-sites | Alliander-API (`contactPerson*`), overige werkenbij | Contactpersoon staat er **voor sollicitanten**. Bulkgebruik voor matching is een ander doel; afweging nodig, mogelijk beperking tot functieniveau of algemene mailboxen. |
| Bronnen zonder veld | meeste JobPosting JSON-LD | Niets te halen; blijft leeg. |

## Fasering

### Fase 0 — Eigen art. 14- en retentiemechanisme

Beslissing 3: we implementeren dit zelf en houden het configureerbaar.

- Een `contactpersoon_beleid`-configuratie in de codebase: per bron vastgelegd
  of extractie aan staat, welk publicatiedoel geldt (aanbieder/sollicitant),
  en welke bewaartermijn geldt. Eén plek om aan te passen, geen
  hardgecodeerde uitzonderingen.
- Een notificatie-spoor op de opgeslagen contactpersoon: `geïnformeerdOp` /
  `notificatieKanaal`, zodat een eerste-contact-verklaring of
  site-verklaring later aantoonbaar is. Leeg is toegestaan; het veld maakt de
  status expliciet in plaats van impliciet.
- Retentie wordt een config-waarde per bron (default uit het beleid), geen
  juridische voorwaarde voor de build.

### Fase 1 — Inventaris: wie publiceert wat

Per bestaande connector vaststellen welke contactvelden de bron überhaupt
publiceert (API-velden, JSON-LD `contactPoint`, label-blokken, HTML-blokken).
Bekend uit eerdere opnames: Alliander-API heeft `contactPerson` +
`contactPersonEmailAddress`; CTM-feed heeft `contactPerson` +
authority-adresvelden (nu bewust weggefilterd in `toCtmEntry`). Leverbaar: een
tabel bron × veld × categorie, in dit document of een volg-inventaris.

### Fase 2 — Domeinmodel + opslag (beslissing 1)

- Nieuw veld `contactpersonen` (lijst, want 0..n per aanvraag) met items
  `{ naam, rol, email, telefoon, geïnformeerdOp, notificatieKanaal }` en
  provenance via het bestaande `field()`-mechanisme.
- Opslag: `jsonb`-kolom `contactpersonen` op `curated.aanvraag` (besloten;
  sluit aan op het `bronSpecifiek`-patroon). Geen eigen entiteit tot dedup
  van personen over vacatures dat vereist.
- Levenscyclus: bewaartermijn uit het beleid (fase 0); verwijderpad hoort bij
  dezelfde migratie niet bij een latere refactor.

### Fase 3 — Extractie per bron (beslissing 4: alle vacatures)

- Geen bron-scheiding: aanbestedingsplatformen én werkenbij in dezelfde wave.
- Per bron waar een contactveld gepubliceerd wordt: connector-whitelist
  uitbreiden met de benoemde velden, normalise naar het canonieke item,
  parserVersion-bump.
- Dubbele vacatures worden niet gefilterd; `dedupGroepId` groepeert ze en de
  UI toont de dubbeling (fase 4).
- Fixture-strategie: echte opnames met contactvelden geredacteerd **naar
  placeholders** (structuur behouden, waarde weg) zodat de parser-test de
  veldpaden nog dekt. Dit is de enige uitzondering op "verwijderen", en alleen
  voor velden waarvan de extractie zelf getest moet worden — de guard blijft
  echte waarden afkeuren.

### Fase 4 — Curatie, UI en export (beslissingen 2 en 4)

- Weergave van contactpersonen in curatie/aanvraag-detail.
- **Dubbelingen in de UI**: aanvragen in dezelfde `dedupGroep` krijgen een
  zichtbare indicator (badge/groepering) in plaats van filtering.
- **Export: contactdata gaat mee** in klant-exports (Spott-payload), als
  expliciet veld zodat downstream het kan tonen of filteren.
- Zoekbaarheid: bewust níet in Manticore-fulltext stoppen zonder aparte toets.

## Extractiedekking (stand 2026-09-18, wave 2)

Per bron waar de contactvelden vandaan komen. Alle paden lopen via de
gedeelde helper `toDraftContactpersonen`
(`packages/application/src/normalise/contactpersonen.ts`), die het
`contactpersoon_beleid` toepast, naar `Contactpersoon` mapt en dedupt op
(naam, email). Parser-versies zijn gebumpt waar extractie veranderde.

| Bron | Veld(en) | Pad |
|---|---|---|
| json-ld-familie (generiek) | `hiringOrganization.contactPoint`, `jobPosting.applicationContact`, `hiringOrganization.email`/`telephone`, `payload.contactpersonen` | `resolveContactpersonen` in `normalise/json-ld.ts` — dekt DataJobs, Haert, TBI, Intermediair e.a. |
| Alliander | `contactPerson` + `contactPersonEmailAddress` (API) | synthesizer → `payload.contactpersonen` |
| ASML | `hiringManager` (`__NEXT_DATA__`) | synthesizer → `payload.contactpersonen` |
| Techniekwerkt | `contact_name`, `apply_email`, `contact_phone_number` (Vike state) | synthesizer → `payload.contactpersonen` |
| ProRail | recruiter-card + inline manager (`mailto:`) | `synthesizeContactsFromProrailPage` |
| VolkerWessels | recruiter-regel (`mailto:` / telefoon-varianten) | `synthesizeContactsFromVolkerwesselsPage` |
| Hays | `gtm_jobowner_name` + `jd_telephone` | `synthesizeContactsFromHaysPage` (hays/v2) |
| Randstad | `contactitem__container` (tel:/mailto: kanaal, geen naam) | `synthesizeContactsFromRandstadPage` (randstad/v2) |
| Rijkswaterstaat | `contact-person`-blokken (naam, functie in haakjes, tel + mailto) | `synthesizeContactsFromRijkswaterstaatPage` (rijkswaterstaat/v2) |
| CTM | `<contactPerson>` Atom-attributen (incl. `@_munber`-typo) | `toCtmEntry` → `normalise/ctm.ts` (ctm/v2) |
| Striive | `recruiter*` + `orderContact*` + `requesterEmail` (ruwe API-velden, gefold in projectie) | `projectStriiveContacts` → `normalise/striive.ts` (striive/v3) |
| Inhuurdesk | `recruiter`-object + `recruiterEmail/PhoneNumber` + `requesterEmail` | `projectInhuurdeskContacts` → `normalise/inhuurdesk.ts` (inhuurdesk/v4) |
| Needstaffing | `.vacancy-contact-info`-blok | `extractNeedstaffingContactpersonen` → `normalise/needstaffing.ts` (needstaffing/v5) |
| werk.nl | `contactPerson` (publieke detail-API) | WIP-connector in deze wave (`normalise/werk-nl.ts`) |

### Geverifieerd géén contactveld (eerlijke "absent")

- **Opdrachtoverheid**: `__NUXT_DATA__.pinia.teamStore` is `undefined` op alle
  drie committed fixtures; `tender_team` is organisatiebeschrijving-HTML, geen
  personenlijst; `$snewUserData` is de (lege) login-state van de bezoeker.
  Niets te halen — blijft leeg tot de bron een veld publiceert.
- **Essent**: geen contactvelden in de Vue `DataItems`-payload of meta.
- **TenneT**: Avature SSR publiceert geen contactblok.

Beleid: `striive` en `needstaffing` toegevoegd aan de
`aanbieder`-publicatiedoel-overrides (hun contactblokken staan er voor
aanbieders/leveranciers); werkenbij-bronnen vallen onder de
`sollicitant`-default.
