# Builder.io Agent-Native — lessen voor Catapulze

Datum: 28 augustus 2026

Status: brononderzoek en implementatiekeuze; geen afgeronde productcapability

## Uitkomst

Neem het **action-contract** over, niet het framework. Het doelontwerp voor Catapulze is één getypeerde capability met één handler en één autorisatiepad, later aangeroepen via afzonderlijk aangesloten UI-, REST- en MCP-transports. Houd de catalogus deny-by-default en voeg alleen expliciet gekozen oppervlakken toe; deze transportbindings zijn nog niet geïmplementeerd.

De audit is vastgezet op commit [`c548cdcca9c78b1a1fcdf25ec5925468c7136f9e`](https://github.com/BuilderIO/agent-native/tree/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e). Bij de finale onafhankelijke controle stond `main` op [`75f835a605a6d65593bb5142036b69eb5d7e0ced`](https://github.com/BuilderIO/agent-native/commit/75f835a605a6d65593bb5142036b69eb5d7e0ced); de relevante action-, audit- en templatebronnen waren materieel gelijk. Alle inhoudelijke bronverwijzingen blijven op de geaudite SHA gepind, zodat ze niet met `main` meeschuiven.

## Patronen die we overnemen

| Patroon | Les voor Catapulze |
| --- | --- |
| Eén action, meerdere oppervlakken | Agent-Native definieert een action eenmaal en gebruikt die voor UI, agent, HTTP, MCP, A2A en CLI ([overzicht, regels 1–38](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/docs/content/actions-overview.mdx#L1-L38)). In het Catapulze-doelontwerp gebruiken UI, REST en MCP hetzelfde handlercontract; de nog te bouwen transports krijgen geen tweede versie van de domeinlogica. |
| Vertrouwde context | Caller, identiteit en automation-lineage komen uit de dispatcher en niet uit action-input ([action-context, regels 16–95](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/src/action.ts#L16-L95)). Catapulze laat principals, request-id en transport daarom door de server bepalen; een model kan deze waarden niet als argument overschrijven. |
| Strikte input én output | Het action-contract ondersteunt runtime-inputvalidatie en een optioneel apart outputschema ([action-contract, regels 488–528](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/src/action.ts#L488-L528)); wanneer dat schema is geconfigureerd, valideren de wrappers input, voeren ze uit en controleren ze daarna output ([compositie, regels 986–1052](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/src/action.ts#L986-L1052)). De upstream-default kan bij ongeldige output waarschuwen en de waarde doorlaten; Catapulze kiest bewust strenger en geeft schema- of domeinfouten als typed failure terug. |
| Autorisatie per call | Waar een `authorize`-gate is geconfigureerd, omhult die `run()` en geldt ze daardoor voor iedere caller ([autorisatie, regels 680–719](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/src/action.ts#L680-L719)). Catalogusfiltering is alleen discovery; iedere daadwerkelijke Catapulze-call wordt opnieuw geautoriseerd en autorisatie is bij ons niet optioneel. |
| Expliciete classificatie | Agent-Native declareert onder meer exposure, read-only/effectgedrag, grounding en plangedrag bij de action ([metadata, regels 542–615](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/src/action.ts#L542-L615)). Catapulze maakt `effect`, transport-exposure en grounding eveneens verplichte, controleerbare metadata in plaats van naamheuristiek. |
| Prepare → approve → execute → receipt | De Builder-template bewaart eerst een write-plan met idempotency key zonder provider-call ([prepare, regels 21–144](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/templates/content/actions/prepare-builder-source-execution.ts#L21-L144)) en eist die gate opnieuw bij executie ([execute, regels 917–953](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/templates/content/actions/execute-builder-source-execution.ts#L917-L953)). Dit patroon is later geschikt voor Spott-export en andere externe effecten, aangevuld met een duurzaam domeinreceipt. |

## Patronen die we niet kopiëren

- **Geen frameworkmigratie.** We nemen `@agent-native/core`, templates, runtime, agentloop, jobs of UI-laag niet over. Catapulze blijft een Bun-monorepo met eigen domein-, API- en datagrenzen.
- **Geen default-allow exposure.** In het onderzochte framework stellen `agentTool` en een deel van de tool-callability zich bij `undefined` permissief op ([exposure, regels 1044–1080](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/src/action.ts#L1044-L1080)). Bij Catapulze betekent afwezige exposure: nergens gepubliceerd.
- **Geen fail-open autorisatie.** Een `authorize`-functie die `undefined` retourneert, wordt daar expliciet toegelaten ([test, regels 892–976](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/src/action.spec.ts#L892-L976)). Catapulze staat alleen toe na een expliciete permission-match; geen principal, permission of besluit betekent deny.
- **Geen runtime discovery als productiecontract.** Automatisch actions ontdekken is handig voor een generiek framework, maar Catapulze heeft een statische catalogus nodig waarop typechecks, transportcoverage en review kunnen falen vóór deployment.
- **Geen brede agentruntime in Slice A.** Job Intelligence en de snelle read path gaan vóór chat, memory, handoffs, algemene A2A-orkestratie of een autonoom agentplatform.
- **Audit is niet het enige bewijs.** Het upstream auditmodel registreert actor, caller, target en status ([audittypes, regels 1–121](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/src/audit/types.ts#L1-L121)). Catapulze bewaart daarnaast domeinstate, idempotency claim, approval en providerreceipt atomair of reconcileerbaar; best-effort logging mag nooit het enige bewijs van een extern effect zijn.

## Huidige Catapulze-kloof en eerste implementatie

De architectuurdocumenten beschrijven al een capability-map en REST/MCP-pariteit, maar de product-read-path is er nog niet: er is nog geen `SearchAdapter`, geen werkende `search_aanvragen`- of `get_aanvraag`-handler en geen geobserveerde REST/MCP-binding daarvoor.

De kleinste veilige eerste codezet is daarom een **lege, deny-by-default capability-kernel**:

- typed capabilitydefinitie met input- en outputschema;
- vertrouwde invocation-context met principal, request-id en transport;
- autorisatie op iedere call;
- typed failures voor onbekende capability, ongeldige input/output en interne fout;
- detectie van dubbele capability-id's en transportbindings;
- een bewust lege productiecatalogus, dus nul gepubliceerde capabilities en nul impliciete exposure.

Dit is infrastructuur, geen gebruikersfeature en geen bewijs van UI/REST/MCP-pariteit. De kernel is pas functioneel waardevol nadat echte domeinhandlers en transports afzonderlijk zijn aangesloten en getest.

## Implementatievolgorde

1. Bouw en meet eerst de `SearchAdapter` en de read-side domeinpoorten.
2. Registreer daarna `search_aanvragen` en `get_aanvraag` als eerste echte read-capabilities, met expliciete schemas, permissions, effect, exposure en grounding.
3. Laat REST en MCP uitsluitend dezelfde registry-invocation aanroepen; voeg parity- en coverage-tests toe die ontbrekende bindings laten falen.
4. Voeg `create_snapshot` pas toe wanneer `QuerySnapshot` duurzaam en onveranderlijk kan worden opgeslagen. Een handler zonder persistence zou een contract beloven dat het systeem niet waarmaakt.
5. Pas het prepare → approve → execute → receipt-patroon later toe op externe effecten. Slice A krijgt geen brede agentruntime en geen exporteffect.

## Licentie en bewijslimiet

De licentiemetadata is niet eenduidig: de README noemt [MIT](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/README.md#L124-L126), het root-package noemt [ISC](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/package.json#L1-L15) en `@agent-native/core` noemt opnieuw [MIT](https://github.com/BuilderIO/agent-native/blob/c548cdcca9c78b1a1fcdf25ec5925468c7136f9e/packages/core/package.json#L1-L13). Op de geaudite commit staat geen root-`LICENSE`; GitHub rapporteerde evenmin een gedetecteerde repositorylicentie. Daarom gebruiken we alleen de architectuurconcepten en kopiëren we geen broncode.

Dit onderzoek heeft broncode en gerichte upstream-tests gelezen. Een volledige groene CI-run op de toenmalige current head is **niet** vastgesteld; de waargenomen nightly-run hoorde bij een eerdere SHA. De conclusies zijn dus geschikt voor een kleine Catapulze-implementatie met eigen tests, niet als claim dat het volledige upstream framework op de geaudite commit `c548cdcca9c78b1a1fcdf25ec5925468c7136f9e` is gevalideerd.
