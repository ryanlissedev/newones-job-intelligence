# ADR-0015 — Modulegrenzen, identities en versioned integratiecontracten

- Status: Proposed; A0 target contracts accepted for planning, implementation, product- and production-gates remain open
- Datum: 2026-09-19 (oorspronkelijk voorstel 2026-09-09)
- Eigenaar: Job Intelligence platform
- Issues: CTP-617/A0, CTP-452
- Zie ook: [platform-integratie-inventaris](../platform-integration-inventory.md), [ADR-0012](ADR-0012-first-party-mcp-client-auth.md), [ADR-0014](ADR-0014-effectts-project-wide-adoption.md), [EffectTS-migratiekaart](../effectts/migration-map.md)

## Context

Job Intelligence (JI) heeft eigen domeinidentiteiten, een capabilitygrens en
begrensde integratiepaden. De huidige export bewaart attempts, een extern-ID
crosswalk en receipts; de search-projector verwerkt een eigen Postgres-outbox.
Dat zijn geen aanwijzingen voor een generieke write-database of een al werkend
platform voor alle systemen. De actuele inventaris kiest JI–Spott als eerste
verticale keten en Microsoft 365 als volgende, read-only discovery-kandidaat;
de M365-resource, tenantconsent, permissions en retentie zijn nog onbekend.

Dit ADR legt het doelcontract tussen modules en systemen vast. Het implementeert
geen envelope, schema, database, provider, tenantrecht, production rollout of
retentieperiode. Waar dit ADR van de bestaande JI-code afwijkt of verder gaat,
is het een ontwerpbesluit voor een afzonderlijke, begrensde implementatie.

## 0. Zelfstandige product- en modulegrens

Job Intelligence en Candidate Intelligence zijn twee zelfstandig toegankelijke
apps/modules. Een gebruiker die alleen Candidate Intelligence gebruikt, hoeft
Job Intelligence niet te openen. Een platform-shell mag beide producten tonen
en gedeelde auth- en UI-contracten aanbieden, maar dat maakt JI niet tot een
voorwaarde voor CI en maakt CI niet tot een nieuwe JI-capability.

Dit besluit legt geen aparte deployment, database, tenantmodel of impliciete
multitenancy vast. Iedere module behoudt een eigen capabilitygrens, write-owner,
provenance en readinessgate. Gedeelde auth betekent server-gevalideerde actor- en
scopecontext, niet dat een client toegang tot de andere module krijgt.

| Oppervlak | JI | Candidate Intelligence |
| --- | --- | --- |
| Zelfstandige toegang | JI-capabilities via eigen server/API/MCP-boundary | CI-capabilities via eigen server/API/MCP-boundary; niet afhankelijk van JI-navigatie |
| Canonieke writes | JI-use-cases bezitten aanvragen, bronnen, snapshots, approvals en exportreceipts | Geen build of kandidaatwrite vóór CTP-345/CI0-readiness; eerste bewijskaart is read-only |
| Gedeeld contract | server-owned actor/scope, versioned envelopes en afgeleide UI-DTO's | hetzelfde contractpatroon, met eigen schemas, provenance en privacybesluiten |
| Niet besloten | deployment topology, tenantmodel en gedeelde opslag | deployment topology, tenantmodel, matching/ranking en kandidaatstatuswrites |

CTP-345 blijft de productgate voor CI. Provider/use-case register, DPIA en
grondslag, provenance en TTL per assertion, correctie/bezwaar, betekenisvolle
menselijke review en fairness-evaluaties zijn voorwaarden voor een build-issue.
Auto-reject, verborgen top-N als beslissing, automatische kandidaatstatuswrites
en matching/screening als P0 blijven buiten scope.

## Besluit

### 1. Grenzen en write-eigenaarschap

De volgende vier rollen zijn afzonderlijk. Zij mogen in hetzelfde monorepo
leven; een naam als “platform” maakt er geen gedeelde database-eigenaar van.

| Rol | Eigenaar | Mag schrijven | Mag niet schrijven |
| --- | --- | --- | --- |
| JI-domein | `@ji/domain` plus de JI-use-cases in `@ji/application` | Alleen via de use-case die de betrokken JI-invariant bewaakt, bijvoorbeeld aanvraag, bron, snapshot, approval of dedup-groep | Providerobjecten, een analytics-readmodel of een andere module zijn canonieke tabellen |
| Platform-control-plane | Versiecontracten, server-vertrouwde actor/scope, policy/approval-referenties, audit- en actionmetadata; in de bestaande JI-lane voorlopig application + server boundary | Alleen control-plane-records en alleen na de betreffende policy/authorisatiecheck | Domeinrecords van een willekeurige module, providerpayloads of een universele SQL-write API |
| Core-app-adapters | `@ji/connectors`, `apps/server` en `apps/worker`; provider- en frameworkgrenzen | Alleen hun eigen checkpoint/inbox/receipt of de door een use-case gevraagde action | Canonieke JI-toestand rechtstreeks omzeilen of authorisatie uit transportinput afleiden |
| Analytics/readmodels | `@ji/search` en projecties | Hun afgeleide index, cache, checkpoint en inbox-dedupe | Bron van waarheid, approval of een extern commitbesluit |

Een module verkrijgt data via een versioned read-contract of een specifieke
application port. De writer van de bron van waarheid blijft de enige partij die
de mutatie valideert. Een readmodel of platformcomponent krijgt dus geen
generiek database-account. Dit behoudt ook de bestaande webgrens: de browser
gaat via server/API en importeert geen `@ji/db`.

De huidige compositie is het startpunt, geen bewijs van een apart platform:
[`apps/server/src/slice-a-registry.ts`](../../apps/server/src/slice-a-registry.ts)
zet de concrete stores en de server-owned deployment scope samen; de
[`commitExport`](../../packages/application/src/export/commit-export.ts)-use-case
bezit de exportbeslissing. Nieuwe package, service of gedeelde “integration
platform”-extractie komt pas met een tweede concrete consumer die dezelfde
semantiek nodig heeft. Tot die tijd is plaatsing:

- domein-entityrefs en publieke domeinschemas in `@ji/domain`;
- action-, proposal- en integration-contracten naast hun use-case in
  `@ji/application`;
- provider-wirevertaling in `@ji/connectors` of de bestaande Spott-adapter;
- durable JI-opslag en migrations in `@ji/db`;
- session/auth-context en transportmapping in `apps/server`; bestaande durable
  scheduling en task-herstart blijven tijdelijk als `apps/worker`/Trigger.dev
  interop-pad bestaan. Nieuwe jobs krijgen per flow een Effect-owned durable
  record/runtime; er komen geen nieuwe Trigger-only flows.

### 2. Scoped identities en crosswalks

Een intern ID is alleen uniek binnen zijn systeem en entitytype. Nieuwe
cross-module contracts gebruiken daarom een structuur, geen ongedocumenteerde
stringconventie:

```json
{
  "system": "ji",
  "entityType": "aanvraag",
  "id": "uuid",
  "scope": { "kind": "deployment", "id": "server-owned-value" }
}
```

`scope` wordt door de server afgeleid. Hij komt niet uit een request body,
header, MCP-parameter of agentprompt. De huidige deployment is single-tenant
per server en heeft precies zo'n server-owned scope in
[`slice-a-registry.ts`](../../apps/server/src/slice-a-registry.ts). Een latere
tenant-membershipimplementatie vervangt die bron van scope alleen met een eigen
authz-migratie; zij verandert geen historische ID's stilzwijgend.

Een externe koppeling is een versioned crosswalk en bevat ten minste:

```json
{
  "schemaVersion": "1.0",
  "scope": { "kind": "deployment", "id": "server-owned-value" },
  "canonical": { "system": "ji", "entityType": "aanvraag", "id": "uuid" },
  "external": {
    "system": "spott",
    "entityType": "vacancy",
    "id": "provider-id",
    "accountRef": "configured-provider-account-reference"
  },
  "status": "active|revoked|superseded|invalid",
  "firstObservedAt": "RFC-3339 timestamp",
  "lastVerifiedAt": "RFC-3339 timestamp or null",
  "provenance": { "source": "provider_response" }
}
```

`accountRef` is een opaque configuratiereferentie, geen secret of door de client
gekozen tenant. De bevoegde integration-owner wijzigt `status` via een
geautoriseerde, geaudite mutatie. Alleen `active` mappings mogen nieuwe actions
routeren; ingetrokken, vervangen of ongeldige mappings blijven als historie
beschikbaar binnen het retentiebeleid. Heractivering vraagt nieuwe verificatie.
Een vervangen mapping verwijst naar de opvolger zonder historische receipts te
herschrijven. Providerpayloads horen niet in de crosswalk. De bestaande
`external_id_crosswalk` bewaart de JI exportvariant per scope, target,
canonieke aanvraag en actiontype; hij is nuttig bewijs voor die beperkte
Spott-flow, geen claim dat het algemene model al is gemigreerd.

Dit contract vervangt geen bestaande bron- of dedupeidentiteit. Een `aanvraag`
houdt zijn `bronId` en `bronReferentie`; een `dedup_groep` blijft de canonieke
groepering met zijn eigen unieke dedup-sleutel. Een nieuwe crosswalk verwijst
naar die identiteit, maar maakt geen nieuwe aanvraag en herleidt geen
`bronId`. Zie de huidige
[`aanvraag`- en `dedup_groep`-schema's](../../packages/db/src/schema/curated.ts)
en de bronregel in de [bronnenrichtlijn](../sources/README.md).

### 3. Versioned envelopes: read, proposal en commit

Alle nieuwe intermodule-events en actions hebben een expliciete wireversie.
Het minimale envelope is voor JSON, HTTP, een queue of MCP gelijk; transport
voegt geen authorization-semantie toe.

```json
{
  "schemaVersion": "1.0",
  "kind": "ji.aanvraag.export.requested",
  "eventId": "uuid",
  "actionId": "uuid or null for a fact-only event",
  "correlationId": "uuid",
  "causationId": "prior event or action UUID or null",
  "occurredAt": "server timestamp, RFC-3339",
  "scope": { "kind": "deployment", "id": "server-owned-value" },
  "actor": { "kind": "user|service|agent", "id": "server-validated subject" },
  "delegation": {
    "delegatedBy": "actor reference or null",
    "policyOrApprovalRef": "immutable reference or null"
  },
  "provenance": {
    "sourceSystem": "ji|spott|m365",
    "sourceRecordRef": "scoped entity reference or null",
    "capturedAt": "RFC-3339 timestamp or null"
  },
  "payload": {}
}
```

Een actor is wie de server heeft gevalideerd; delegatie beschrijft namens wie
of onder welke approval/policy een service of agent handelt. Een client mag
hoogstens een voorstel voor die context aanleveren. De server bepaalt de scope,
valideert actor en policy, en schrijft de definitieve envelope. Geen secret,
raw providerpayload of vrije tekst met persoonsgegevens hoort in headers of
tracingmetadata.

Er zijn drie semantisch verschillende operaties:

| Operatie | Toegestane uitkomst | Vereiste grens |
| --- | --- | --- |
| `read` | Een versioned DTO of een feit-event; geen mutatie | Reader is scope-aware en ontvangt alleen het minimaal nodige veldenset |
| `proposal` | Een immutable voorstel met input/evidence-referenties; geen extern effect | Mag door een agent worden opgesteld, maar heeft nog geen commitrecht |
| `commit` | Een domeinmutatie of extern effect met receipt/terminal status | Server-side authorisatie, scope, policy/approval en idempotencycontrole vóór de adaptercall |

De huidige export is een concrete, smallere vorm van dit patroon: een snapshot
en approval worden gevalideerd vóór `commitExport`, en de uitkomst bevat
attempt/receiptreferenties. Het ADR voegt niet terugwerkend een algemeen
proposal- of envelope-opslagmodel toe.

Binnen een major versie mogen alleen semantisch inerte, optionele velden aan
read-DTO's en feit-events worden toegevoegd. Consumers publiceren hun ondersteunde
major/minor-versies; de producer kiest vooraf een gemeenschappelijke versie.
Ontbreekt die, dan wordt het bericht afgewezen of voor beheeronderzoek bewaard.
Een read/event-decoder mag onbekende velden alleen negeren wanneer het contract
expliciet bepaalt dat hun afwezigheid de betekenis niet verandert.

Proposal- en commit-input worden strikt tegen de onderhandelde versie gevalideerd.
Onbekende velden worden afgewezen, ook binnen dezelfde major. Een wijziging in
autorisatie, approval, idempotentie of provider-effectsemantiek is breaking en
krijgt een nieuwe major versie en zo nodig een nieuw `kind`. De bestaande strikte
Effect-adapter blijft voor action-input leidend; een eventueel tolerante
read/event-decoder wordt apart mechanisch afgeleid van dezelfde schema-source,
zonder de inputdecoder te versoepelen.

De contracteigenaar legt producer, consumers, compatibiliteitsvenster, cutover,
rollback en decoder-retentie vast. Een boundary-upcaster moet betekenis behouden
en mag geen ontbrekende autorisatie of approval aanvullen. Consumers herschrijven
een bewaarde oude envelope niet als nieuw feit. De oude decoder blijft beschikbaar
zolang replay- en retentiebeleid dat vereisen.

### 4. Durability, retries en onbekende externe uitkomsten

Een durable boundary heeft per directionele flow een outbox of inbox, een
idempotency-key, een replayprocedure, een dead-letterpad en een
retentieverantwoordelijke. Dit is per flow, niet één centrale bus. Exacte
bewaartermijnen, quota en on-call-rollen zijn nog niet besloten en mogen niet
uit dit ADR worden afgeleid.

| Boundary | Durable record en idempotency | Replay / onbekende uitkomst | Code- en operationele eigenaar | Retentie-eigenaar |
| --- | --- | --- | --- | --- |
| JI write → JI search readmodel | Bestaande `curated.outbox_event`; consumer-dedupe/checkpoint per projectie | Lease verstrijkt na crash; Veilige replay vereist consumer-dedupe plus bescherming tegen late writers; zie scenario 3 voor de nog open Manticore-beperking. Na maximaal aantal pogingen naar DLQ, waarna een beheeractie bewust requeues | `@ji/db` beheert outboxsemantiek; projector/readmodel-owner beheert apply en DLQ-herstel | JI data/privacy owner bepaalt event- en foutmetadataretentie |
| JI → Spott create | Action ledger/reservation met scope + target + canonieke entity + actiontype; attempt, crosswalk en receipt horen bij dezelfde effectgrens | Na timeout of ontbrekende bevestiging: status `unknown`/pending, geen nieuwe create. Reconcile via een geautoriseerde provider-read of handmatige evidence; pas daarna finalize of terminal dead-letter | `@ji/application/export` bezit de actionsemantiek; `@ji/db` de persistente records; Spott integration owner bezit reconcile en replay | JI data/privacy owner, met providercontract als grens |
| Microsoft 365 → JI (voorgesteld, read-only) | Per gekozen Graph-resource een inbox met een nog vast te stellen resource-specifieke samengestelde sleutel en minimale resource-ref; notification-ID en versie alleen gebruiken als het resourcecontract die garandeert | Gevalideerde tenant/subscription-referenties worden naar het geconfigureerde account en server-scope gemapt. Graph-notification-ID, resourceData en versies zijn niet universeel aanwezig. Geautoriseerde read- of ondersteunde delta-reconcile herstelt ontbrekende en ongeordende meldingen; de concrete resource bepaalt dedupe en ordering, onleesbare records gaan naar de flow-DLQ | Toekomstige M365 connector + benoemde resource owner; geen implementatie voordat de inventory-stopconditie is opgeheven | M365 resource/privacy owner bepaalt minimale metadata en termijn |

De bestaande search-outbox heeft leases, retry counting, dead-letter listing en
expliciete requeue; dat maakt alleen het search-projectiepad durable. Zie
[`outbox-drain.ts`](../../packages/db/src/outbox-drain.ts). De bestaande
Spott-export reserveert een effect, legt een ontvangen externe ID vast en stopt
met nieuwe creates wanneer de uitkomst nog onzeker is; zie
[`commit-export.ts`](../../packages/application/src/export/commit-export.ts).
Dat is geen bewijs van tenantrechten, live providergedrag of een volledig
generiek inbox-protocol.

Een Effect-fiber is uitsluitend een begrensde in-process uitvoering. Hij kan
geannuleerd of onderbroken worden en draagt geen durable checkpoint, replay of
exactly-once garantie. Volgens CTP-617/A0 is Trigger.dev geen doel-eigenaar
meer voor nieuwe duurzame jobs. Polling en curatie draaien al in de on-box
poller; `enrich-incomplete`, `schedule-enrich-incomplete`, `drain-outbox` en
`backfill-neon-v1` blijven tijdelijk als retained interop-pad bestaan. Nieuwe
first-party job-I/O gebruikt Effect Services/Layers en een expliciet gekozen
durable record of Effect-runtime. Een gewone job kiest de eenvoudigste bewezen
persistente queue. Workflow/DurableQueue is geen standaardkeuze en vereist
werkelijk workflow- en crash/replay-bewijs. MCP is alleen transport: iedere
`tools/call` doorloopt de server-authz- en scopegrens uit ADR-0012 en kan nooit
op zichzelf een provider-commit autoriseren.

#### Concrete crash- en replayscenario's

1. **Spott accepteert een create, de HTTP-response verdwijnt.** De action is
   al gereserveerd maar heeft geen aantoonbare externe ID. De caller schrijft
   `unknown`/pending en mag geen tweede POST doen. Een geautoriseerde readback
   of een operator koppelt gecontroleerde provider-evidence aan dezelfde
   action; pas daarna ontstaan crosswalk en receipt of een terminal DLQ-status.
   Een onbekend extern effect blijft in quarantaine en mag niet opnieuw als create
   worden aangeboden zolang evidence de uitkomst niet heeft opgelost.
2. **Proces crasht na providerresponse, vóór bevestiging.** De externe ID wordt
   eerst aan de bestaande reservation vastgelegd. Een retry ziet die reservation
   en doet geen create, maar hervat readback/confirmation en bevestigt daarna atomair
   de confirmed effect, crosswalk en receipt. Ontbreekt de ID alsnog, dan geldt
   scenario 1.
3. **Projector crasht na apply, vóór ack, of een oude writer hervat later.**
   De outboxclaim vervalt en de row kan opnieuw worden opgepakt. Event-ID,
   sequence en output-hash bewaren vóór ack voorkomt op zichzelf geen late write:
   een oude writer kan na lease-expiry een nieuwere indexversie overschrijven.
   De huidige Manticore-route beschrijft dit als een bestaande beperking in
   `outbox-drain.ts`; dit ADR claimt niet dat die is opgelost. Een implementatie
   moet sink-side monotone fencing/conditionele apply invoeren of aantoonbaar
   strikte single-writeruitvoering garanderen die ook een hervattende oude writer
   uitsluit. Tot die tijd blijft stale-write-regressie een expliciete open gate,
   met een gecontroleerde reconcile/rebuild vanuit de canonieke database nadat
   writers zijn gestopt. Blijvende fouten gaan na het attempt-budget naar de
   bestaande DLQ; requeue herstelt deze orderinggarantie niet vanzelf.

### 5. Twee contractillustraties

#### JI → Spott: approval-bound create

Een `ji.aanvraag.export.commit.v1` action refereert naar een scoped JI-aanvraag,
een immutable snapshot en approval, en gebruikt de action-key
`scope + spott + aanvraag + create`. `@ji/application/export` mapt uitsluitend
de toegestane aanvraagvelden naar de Spott-wirevorm. De Spott `vacancy`-ID
wordt vervolgens als externe crosswalk met provenance opgeslagen; een response
zonder verifieerbare ID blijft onbekend en wordt niet als succesvolle export
gepresenteerd. De bestaande mapper en confirmationgrens zijn
[`map-aanvraag-to-spott.ts`](../../packages/application/src/export/map-aanvraag-to-spott.ts)
en [`confirm-export-effect.ts`](../../packages/application/src/export/confirm-export-effect.ts).

#### Microsoft 365 → JI: read-only resource discovery

Een toekomstig `m365.resource.read.v1` request bevat de server-afgeleide JI
scope, actor/delegation en alleen een opaque provider-account/resource-ref. De
response is een versioned, minimale DTO met provider provenance; hij creëert
geen JI-domeinrecord en doet geen M365-write. De concrete Graph-resource,
delegated versus application permissions, tenantconsent, minimale velden,
retentie en ontwikkeltenant zijn expliciet **onbekend** totdat de
inventory-stopconditie is geaccepteerd. Daarom is dit voorbeeld alleen een
herbruikbaarheidstest van het contract, geen autorisatie om Graph te lezen.

Een andere agentruntime kan dezelfde JSON-envelope via HTTP, queue of een MCP
adapter consumeren. Hij krijgt geen direct database- of providerrecht; hij
levert een voorstel of roept een server-geautoriseerde action aan.

### 6. Effect Schema en frameworkadapters

ADR-0014 blijft leidend: één hand-onderhouden publieke schema-source per
contract, Effect Schema. Voor dit ADR betekent dat:

- `@ji/domain` bezit Effect Schema voor gedeelde entityrefs en domeinidentiteit;
- `@ji/application` bezit Effect Schema voor action-, proposal- en envelope-I/O
  die niet enkel intern aan een provideradapter zijn;
- `@ji/connectors` bezit alleen de provider-wireadapter en vertaalt die naar of
  van het application-contract; het kopieert geen canoniek domeinschema;
- Hono, tRPC, MCP, worker input en web DTO's gebruiken mechanisch afgeleide
  Standard Schema, JSON Schema of TypeScript-types waar hun framework dat
  vereist.

Een handmatig parallel Zod- en Effect Schema-model voor hetzelfde contract is
niet toegestaan. Persistentie is geen publiek wire-schema: Drizzle-tables
blijven bij `@ji/db`, met een expliciete mapping op de boundary. Effect-migratie
mag evenmin authz, scope-, lease-, outbox- of provider-idempotencysemantiek
stilzwijgend herdefiniëren. De durability-eigenaar mag wel veranderen van
Trigger naar een first-party Effect-pad, maar alleen per flow met een eigen
contract-, crash/replay-, rollback- en operatorbewijs.

## Gevolgen en open gates

- Nieuwe integraties moeten vóór code een flow-owner, contractversie,
  server-scopebron, idempotency-key, inbox/outbox of alternatief durable record,
  receiptvorm, replay/DLQ-procedure en retentie-eigenaar aanwijzen.
- JI- en CI-capabilities moeten elk zelfstandig aanspreekbaar zijn. Een
  platform-shell mag links en gedeelde UI/auth-contracten leveren, maar mag geen
  cross-module databasewrite of impliciete tenant/deploymentkeuze introduceren.
- Een tweede concrete consumer is vereist voordat deze contracttypes naar een
  nieuw gedeeld package of service verhuizen.
- Product-, tenant-, provider-, privacy- en retentie-gates blijven beslissingen
  van hun bevoegde owners. Dit ADR kiest geen Spott write scope, M365 resource,
  Graph permission, bewaartermijn, provideraccount of production-enablement.
- CTP-452 is door CTP-617/A0 als targetcontract geaccepteerd. Implementatie,
  migratie en productiebewijs
  horen in afzonderlijke issues met contracttests, replayevidence en waar nodig
  tenant-/providerbewijs.

## Verificatie

- Review dit ADR tegen de actuele [integratie-inventaris](../platform-integration-inventory.md), ADR-0012 en ADR-0014.
- Controleer bij elke implementatie met contracttests: scope kan niet door de
  client worden overschreven; oude envelopes blijven leesbaar binnen de
  afgesproken termijn; duplicate/replay/unknown-providerpaden maken geen tweede
  effect; en MCP bereikt dezelfde server-authz-grens als andere transports.
- Controleer de twee verticale bewijspaden afzonderlijk: JI van ingest naar
  zichtbaar searchresultaat en een toekomstige CI-read-only bewijskaart. Geen van
  beide mag de database-eigenaar van de andere module omzeilen.
- Freshness 15 minuten voor discovery en p95 5 minuten tot zichtbaarheid zijn
  voorgestelde JI-acceptance targets, geen gemeten garanties. Reconciliatie is
  brongebonden en verplicht; numerieke RPO/RTO blijven open totdat de product- en
  operations-eigenaren een waarde plus restorebewijs accepteren.
- Productie-, tenant- en providerclaims vragen apart runtimebewijs; dit document
  levert dat niet.
