# ADR-0016 — Candidate Intelligence-modulecontract en toetsbare CI0-startgate

- Status: Proposed; ieder startgate-item staat op `pending-owner-acceptance`
- Datum: 2026-09-19
- Eigenaar: Luna — enige accountable uitvoerder van het CTP-636-readinesspakket
- Approver: per startgate-item de in §7 benoemde approver(s) — product, privacy/legal, integration, platform of data owner; de auteur van dit readinesspakket is geen approver
- Issues: CTP-636 (parent CTP-345 / CI0)
- Zie ook: [ADR-0015](ADR-0015-platform-integration-contracts.md), [ADR-0014](ADR-0014-effectts-project-wide-adoption.md), [platform-integratie-inventaris](../platform-integration-inventory.md), [BUILD_BRIEF](../BUILD_BRIEF.md), [EffectTS-migratiekaart](../effectts/migration-map.md)

## Context

Job Intelligence (JI) komt eerst; Candidate Intelligence (CI) mag daarna pas
starten met expliciete datarechten en een eigen begrensde domeinmodule.
CTP-345 legt de productgate vast: geen build-issues voordat een
provider/use-case register, DPIA/grondslag, provenance en TTL per assertion,
correctie/bezwaar, betekenisvolle menselijke review en fairness-evaluaties
zijn geaccepteerd. Auto-reject, verborgen top-N als beslissing, automatische
kandidaatstatuswrites en matching/screening als P0 zijn verboden.

ADR-0015 §0 besliste dat JI en CI zelfstandig toegankelijke apps/modules zijn
met elk een eigen capabilitygrens, write-owner, provenance en readinessgate.
Dit ADR maakt die grens voor CI toetsbaar: het legt het voorgestelde
modulecontract en een startgate-checklist vast die de per item benoemde
approver(s) — product, privacy/legal, integration, platform of data owner —
kan accepteren of verwerpen.

Dit ADR implementeert geen code, schema, database, providerintegratie,
tenantmodel of verwerking van kandidaatdata. Het synthetische
contractvoorbeeld in §5 is een herbruikbaarheidstest van het contractpatroon,
geen autorisatie om echte kandidaatdata te lezen. Iedere privacy-, grondslag-,
retentie- en productvraag hieronder is **ontworpen voor de bevoegde eigenaar**
en blijft `pending-owner-acceptance` totdat die eigenaar accepteert of
verwerpt.

## Besluit

### 1. Modulegrens en write-eigenaarschap

CI is een afzonderlijke module volgens het rollenmodel uit ADR-0015 §1. De
voorgestelde plaatsing is een eigen begrensde modulenaamruimte onder de
repository-brede `@ji`-scope (bijvoorbeeld `packages/candidate/**` met
`@ji/candidate-*`-packagenamen); de concrete packagenamen beslist de
eerste geaccepteerde CI-slice. CI deelt het
versioned envelope-, scope- en actorcontract uit ADR-0015 §2–§3, maar met
eigen schemas, provenance en privacybesluiten.

| Rol | Eigenaar | Mag schrijven | Mag niet schrijven |
| --- | --- | --- | --- |
| CI-domein | Toekomstige `@ji/candidate-*`-packages (domain + use-cases) | Alleen eigen canonieke records via de use-case die de betrokken CI-invariant bewaakt: `kandidaat`, kandidaatassertions, correctie-/bezwaarstatus en eigen receipts | JI-canonieke tabellen (`aanvraag`, `bron`, snapshots, approvals, `dedup_groep`, exportreceipts), providerobjecten, een generieke schrijf-API of records van een andere module |
| Platform-control-plane | Gedeeld patroon uit ADR-0015; server-vertrouwde actor/scope, policy/approval-referenties, audit | Alleen control-plane-records en alleen na de betreffende policy/authorisatiecheck | Domeinrecords van CI of JI, providerpayloads of een universele SQL-write API |
| CI-adapters | Toekomstige provideradapters onder een benoemde provider-owner | Alleen eigen checkpoint/inbox/receipt of de door een use-case gevraagde action | Canonieke CI- of JI-toestand omzeilen; authorisatie uit transportinput afleiden |
| CI-readmodels | Afgeleide projecties | Hun afgeleide index, cache, checkpoint en inbox-dedupe | Bron van waarheid, approval of een extern commitbesluit |

De grens is wederzijds: JI mag evenmin in CI-canonieke tabellen schrijven.
Een module verkrijgt data van de andere uitsluitend via een versioned
read-contract of een specifieke application port; de writer van de bron van
waarheid blijft de enige mutatievalidator. De bestaande webgrens blijft
gelden: de browser gaat via server/API en importeert geen databasepackage.

### 2. Provider/use-case register en Spott professional-eigenaarschap

Het register hieronder is het voorgestelde uitgangspunt. Geen enkele rij
autoriseert verwerking; activering vereist de geaccepteerde startgate uit §7
plus de per-provider rechten uit de integratie-inventaris.

| Use-case | Richting | Provider(s) | Contractstatus | Gate |
| --- | --- | --- | --- | --- |
| Read-only kandidaatbewijskaart | Spott → CI read | Spott `professional` | Synthetisch contractvoorbeeld in §5; geen live read geautoriseerd | CI0-startgate plus Spott-read scope en tenantrechten |
| Kandidaatverrijking | Provider → CI read | Clay, LinkedIn, Metaview (kandidaten) | Per-provider contractdiscovery; geen bruikbaar contract bevestigd | Eigen providergate ná CI0; geen claim dat de JI-migratie deze levert |
| Kandidaatwrite naar ATS/CRM | CI → Spott | Spott | Niet voorgesteld; geen P0 | Expliciet uitgesloten; vereist een nieuwe approval-bound action met eigen gate |

**Spott professional-eigenaarschap.** Voorgestelde bevestiging: de bestaande
regel uit de integratie-inventaris blijft gelden — Spott is de bron van
waarheid voor `professional` en CI bewaart alleen minimale assertions met
provenance en TTL, nooit een tweede canoniek professional-profiel. De
bevoegde eigenaar kan deze regel bevestigen of een expliciet nieuw besluit
vastleggen; een stille eigenaarsoverdracht is geen optie.
`pending-owner-acceptance`.

### 3. Scope, identiteit en crosswalk

CI hergebruikt de scoped-identity- en crosswalkstructuren uit ADR-0015 §2 met
`"system": "ci"`. De canonieke persoonsidentiteit blijft de Spott
`professional` met zijn `professional_id` zoals de integratie-inventaris
vastlegt; CI mint geen tweede canoniek persoons-ID. De voorgestelde
CI-entiteit `kandidaat` is een CI-scoped projectie van die professional,
met een `kandidaat_id` dat alleen uniek is binnen CI en de
server-afgeleide scope en één-op-één via crosswalk aan de canonieke
professional is gebonden. Een externe koppeling is een versioned crosswalk
naar bijvoorbeeld `spott:professional:<provider-id>` met `accountRef`,
`status` (`active|revoked|superseded|invalid`), `firstObservedAt`,
`lastVerifiedAt` en provenance — dezelfde veldset en mutatieregels als
ADR-0015 §2.

Een kandidaat is een natuurlijke persoon. Daarom gelden aangescherpte regels
bovenop het generieke model:

- een `kandidaat` verwijst nooit zelf een JI-`aanvraag` aan, herschrijft geen
  `bronId` en creëert geen JI-domeinrecord; een relatie naar een `aanvraag`
  is hoogstens een referentie, geen identiteit;
- correctie- en verwijderingsmutaties op kandidaatidentiteit of -crosswalk
  zijn geautoriseerde, geaudite mutaties van de bevoegde eigenaar; een
  `revoked` crosswalk blijft als historie leesbaar binnen het
  retentiebeleid;
- `scope` wordt door de server afgeleid en komt niet uit een request body,
  header, MCP-parameter of agentprompt.

### 4. Privacy- en verwerkingscontract (ontwerp, `pending-owner-acceptance`)

Alle onderdelen in deze paragraaf zijn ontworpen zodat de bevoegde
product/privacy/legal owner ze kan accepteren of verwerpen. Niets hieronder
is een juridisch oordeel of een geaccepteerde termijn.

**DPIA en grondslag.** Voorgesteld: kandidaatassertions zijn
persoonsgegevens; een DPIA per geactiveerde flow is vereist vóór verwerking.
Voorgestelde grondslag voor de read-only bewijskaart is gerechtvaardigd
belang binnen de eigen recruitmentcontext, met toestemming als route wanneer
de DPIA dat vereist. De privacy/legal owner accepteert grondslag en
DPIA-uitkomst per flow. `pending-owner-acceptance`.

**Minimale velden.** Voorgestelde veldenset voor de bewijskaart: de scoped
`kandidaat`-referentie, een weergavelabel, profielkop/functieaanduiding,
vaardigheids- en beschikbaarheidsassertions zoals bij Spott vastgelegd,
`lastVerifiedAt` per assertion en provenance-referenties. Voorgesteld
uitgesloten: contactgegevens (e-mail, telefoon, adres), geboortedatum,
bijzondere persoonsgegevens, CV-documenten en vrije tekst, en alle
evaluatie-, ranking- of statusvelden. `pending-owner-acceptance`.

**Provenance en TTL.** Voorgesteld: iedere assertion draagt `sourceSystem`,
`sourceRecordRef` (inclusief de `accountRef` van de geconfigureerde
provider-account, zodat de bronregel binnen een multi-account deployment
eenduidig identificeerbaar is), `capturedAt`, `schemaVersion`, een
`grondslagRef` naar de geaccepteerde grondslag en een TTL. Voorgestelde
default: een assertion vervalt uit de read-DTO negentig dagen na
`lastVerifiedAt` en wordt daarna niet als feit getoond; verlenging vereist
nieuwe verificatie bij de bron. Verval is niet alleen een
weergavebeslissing: een vervallen assertion wordt binnen de geaccepteerde
retentietermijn getombstoned en daarna uit opslag verwijderd, met een
expiry-receipt dat de dispositie auditable maakt. Exacte termijnen,
vervalgedrag en dispositie per veld zijn `pending-owner-acceptance`.

**Correctie, bezwaar en verwijdering.** Voorgestelde routes:

- correctie: een gewijzigde bronwaarde produceert een nieuwe verified
  assertion die de oude `superseded` maakt; geen stille edit van bestaande
  assertions;
- bezwaar: een bezwaar van de kandidaat markeert de assertions `objected` en
  blokkeert verdere verwerking en toning tot een mens de bezwaarstatus
  heeft beoordeeld. Die beoordeling is een geautoriseerde, geaudite
  transitie met een expliciete uitkomst — `objected` → `active` (bezwaar
  afgewezen) of `objected` → tombstone (bezwaar gehonoreerd) — vastgelegd
  in een bezwaar-receipt met reviewer-referentie, reden en
  besluit-timestamp; een `objected` assertion keert nooit stil terug;
- verwijdering: een gehonoreerd verwijderverzoek tombstoned de assertions,
  revoket de crosswalk en bewaart een deletion-receipt; canonieke
  verwijdering herschrijft geen historische receipts. De door verwijdering
  `revoked` crosswalk is tevens een duurzame suppressie: een latere
  providerread of import van dezelfde `sourceRecordRef`/`accountRef` maakt
  geen nieuwe kandidaat of assertions en legt een suppressie-receipt vast,
  zodat een verwijderde kandidaat niet stil wordt hercreëerd; herstel
  vereist een expliciete geautoriseerde mutatie van de bevoegde eigenaar.
  Waar de bron een verwijder- of rectificatiecall ondersteunt, volgt
  propagatie de geaccepteerde route.

Alle drie zijn geautoriseerde, geaudite mutaties. Routes, termijnen en de
eigenaar per route zijn `pending-owner-acceptance`.

**Menselijke review en fairness-evaluatiecriteria.** Voorgesteld: de
bewijskaart toont iedere assertion met provenance en verificatietijd zodat
een mens de bron kan inspecteren; er is geen geautomatiseerd besluit.
Voorgestelde fairness-criteria vóór elke toekomstige ranking of score: geen
beschermde persoonskenmerken in assertions of afgeleide velden, een
synthetische evaluatieset die differentiëlle dekking en fouten meet, en een
gedocumenteerde eval-uitkomst die de bevoegde owner accepteert. De criteria
en de datasetkeuze zijn `pending-owner-acceptance`.

### 5. Eerste verticale: read-only kandidaatbewijskaart

De eerste toekomstige CI-verticale is een **read-only kandidaatbewijskaart
met menselijke inspectie**. Een CI-gebruiker opent een kaart voor één
kandidaat; alle velden zijn read-only; iedere assertion toont provenance,
grondslagreferentie en verificatietijd; een mens beoordeelt. Uitdrukkelijk
buiten scope: automatische reject, verborgen ranking of top-N als beslissing,
automatische kandidaatstatuswrites, en elke write naar Spott, JI of een
andere module.

Synthetisch contractvoorbeeld — alleen een test van het ADR-0015
contractpatroon, geen autorisatie om echte data te lezen. Dit is een
**read-DTO** in de zin van ADR-0015 §3 (`read` → versioned DTO), geen
event- of commit-envelope; `eventId`, `actionId`, `correlationId`,
`causationId` en `delegation` horen bij events en actions en zijn hier
bewust afwezig. CI-events en -actions gebruiken het volledige
ADR-0015-envelope:

```json
{
  "schemaVersion": "1.0",
  "kind": "ci.kandidaat.bewijskaart.read.v1",
  "occurredAt": "RFC-3339",
  "scope": { "kind": "deployment", "id": "server-owned-value" },
  "actor": { "kind": "user", "id": "server-validated-subject" },
  "payload": {
    "subject": {
      "system": "ci",
      "entityType": "kandidaat",
      "id": "synthetische-uuid",
      "scope": { "kind": "deployment", "id": "server-owned-value" }
    },
    "assertions": [
      {
        "assertionId": "synthetische-uuid",
        "schemaVersion": "1.0",
        "field": "skills",
        "value": ["synthetisch-voorbeeld"],
        "provenance": {
          "sourceSystem": "spott",
          "sourceRecordRef": "spott:professional:<opaque-ref>",
          "accountRef": "configured-provider-account-reference",
          "capturedAt": "RFC-3339"
        },
        "grondslagRef": "immutable-reference-naar-geaccepteerde-grondslag",
        "lastVerifiedAt": "RFC-3339",
        "expiresAfter": "RFC-3339",
        "status": "active"
      }
    ]
  }
}
```

`field` is geen vrije string maar een gesloten enum over de geaccepteerde
minimale veldenset uit §4 (bijvoorbeeld `headline`, `skills`,
`availability`); de read-adapter projecteert iedere providerresponse op
die set, zodat onverwachte attributen zoals contactgegevens of vrije tekst
de DTO contractueel niet bereiken. De read-DTO bevat bovendien uitsluitend
display-eligible (`active`) assertions — `superseded`, `objected` en
getombstonede assertions verschijnen niet met hun `field`/`value`, zodat
betwiste of vervallen data de UI tijdens bezwaar of na verval niet bereikt.

**Verticale trace (bewijs).** Één synthetische assertion doorloopt het
contract:

1. **Identiteit:** `ci:kandidaat` met synthetische uuid binnen de
   server-afgeleide deployment-scope; de crosswalk naar
   `spott:professional:<opaque-ref>` staat op `active`.
2. **Provenance:** de assertion is vastgelegd met `sourceSystem`,
   `sourceRecordRef` en `capturedAt`; de providerpayload zelf blijft buiten
   de kaart.
3. **Consent/retentie:** `grondslagRef` wijst naar de geaccepteerde
   grondslag (zelf nog `pending-owner-acceptance`); na `expiresAfter`
   verdwijnt de assertion uit de read-DTO tot de bron opnieuw verifieert,
   en de vervallen assertion wordt getombstoned met expiry-receipt.
4. **Correctie:** een gewijzigde bronwaarde levert een nieuwe assertion; de
   oude wordt `superseded`. Bij bezwaar wordt de status `objected` en stopt
   verwerking en toning tot een menselijke beoordeling met bezwaar-receipt
   de uitkomst vastlegt; bij verwijdering volgt tombstone plus crosswalk-
   revoke met deletion-receipt en duurzame suppressie van herimport.

### 6. Tenantbesluit: single-tenant per deployment blijft

Voorgestelde bevestiging: de huidige lijn uit ADR-0015 §2 blijft — één
tenant per deployment, met een server-owned deployment-scope als enige
scopebron. Een CI-module introduceert geen impliciete multitenancy en geen
gedeelde module-database. Alleen een expliciet multi-tenant productbesluit
triggert een aparte membership-/account-isolatieslice met een eigen
authz-migratie; er is geen stille shared-database tenantmigratie en
historische ID's worden niet stilzwijgend herschreven.
`pending-owner-acceptance`.

### 7. CI0-startgate: toetsbare acceptatiepunten

Ieder item is zo geformuleerd dat de benoemde approver(s) — product,
privacy/legal, integration, platform of data owner, afhankelijk van het
item — het kan accepteren of verwerpen. De startgate is pas geaccepteerd
wanneer **alle** items expliciet geaccepteerd zijn; een ontbrekend
antwoord is geen aanname. Alle items starten op
`pending-owner-acceptance`. Iedere acceptatie of verwerping legt een
besluitref vast (beslisser, datum en link naar het besluit), zodat per
item controleerbaar is dat de vereiste approver heeft besloten.

| ID | Toetsbare voorwaarde (accept/reject) | Approver | Beslissing | Bewijs (besluitref, beslisser, datum) |
| --- | --- | --- | --- | --- |
| SG-1 | Het provider/use-case register uit §2 is geaccepteerd en per provider die door de te keuren verticale wordt geactiveerd — voor CI0 alleen Spott — zijn de datarechten, scopes en tenantomgeving bevestigd; verrijkingsproviders volgen hun eigen gate ná CI0 | product owner + integration owner | `pending-owner-acceptance` | — |
| SG-2 | Spott `professional`-eigenaarschap is bevestigd óf een expliciet nieuw eigenaarschapsbesluit is vastgelegd | product owner + privacy owner | `pending-owner-acceptance` | — |
| SG-3 | De modulegrenzen uit §1 en het scope/identity/crosswalkmodel uit §3 zijn geaccepteerd; geen partij schrijft in de canonieke tabellen van de andere module | product owner + platform owner | `pending-owner-acceptance` | — |
| SG-4 | Per voor activering voorgestelde flow — expliciet inclusief de eerste verticale — zijn DPIA en grondslag geaccepteerd | privacy/legal owner | `pending-owner-acceptance` | — |
| SG-5 | De minimale veldenset en de uitsluitingslijst per assertion zijn geaccepteerd | privacy owner + product owner | `pending-owner-acceptance` | — |
| SG-6 | Het provenance/TTL-beleid — termijnen, vervalgedrag, opslag-dispositie met expiry-receipt en herverificatie — is geaccepteerd | privacy owner + data owner | `pending-owner-acceptance` | — |
| SG-7 | De correctie-, bezwaar- en verwijderingsroutes — inclusief bezwaar-uitkomsten en duurzame verwijdersuppressie — zijn geaccepteerd en op synthetische data getoetst | privacy owner | `pending-owner-acceptance` | — |
| SG-8 | De menselijke-review-eis is geaccepteerd én er ligt een geaccepteerde fairness-evaluatieuitkomst voor de eerste verticale, óf een expliciet vastgelegd besluit dat de read-only bewijskaart daarvoor buiten scope valt met verplichte herbeoordeling vóór elke toekomstige ranking of score | product owner + privacy owner | `pending-owner-acceptance` | — |
| SG-9 | De eerste verticale is begrensd tot de read-only bewijskaart; auto-reject, verborgen ranking en statuswrites zijn expliciet bevestigd als verboden | product owner | `pending-owner-acceptance` | — |
| SG-10 | Het tenantbesluit uit §6 is bevestigd, of een expliciet multi-tenant productbesluit met eigen membership-/account-isolatieslice is vastgelegd; bij een multi-tenant besluit blijft kandidaatverwerking geblokkeerd tot die isolatieslice geïmplementeerd én geverifieerd is | product owner | `pending-owner-acceptance` | — |
| SG-11 | Er bestaan geen Candidate-buildissues en er vindt geen verwerking plaats vóór acceptatie van SG-1 t/m SG-10 en SG-13; synthetische contractvoorbeelden zijn toegestaan | product owner | `pending-owner-acceptance` | — |
| SG-12 | Het readinesspakket heeft één accountable author (Luna) en de approver van de startgate is bij naam of rol benoemd | product owner | `pending-owner-acceptance` | — |
| SG-13 | De duurzame inbound-grens van de eerste Spott-read is geaccepteerd: inbox/idempotentie, replay- en DLQ-gedrag en een benoemde retentie-eigenaar per ADR-0015 §4, zodat een hertelde of gecrashte providerread geen dubbele of stale assertions oplevert | platform owner + data owner | `pending-owner-acceptance` | — |

### 8. Providergrenzen

Microsoft 365, Please, Moneybird, Revolut, Clay, LinkedIn en Metaview blijven
per-provider contractdiscovery zoals de
[integratie-inventaris](../platform-integration-inventory.md) vastlegt. De
JI- en EffectTS-migratie implementeert geen van deze integraties en dit ADR
claimt dat evenmin. Voor CI geldt dezelfde regel: een kandidaat-gerelateerde
providerflow start pas na haar eigen contractdiscovery en de geaccepteerde
startgate.

## Gevolgen en open gates

- Er worden geen Candidate-buildissues aangemaakt en geen kandidaatdata
  verwerkt vóór de geaccepteerde CTP-345/CI0-startgate; synthetische
  contractvoorbeelden zijn toegestaan.
- Elke `pending-owner-acceptance`-markering is een open gate van de bevoegde
  eigenaar; dit document beantwoordt ze niet zelf.
- Een geaccepteerde startgate autoriseert alleen de beschreven eerste
  verticale. Verrijking, writes, ranking of een tweede verticale vereist een
  nieuwe gate met eigen contract-, privacy- en bewijsstukken.
- Tenantmodel, packagenamen en concrete TTL-termijnen blijven voorgesteld
  tot de betreffende eigenaar ze accepteert.

## Verificatie

- Review dit ADR tegen [ADR-0015](ADR-0015-platform-integration-contracts.md)
  §0–§3, de [integratie-inventaris](../platform-integration-inventory.md) en
  BUILD_BRIEF §9–§10; het contract mag de CTP-617/A0-grenzen niet
  tegenspreken.
- Controleer dat ieder startgate-item in §7 een benoemde approver en een
  accept/reject-formulering heeft, en dat geen enkel item door de auteur is
  vooringevuld.
- Controleer de verticale trace in §5: één synthetische assertion loopt
  aantoonbaar door identiteit, provenance, consent/retentie en het
  correctiecontract zonder echte data of een echte providercall.
- Controleer de eerste Spott-read tegen ADR-0015 §4: de duurzame
  inbound-grens — inbox/idempotentie, replay- en DLQ-gedrag en een
  benoemde retentie-eigenaar — is via SG-13 afgedekt voordat CI0 als
  geaccepteerd geldt, zodat een hertelde of gecrashte providerread geen
  dubbele of stale assertions kan achterlaten.
- Controleer dat geen enkele tekst in dit pakket een build-issue,
  verwerking, providerread of multi-tenantmigratie autoriseert.
