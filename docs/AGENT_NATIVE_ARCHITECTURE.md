# Job Intelligence — agent-native architectuur

Status: ontwerp en implementatiestatus herijkt op `main@2049008` op 5 september 2026 · hoort bij `BUILD_BRIEF.md` (§4–§9) en `brainstorms/2026-08-27-techstack-brainstorm.md`
Uitgangspunt: **agents zijn eersteklas burgers vanaf dag één.** De capability registry is de gedeelde applicatiegrens; UI, REST en MCP mogen daar geen tweede domeinimplementatie naast zetten.

> **Statusgrens.** De registry is niet meer leeg. `createSliceACapabilityCatalog` bouwt op deze baseline twintig capabilities met REST- en MCP-bindings; `createProductionSliceARegistry` koppelt ze aan de server. REST-routes en het huidige custom MCP-endpoint roepen dezelfde registry-invokers aan. Dit bewijst gedeelde handlers en gerichte transportpariteit, geen complete agentervaring of productie-uitrol. `productionCapabilityCatalog` in `catalog.ts` blijft een lege, niet gebruikte legacy-export; de server bouwt de echte catalogus via `createSliceARegistry(deps)`.

De implementatiestatus valt in drie groepen:

- **Gerealiseerd op deze `main`-basis:** registryconstructie, input-/output-/failure-schema's, per-call autorisatie, dual REST/MCP-bindings, gegenereerde REST-routes, een custom `tools/list`/`tools/call`-route en coverage-/registrychecks.
- **Fixture of stub in de productiecompositie:** `start_run` en `start_test_import` maken alleen een proceslokale run-id en dispatchen geen worker; `complete_task` bevestigt alleen de aangeleverde samenvatting; `commit_export` gebruikt zonder expliciet geïnjecteerde live client de Spott-fixtureclient.
- **Gepland of nog onbewezen:** standaard MCP 2026-07-28 via de officiële SDK (RJC-439), positieve private catalogus-TTL met meting (RJC-440), de alleen in een ongemergde RJC-441-conceptbeslissing geselecteerde first-party clientgrens, automatische UI-verversing na agentwrites en de prompt-/orchestratorflows uit §5–§7.

## 0. De vijf ontwerpprincipes en hun acceptatietest

Deze tabel beschrijft de gewenste eindtoestand en de test waarmee die later wordt beoordeeld. Alleen de gerealiseerde subset uit §2 en §12 mag als huidige implementatiestatus worden gelezen.

| Principe | Wat het hier betekent | Test |
|---|---|---|
| Pariteit | Alles wat een recruiter in de UI kan (zoeken, filteren, detail, markeren, opslaan, goedkeuren, exporteren, bron beheren) kan een agent via dezelfde tools — met dezelfde rechten | Kies een willekeurige UI-actie, beschrijf hem in gewone taal: kan de agent hem uitvoeren? |
| Granulariteit | Tools zijn CRUD-primitieven per entiteit plus search en notify; "aanvraag-kwalificatie" is een prompt, geen functie | Om het gedrag van kwalificatie te veranderen, bewerk je proza, niet code |
| Composability | Nieuwe features = nieuwe prompts over bestaande primitieven | "Welke aanvragen beloofden we een terugbelactie en vergaten we?" kost een prompt, geen build |
| Emergente capaciteit | Open vragen in het domein worden opgelost door tool-compositie in een lus | "Vergelijk de tarieftrend van Azure-rollen in Utrecht met de rest van NL" zonder dashboard-feature |
| Verbetering over tijd | Per-entiteit context, gelabelde menselijke besluiten als eval-set, promptversies zonder release | Werkt het na een maand beter zonder codewijziging? |

In de doelarchitectuur blijven identiteit en rechten, de approval-matrix, idempotencykeys, auditevents, retentie en robots-/ToS-blokkades buiten de agentlus. De applicatie moet deze rails afdwingen; §2–§4 benoemen welke delen daarvan al bestaan en welke gaten nog openstaan.

## 1. Entiteiten en het beoogde tool-oppervlak

De tabel hieronder is het doelcontract, geen inventaris van huidige handlers. Een entiteit krijgt volledige CRUD wanneer het domein dat toelaat; een afwijking moet expliciet zijn. Tools accepteren **data, geen besluiten**; namen zijn gebruikersvocabulaire (`markeer_aanvraag`, niet `insert_annotation_record`). De actuele, geïmplementeerde subset staat in §2.

| Entiteit | Create | Read | Update | Delete | Bewust afwijkend |
|---|---|---|---|---|---|
| `aanvraag` | — (alleen via ingest) | `search_aanvragen`, `get_aanvraag(id, versie?)`, `list_versies` | `markeer_aanvraag` (relevant/niet/gevolgd + reden), `corrigeer_veld` (voorstel, gaat via review) | — (retentiejob; soft `verwijderd_op`) | Curated is bron-afgeleid; agents schrijven annotaties en correctie-voorstellen, geen brondata |
| `organisatie` | `create_organisatie` | `get_organisatie`, `list_organisaties` | `update_organisatie` (alias/metadata, omkeerbaar) · `merge_organisaties` als **proposal** | `delete_organisatie` als **proposal** (alleen zonder aanvragen) | Merge en delete zijn niet omkeerbaar en raken bron-afgeleide koppelingen → zelfde proposal-pad als export |
| `dedup_groep` | `create_groep` (handmatig) | `get_groep` | `split_groep`, `merge_groepen`, `zet_primaire_bron` | `delete_groep` | Omkeerbaar (koppeling, geen data) — auto, gelogd; correcties zijn eval-voorbeelden |
| `skill` / `skill_alias` | `create_skill`, `map_alias` | `get_skill`, `list_skills`, `list_review_queue` | `update_skill` | `delete_skill` als **proposal** | Delete verwijdert koppelingen op aanvragen → proposal |
| `proposal` (generiek) | via `propose_export`, `corrigeer_veld`, `merge_organisaties`, `delete_*` | `get_proposal`, `list_proposals(type, status)` | `accept_proposal(id)` (mens of policy), `reject_proposal(id, reden)` | `withdraw_proposal` | Eén proposal-type-enum: `export`, `veldcorrectie`, `organisatie_merge`, `organisatie_delete`, `skill_delete`; elk type heeft een eigen commit-handler |
| `bron` | `create_bron` (concept + config) | `get_bron` (status, SLA, circuit, laatste runs), `list_bronnen` | `update_bron_config`, `activeer_bron`, `pauzeer_bron`, `reset_circuit` | `deactiveer_bron` | `activeer_bron` is technisch geblokkeerd zonder geslaagde test-import en ToS-status (JI-BRN-04, JI-SEC-05) |
| `scrape_run` | `start_run`, `start_test_import`, `replay_run(bron, periode)` | `get_run`, `list_runs` | — | — | |
| `raw` | — | `read_raw(ref, preview\|full)`, `list_raw(bron, datum)` | — | — | Onveranderlijk |
| `saved_search` | `create_saved_search` | `get_saved_search`, `list_saved_searches` | `update_saved_search`, `plan_saved_search` | `delete_saved_search` | |
| `snapshot` | `create_snapshot(query\|saved_search)` | `get_snapshot` | — | — | Onveranderlijk: query, filters, ids, `index_version`, tijd |
| `export` | `propose_export(snapshot, ids?)` | `get_receipt`, `list_exports` | — | — | `commit_export(proposal, acceptance, idempotencyKey)` is de enige weg naar Spott.io; key = `(target, canonical_vacancy_id, action_type)`, stabiel over snapshots |
| `export_bestand` | `export_selectie(snapshot, formaat)` | `get_export_bestand` | — | — | CSV/XLSX ≤ 10.000 rijen naar object storage (JI-SRC-09) |
| `approval_policy` | — | `get_policy` | `update_policy` (beheerder) | — | Beleid als data, maar **met vorm**: verplichte velden `queryversie`, `doel`, `limieten` (max per dag/run), `geldigheidsduur`, `stopcondities` (brief §10) — een staand beleid zonder deze velden valideert niet |
| `context` (memory) | — | `read_context(entiteit, id)` | `update_context(entiteit, id, notes)` | — | Per opdrachtgever, bron, saved_search, functiegroep |
| `alert` | — | `list_alerts`, `get_bron_health` | `ack_alert` | — | |
| analytics | — | `list_tables`, `query_marts(sql)`, `query_lake(sql, snapshot?)` | — | — | Read-only DB-rol `bi`; **marts bevatten geen contactkolommen** (anders omzeilt dit de rolcheck op `get_aanvraag`); statement-timeout 10 s, max 10.000 rijen; DuckLake op gepinde snapshot (JI-DSH-07) |
| loop | — | — | — | — | `complete_task(summary, status, evidence)`, `summarize_and_continue`, `refresh_context` |

**Dynamische ontdekking i.p.v. statische mapping.** De huidige catalogus bevat generieke bronreads en een stub voor `start_run`; er bestaat geen aparte tool per bron. Het doelcontract breidt dit uit met werkelijk dispatchende bronacties, `list_tables` + `query_*` voor nieuwe marts en `get_bron_config_schema` + `update_bron_config` voor gevalideerde bronconfiguratie. Die uitbreidingen zijn nog gepland.

**Context-begrenzing zit in de tools.** `get_aanvraag` en `read_raw` geven standaard een preview; `full: true` is opt-in. `search_aanvragen` geeft id's + kop, niet volledige beschrijvingen. Daardoor kan een agent 200 resultaten doorlopen zonder zijn venster te vullen.

## 2. Capability map — actuele subset en doeldekking

De bron van waarheid is `packages/application/src/registry/capabilities.ts`. `scripts/check-capability-coverage.ts` en `scripts/check-capability-registry.ts` controleren de gedeclareerde bindings. Een `ui:*`-binding is metadata; pas een gerichte UI- of browsertest bewijst dat de gebruikersflow werkelijk aangesloten is.

| Gebied | Capabilities op `main@2049008` | Status en grens |
|---|---|---|
| Zoeken en detail | `search_aanvragen`, `get_aanvraag`, `batch_get_aanvragen`, `list_versies`, `read_raw` | Gerealiseerde handlers met REST- en custom MCP-bindings; preview/full en autorisatie worden in de registry afgedwongen |
| Bronnen | `list_bronnen`, `get_bron` | Gerealiseerde reads; bronconfiguratie, replay, pauzeren en circuit-reset uit §1 zijn nog gepland |
| Gebruikersdata | `create_saved_search`, `create_snapshot`, `approve_snapshot`, `get_snapshot_approval`, `validate_snapshot_approval`, `markeer_aanvraag` | Gerealiseerde, grotendeels duurzame handlers; list/update/delete-readbacks en automatische UI-verversing zijn niet compleet |
| Export | `commit_export` | Handler, approvalbinding, attempts/crosswalks/receipts en skip op een afgeronde crosswalk bestaan. Een effectkey wordt nog niet duurzaam vóór POST gereserveerd en een onzekere provideruitkomst wordt niet veilig hervat (RJC-435). De servercompositie valt zonder live client terug op fixtures |
| Operatie | `list_alerts`, `get_bron_health`, `ack_alert` | Gerealiseerd en duurzaam in Postgres |
| Operatie | `start_run`, `start_test_import` | Stub: maakt een proceslokale run-id, zonder workerdispatch of duurzame runstatus |
| Agentloop | `complete_task` | Stub: valideert en echoot de eindstatus; geen orchestrator, checkpoint of taakopslag |
| Mens-only | login en secretinvoer | Blijven buiten het capability-oppervlak |

De catalogus bevat op deze baseline twintig entries. Gebruik de gegenereerde catalogus als inventaris; hardcode dit aantal niet in clients of tests. Nieuwe UI-acties horen in dezelfde wijziging een echte handler, relevante transportbindingen en gerichte pariteitsevidence te krijgen.

## 3. Capability registry — het contract

Eén entry per gebruikersuitkomst is gebonden aan één handler en bevat Zod-schema's, permissie, effect, outcome en transportbindings. `createCapabilityRegistry` valideert dubbele of ongeldige capabilities en bindings bij constructie. De invoker valideert vervolgens trusted context, permissie, input, handlerresultaat, output en failures per call.

`createSliceACapabilityCatalog` voegt hier metadata aan toe voor `sideEffectClass`, target, omkeerbaarheid, auditklasse, idempotencyvelden en gedeclareerde UI-/REST-/MCP-bindings. REST-routes worden uit de catalogus opgebouwd. De MCP-adapter maakt zijn toolnamen en beschrijvingen uit dezelfde registry en roept via `invokeMcpTool` dezelfde invoker aan. Daarmee delen REST en MCP domeingedrag en autorisatie; transportcorrectheid blijft een afzonderlijke verantwoordelijkheid.

De huidige `commit_export`-metadata legt bijvoorbeeld de externe target, niet-omkeerbaarheid en de beoogde effectkeyvelden `target`, `canonical_vacancy_id` en `action_type` vast. De handler controleert de snapshotgebonden approval, slaat een create over wanneer al een afgeronde crosswalk bestaat en schrijft attempts, crosswalks, receipts en auditdata. Dit is nog geen veilige reservering over concurrency- en crashgrenzen: de key wordt niet duurzaam vóór de provider-POST gereserveerd en confirmation failure kan bij retry tot een tweede POST leiden. [RJC-435](https://linear.app/rcjt-studio/issue/RJC-435) is eigenaar van die reparatie. Een gedeclareerde binding of metadataregel bewijst op zichzelf geen live provider-effect.

### MCP-status en actuele target

Op `main@2049008` is `/mcp` een handgeschreven Hono JSON-RPC-route met alleen `tools/list` en `tools/call`. `tools/list` retourneert dezelfde, stub-inclusieve catalogus voor anonieme en geauthenticeerde callers; filtering op principal of werkelijke beschikbaarheid ontbreekt. Autorisatie vindt wel opnieuw plaats bij iedere `tools/call`. De route declareert geen MCP-protocolversie, ondersteunt geen `server/discover`, verwerkt per-request `_meta` niet en publiceert geen volledige input-/resultschemas of cachehints. Een transitieve SDK-dependency bewijst geen servercompliance. Deze route is bruikbaar voor de gerichte custom paritytests, maar er is geen runtimebewijs met een standaard MCP-client.

[RJC-439](https://linear.app/rcjt-studio/issue/RJC-439) is eigenaar van de geplande officiële TypeScript/Hono-adapter voor de stabiele MCP-specificatie 2026-07-28. De ongemergde werklane pint `@modelcontextprotocol/client`, `@modelcontextprotocol/hono` en `@modelcontextprotocol/server` alle drie exact op `2.0.0`; deze pins en adapter zijn niet aanwezig op `main@2049008`. De target verwerkt per-request metadata en de routingheaders `MCP-Protocol-Version`, `Mcp-Method` en, wanneer de methode dat vereist, `Mcp-Name`; daarnaast ondersteunt zij `server/discover` en volledige tool-/resultschemas. `initialize`, `notifications/initialized`, protocolsessies en `Mcp-Session-Id` horen niet bij deze moderne core; hun afwezigheid is geen defect. [RJC-440](https://linear.app/rcjt-studio/issue/RJC-440) volgt daarna met meetbaar hergebruik van private cataloguscachehints; de conforme basis start met `ttlMs: 0`, niet met een onbewezen positieve TTL.

De ongemergde conceptbeslissing voor [RJC-441](https://linear.app/rcjt-studio/issue/RJC-441) selecteert uitsluitend first-party, door de operator beheerde clients met een signed Better Auth-sessie van een bestaande Catapulze-gebruiker. Generieke externe clients blijven daarin niet ondersteund; de OAuth-criteria zijn daardoor niet van toepassing op het geselecteerde conceptmodel. Dit besluit en de bijbehorende hardening zijn nog niet geleverd op `main@2049008`. De huidige route valideert al per call een Better Auth-gebruikerssessie, inclusief signed bearer, maar dat is geen algemene MCP OAuth-flow. Als later toch generieke externe clients nodig zijn, vereist dat een nieuw besluit en een geteste resource-servergrens met discovery, issuer, audience/resource, scopes en revocation. Een Cloudflare-uitleg van MCP v2 verandert deze protocol- of hostingkeuze niet.

## 4. Approval-matrix — gerealiseerde subset en doelbeleid

De tabel is het doelbeleid voor P0 en later. Op deze baseline zijn snapshotapproval en de guarded `commit_export`-handler gerealiseerd; de overige proposal-, policy- en beheerflows zijn alleen van toepassing waar §2 een bestaande capability noemt.

| sideEffectClass | target / reversible | Beleid P0 | Later |
|---|---|---|---|
| read | — | auto | auto |
| proposal | — | auto (voorstel is geen effect) | auto |
| commit | intern, omkeerbaar (markering, saved_search, context, groep-correctie) | auto, gelogd | auto |
| commit | intern, niet omkeerbaar (veldcorrectie op curated, organisatie-merge/-delete, skill-delete) | mens via review-wachtrij (`accept_proposal`) | policy per type mogelijk, zelfde vorm-eisen |
| commit | intern, gevoelig (bron activeren, policy wijzigen) | mens (beheerder) | mens |
| commit | **extern / onomkeerbaar / geld** (export naar Spott.io, notificatie naar klant) | **mens** — approval gebonden aan snapshot | **`score ≥ drempel`** via `approval_policy`; < drempel → mens |

In de gerealiseerde subset bindt `QuerySnapshot` goedkeuring aan exacte id's en de zoekversie; `ApprovalRecord` bewaart actor, motivatie, expiry en de snapshot als bewijs. `commit_export` gebruikt `(target, canonical_vacancy_id, action_type)` als beoogde idempotencybasis en slaat een create over bij een bestaande afgeronde crosswalk. Duurzame reservering vóór POST en herstel van onzekere provideruitkomsten zijn nog open onder RJC-435. Policy-gestuurde approval, model-/promptversies, `update_policy` en de omslag naar een scoredrempel zijn nog doelarchitectuur. Ze vereisen afzonderlijk bewijs van betekenisvolle menselijke controle, zichtbare redenen en technische documentatie voordat daar complianceclaims aan worden verbonden.

## 5. Geplande promptagents

Dit is doelarchitectuur. Er draaien op deze baseline nog geen promptagents. Een toekomstige agent combineert een geversioneerde prompt, een beperkte toolset, een modeltier en expliciete voltooiing; domeingedrag blijft in capabilityhandlers.

| Agent | Uitkomst (prompt-kern) | Tools | Tier | Trigger |
|---|---|---|---|---|
| **Aanvraag-kwalificatie** | "Beoordeel nieuwe aanvragen op relevantie voor onze functiegroepen; geef score 0–1 met reden; markeer; stel export voor als ≥ 0,8" | `search_aanvragen`, `get_aanvraag`, `read_context(functiegroep)`, `markeer_aanvraag`, `propose_export`, `complete_task` | balanced | event `aanvraag.nieuw` (outbox) |
| **Bronbewaker** | "Onderzoek bronnen die achterstallig zijn of nul output geven; bepaal of het een layoutwijziging, auth-fout of blokkade is; stel een fix of pauze voor" | `list_alerts`, `get_bron`, `list_runs`, `read_raw`, `start_test_import`, `update_context(bron)`, `complete_task` | balanced | alert `bron.achterstallig` / `bron.stil` |
| **Dedupe-reviewer** *(prompt later)* | "Beoordeel onzekere cross-source groepen; splits of bevestig; leg de reden vast" | `get_groep`, `get_aanvraag`, `split_groep`, `merge_groepen`, `complete_task` | fast | wachtrij `dedup_groep.onzeker` |
| **Skills-curator** *(prompt later)* | "Werk de mapping-wachtrij af: alias → skill of nieuw kandidaat; houd de taxonomie onder 3.000 en zonder zinnen" | `list_review_queue`, `map_alias`, `create_skill`, `complete_task` | fast | dagelijks |
| **Bron-onboarder** *(prompt later)* | "Analyseer een nieuwe vacaturebron; stel een `scrapingStrategy`/config voor; draai een test-import van ≥ 20 records; rapporteer veldmapping en blokkers" | `create_bron`, `get_bron_config_schema`, `update_bron_config`, `start_test_import`, `read_raw`, (Stagehand `observe` als tool, alleen hier), `complete_task` | powerful | beheerder vraagt |
| **Marktvragen** (harness/chat) — *live sinds PR #392* | "Beantwoord vragen over de markt met cijfers uit marts; toon de query; verwijs naar aanvragen" | `get_data_dictionary`, `list_marts_tables`, `query_marts`, `search_query_catalog` via `POST /marktvragen/chat` on-box `streamText` (geen Trigger.dev-run per beurt) | balanced | gebruiker |

Het P0-doel omvat de eerste twee agents (kwalificatie en bronbewaker). De overige vier volgen pas wanneer hun capabilitydekking en eval-set bestaan. Promptversionering in Langfuse, het draaien van die eval-sets en deployments op basis van evalresultaten zijn eveneens gepland; deze baseline bevat daar geen runtime-integratie voor.

## 6. Geplande uitvoering — één orchestrator en expliciete voltooiing

Alleen de `complete_task`-capability bestaat, en die valideert en echoot de aangeleverde status. `start_run` en `start_test_import` bewaren runinformatie uitsluitend proceslokaal. Er is nog geen agentlus, Trigger.dev-orchestrator, duurzame taakstatus, checkpointopslag of Langfuse-trace.

Het doelontwerp is:

- **Eén orchestrator:** een geplande Trigger.dev-task `run_agent(config, event)` beheert de lifecycle, roept tools via de registry aan, bewaart checkpoints in geplande Postgres-tabellen `agent_run` en `agent_task`, begrenst kosten en tokens en schrijft een Langfuse-trace.
- **Expliciete voltooiing:** de orchestrator stopt pas na `complete_task(summary, status: success|partial|blocked, evidence[])`, niet op de heuristiek dat er geen tool-calls meer zijn. De huidige stub bewijst alleen het invoer- en uitvoercontract.
- **Deelvoltooiing:** geplande taken krijgen de status `pending`, `in_progress`, `completed`, `failed` of `skipped`; hervatten gebeurt vanaf een duurzaam checkpoint en voortgang wordt zichtbaar in de UI.
- **Contextlimiet:** de bestaande previewstandaard op leestools wordt aangevuld met geplande capabilities `summarize_and_continue` en `update_context`; duurzame context buiten het modelvenster bestaat nog niet.
- **Modeltier per agent:** de tabel in §5 beschrijft het beleid. Runtimebinding en escalatie op gemeten kwaliteit moeten nog worden gebouwd en geëvalueerd.

## 7. Geplande contextinjectie vóór de eerste tool-call

Een toekomstige orchestrator bouwt de systeemprompt per run op uit live staat. Deze contextassembler en `refresh_context` bestaan nog niet. Het doelcontract bevat:

1. **Vocabulaire**: aanvraag, opdrachtgever, intermediair, broker/platform, plaatsing, functiegroep, dedup-groep — met één zin per term.
2. **Beschikbare bronnen** (live uit `list_bronnen`): naam, categorie, status, SLA-staat.
3. **Wat de gebruiker ziet**: actieve saved searches, open alerts, recente markeringen, huidige `approval_policy` — context-pariteit met de UI.
4. **Tools in gebruikersvocabulaire**: "Markeer een aanvraag als relevant met `markeer_aanvraag`", niet "invoke annotation endpoint".
5. **Entiteit-context**: `read_context` voor de betrokken opdrachtgever/functiegroep/bron wordt vooraf ingevoegd.
6. **Voltooiingsregels**: wanneer `complete_task`, wanneer `blocked`, nooit eindeloos hetzelfde proberen.
7. de geplande capability `refresh_context` voor lange sessies.

## 8. UI-integratie — geen stille acties (gedeeltelijk)

UI-metadata, REST en custom MCP verwijzen voor de huidige subset naar dezelfde registryhandlers. Dat is de gerealiseerde gedeelde applicatiegrens. De tweede helft van het doel ontbreekt nog: een agentwrite publiceert niet aantoonbaar een scoped UI-invalidation of SSE-event waarmee een al geopend scherm automatisch ververst. De geplande outbox-events (`aanvraag.gemarkeerd`, `export.voorgesteld`, `export.bevestigd`, `bron.gepauzeerd`) en de UI-abonnementslaag blijven toekomstwerk en vragen bewijs met twee geïsoleerde gebruikersclients.

## 9. Geplande verbetering over tijd

Deze leerlus is doelarchitectuur. De tabellen, contextcapabilities, evalrunner, Langfuse-integratie en harness-telemetrie hieronder zijn nog niet geïmplementeerd:

- **Context per entiteit:** een geplande `context`-tool en tabel `agent_context` bewaren voorkeuren per opdrachtgever, geaccepteerde tarieven, afwijsredenen en bron-eigenaardigheden. De agent leest die context vóór handelen en werkt haar daarna bij.
- **Eval-set uit menselijke besluiten:** markeringen en approvals/afwijzingen kunnen gelabelde voorbeelden worden. Een geplande evalrunner meet elke promptversie; pas dan kan de gate uit JI-BRN-09 en JI-OPS-03 promptwijzigingen zonder evalrun blokkeren.
- **Promptniveaus:** het doel onderscheidt een developerprompt met Langfuse-versie, gebruikersvoorkeuren in context en agentvoorstellen voor promptwijzigingen. Zelfmodificatie blijft buiten P0.
- **Latente vraag:** geplande harness-telemetrie registreert gebruikersvragen en `complete_task(status: blocked)` als input voor de roadmap van domeintools.

## 10. Domein-tools — wanneer wél

Primitieven eerst. Een domeintool komt er pas als (a) een patroon in de logs terugkomt, (b) de compositie meetbaar traag of foutgevoelig is, of (c) de stap deterministische rails nodig heeft, zoals export, snapshotcreatie of retentie. `commit_export` en `create_snapshot` zijn bestaande domeintools; de resterende idempotencygrens van export staat in §3 en RJC-435.

## 11. Testen en coverage

- **Aanwezig:** kernboundary-tests in `packages/application/src/registry/registry.spec.ts` voor immutable metadata discovery, vaste bindings, auth, schemas, duplicate detection, contractfouten en begrensde reporting.
- **Aanwezig:** `scripts/check-capability-coverage.ts` en `scripts/check-capability-registry.ts`, plus gerichte servertests voor REST/MCP-resultaatpariteit, transportauth en preview/full-autorisatie.
- **Grens:** de huidige MCP-tests roepen het custom protocol en dezelfde invoker aan. Ze bewijzen geen MCP 2026-07-28-clientinteroperabiliteit; RJC-439 vereist daarvoor een officiële client tegen een geïsoleerde fixture-instance.
- **Gepland:** echte user-flowdekking voor iedere gedeclareerde `ui:*`-binding en automatische readback/verversing na een agentwrite.
- **Gepland:** uitkomsttests per agent op een vaste eval-set, waaronder precisie van kwalificatie, groepcorrectheid en brondiagnose.
- **Gepland kwartaalritueel:** leg drie open domeinvragen vast die nergens als feature bestaan en test of de toekomstige harness ze door toolcompositie kan beantwoorden. Dit ritueel en de harness bestaan nog niet.

## 12. Ontwerp- en implementatiestatus

Deze tabel benoemt de status op `main@2049008`. Geïmplementeerd betekent code-backed en gericht getest; het betekent niet automatisch gedeployed of in productie bewezen.

| Onderdeel | Status | Waar |
|---|---|---|
| Registrykernel en actieve servercatalogus | ✅ twintig entries gebouwd en getest; catalogusaantal is niet stabiel API-contract | `registry.ts`, `capabilities.ts`, `apps/server/src/slice-a-registry.ts` |
| REST/handlerpariteit | ✅ routes en invokers uit dezelfde registry | `apps/server/src/capabilities/rest.ts`, §2–§3 |
| MCP/handlerpariteit | ⚠️ custom `tools/list`/`tools/call` gebruikt dezelfde invoker; standaardclient niet bewezen | `apps/server/src/capabilities/mcp.ts`, `parity.spec.ts` |
| MCP 2026-07-28 | niet op deze baseline; ongemergde RJC-439-lane pint client/Hono/server SDK 2.0.0 | §3 |
| MCP private cachehints | `0/private` gepland in RJC-439; positieve TTL en meting in RJC-440 | §3 |
| Clientmodel / OAuth | ongemergde RJC-441-conceptbeslissing selecteert first-party signed Better Auth-sessies; generieke externe clients niet ondersteund en OAuth n.v.t. binnen dat model | §3 |
| Granulariteit (primitieven, geen workflows) | gedeeltelijk geïmplementeerd; bredere productdekking gepland | §1–§2, §10 |
| Composability (features = prompts) | ontwerp vastgelegd; runtime-evidence gepland | §5 |
| Emergente capaciteit | ⚠️ ontwerp maakt het mogelijk; de kwartaaltest in §11 is een ritueel, geen eval — pas ✅ na de eerste ronde met vastgelegde uitkomsten | §11 |
| Capability discovery voor gebruikers | custom, ongefilterde en stub-inclusieve `tools/list` aanwezig; permission-aware discovery en moderne `server/discover` gepland | §2–§3 |
| Agent en UI delen handlers | gedeeltelijk: registrymetadata en gedeelde handlers aanwezig; complete UI-flows/readback niet bewezen | §2, §8 |
| Dynamische ontdekking (bronnen, analytics) | bronreads aanwezig; analytics en configuratieschema gepland | §1–§2 |
| CRUD-compleetheid | gedeeltelijke subset; auditbaseline 6/18 complete resources | §1–§2 |
| Inputs = data, API valideert | ✅ registry valideert input/output/failure; bredere domeinconfig gepland | §1, §3 |
| Gedeelde werkruimte / geen stille acties | gepland | §8 |
| `context.md`-patroon | gepland: `agent_context` per entiteit | §9 |
| `complete_task`, geen heuristiek | stub aanwezig; orchestrator en duurzame taakstatus gepland | §2, §6 |
| Deelvoltooiing / checkpoints | gepland | §6 |
| Context-limieten | preview/full gerealiseerd voor detail/raw; summarize/contextworkflow gepland | §1–§2, §6 |
| Context-injectie (resources, capabilities, dynamisch) | gepland | §7 |
| Approval passend bij inzet en omkeerbaarheid | snapshotapproval en guarded exporthandler aanwezig; live Spott-effect niet bewezen | §2, §4 |
| Modeltier per agent | beleid beschreven; runtimebinding gepland | §5 |
| Mobile | n.v.t. | |

## 13. Open

- Naam en API/MCP-contract van Spott.io (DEC-006) bepaalt de `commit_export`-handler.
- Welke bronnen krijgen `activeer_bron` via agent (beheerder-gate) en welke blijven mens-only.
- Drempel en eval-criteria voor de omslag naar `policy: score` — vast te stellen op fase-1-data.

## 14. Protocolreferenties

- [MCP 2026-07-28-specificatie](https://modelcontextprotocol.io/specification/2026-07-28) en [officiële release](https://blog.modelcontextprotocol.io/posts/2026-07-28/).
- [Server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) en [caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching).
- [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), alleen van toepassing als een toekomstig geaccepteerd besluit generieke externe clienttoegang toevoegt.
- [Cloudflare MCP v2](https://blog.cloudflare.com/mcp-v2/) is aanvullende uitleg bij dezelfde officiële release en geen hostingbesluit voor Catapulze.
