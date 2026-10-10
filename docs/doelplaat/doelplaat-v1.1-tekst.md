# Catapulze — Ideale IT-architectuur v1.1 (to-be) — volledige tekst

> Geëxporteerd uit de artifact 'Catapulze Architectuur Explorer' op 2026-08-27 via klembord (volledige paginatekst, hoofdplaat). Panelen (model-JSON, documenten, datamodel, beslissingen, deep dive) staan in aparte bestanden in deze map.

Catapulze BV · Doelarchitectuur (to-be) — staffing & recruitment · Versie 1.1 · 2026-08-25 · afgeleid van de FUUSE-doelplaat (20 aug 2026)
Catapulze — Ideale IT-architectuur (to-be, hoog over)
Doelplaat voor de staffing- en recruitmentkant van Catapulze: het detacheren en bemiddelen van AI-engineers en platform engineers, maximaal geautomatiseerd. Vier lagen die op elkaar bouwen — van één centrale datalaag onderin tot agents bovenop — geflankeerd door twee verticale balken die over alle lagen heen gelden. De plaat beschrijft de rollen in de architectuur; klik op een onderdeel voor de uitleg, de datastromen, de onderliggende JSON en gerelateerde documenten.

Volledig model (JSON)
Documenten
Datamodel (entiteiten)
Deep dive: Job Intelligence
Download HTML
Download JSON
Beslissingen
Een geopend onderdeel staat in de URL (bijv. #c/ji) — die link kun je delen. Esc sluit het paneel.
Legenda
Aanwezig / live
Werk in zit — gekozen, in inrichting of te valideren
Keuze open — te onderzoeken
Ontbreekt — nieuw op te bouwen
⇅
Koppelvlak / datastroom tussen lagen
Over alle lagen heen
Compliance & security
Randvoorwaarden, dwars door elke laag


AVG / GDPR
Verwerkingsregister, grondslagen en verwerkersovereenkomsten op orde — ook voor professionals in de community en voor gescrapete vacaturedata; retentie- en verwijderbeleid technisch afdwingbaar in de datalaag.

Werk: Verwerkingsregister opstellen; retentie per entiteit in de datalaag.

EU AI Act
Hoog risico
AI-gedreven matching van professionals op aanvragen valt onder werkgelegenheid en daarmee vrijwel zeker in de hoog-risicocategorie: aantoonbare menselijke oversight, transparantie richting professionals en technische documentatie zijn verplicht.

Werk: Compliance/AI Act onderzoeken (open actie uit de focus-sessie).

Identiteit & toegang
Mensen én agents zijn identiteiten met eigen rechten (autorisatiematrix, SSO via Microsoft 365). Een agent handelt nooit anoniem — elke actie hangt aan een identiteit en een verantwoordelijke.


Audit & logging
Elke actie herleidbaar: wie of welke agent deed wat, in welk systeem, op basis van welke data. Het Company OS is de plek waar dit centraal wordt vastgelegd.


Bronvoorwaarden & arbeidsrecht
Gebruiksvoorwaarden van de vacaturebronnen (portalen, brokers, werkenbij-sites) per bron vastgelegd; detacheringsregels en certificering (SNA) lopen via het Please-traject.

Werk: Per bron voorwaarden en AVG-implicaties vastleggen in het bronnenregister.
geldt voor elke laag ⇢
Laag 4 · Agents
Agentlaag
Nieuw op te bouwen
Digitale collega's die afgebakende taken uitvoeren in de staffingprocessen — gebouwd met welk platform dan ook


Taakgerichte agents
Nieuw op te bouwen
Aanvraag-kwalificatie, matching professional ↔ aanvraag, sourcing en outreach, voorstel- en CV-opmaak, datakwaliteit — zelfstandig, maar altijd via het Company OS.

Werk: Eerste kandidaat: aanvraag-kwalificatie bovenop Job Intelligence (past een aanvraag bij het profiel en de community?).

Platform-agnostisch gebouwd
Ontwerpprincipe
Agents kunnen met verschillende applicaties en frameworks gebouwd worden; de onderliggende lagen bepalen wat ze kunnen, niet het bouwplatform. Zo blijft Catapulze wendbaar bij leverancierswissels — en wordt het ontwerp herbruikbaar richting klanten.


Lerend via de feedback loop
Ontwerpprincipe
Elke agent ziet het resultaat van zijn acties terug (via memory in het Company OS) en verbetert daarmee het proces — matching wordt beter naarmate er meer gestructureerde uitkomsten terugvloeien.


Vandaag al: Losse AI-taken zonder gedeelde data
Voorloper aanwezig
Geplande AI-taken (dagvoorbereiding op agenda en contacten, mailrouting) draaien al, en Job Intelligence v1 verzamelt aanvragen van zeven platformen.

Werk: De uitkomsten landen niet gestructureerd in een datalaag en er is geen feedback loop — precies wat laag 1 t/m 3 moeten oplossen.
⇅
Agents handelen & leren uitsluitend via het Company OS
⇅
Laag 3 · Middellaag
Company OS — besturingslaag
Nieuw op te bouwen
De tussenlaag waar agents en mensen veilig en gestandaardiseerd bij de core-applicaties kunnen


Gestandaardiseerd koppelvlak (MCP)
Gekozen richting
Eén uniforme manier waarop agents functioneren in de core-applicaties: lezen, schrijven en taken uitvoeren via MCP-koppelingen in plaats van losse maatwerk-integraties per tool.

Vandaag geen koppelvlak. Per core-systeem een MCP-server (of bestaande connector) inrichten; te beginnen bij Job Intelligence en Spott.io.

Feedback loop & memory
Nieuw op te bouwen
Het OS onthoudt wat agents deden en wat het opleverde. Die terugkoppeling stroomt terug naar de agents én naar de datalaag, zodat het proces zichzelf aantoonbaar verbetert.

Werk: Uitkomsten (voorgesteld, afgewezen, geplaatst, waarom) gestructureerd terugschrijven.

Orkestratie & governance — LangGraph / Pydantic AI · LiteLLM
Gekozen richting
Wie of wat mag welke actie in welk systeem: rechten, logging en menselijke goedkeuring op gevoelige stappen (een voorstel indienen, een tarief bevestigen). Dé plek waar AVG-randvoorwaarden afdwingbaar worden.

Werk: Agentlogica in LangGraph / Pydantic AI, modelrouting via LiteLLM; goedkeuringsstappen definiëren.

Observability & evals
Nieuw op te bouwen
Tracing van agent-acties, kwaliteits- en kostenmetrieken per taak, en evaluaties vóórdat een agent-wijziging live gaat. Maakt de feedback loop meetbaar in plaats van een intentie.

Werk: Tooling kiezen (bv. Langfuse/OpenTelemetry) en evals per agent-taak opzetten.
⇅
MCP-koppelingen naar de core-applicaties
⇅
Laag 2 · Uitvoering
Core-systemen
Deels aanwezig
De applicaties waarin het dagelijkse werk gebeurt — elk systeem werkt met unieke identifiers richting de datalaag


ATS/CRM — Spott.io
Gekozen
De recruitmentkern: professionals, opdrachtgevers, aanvragen, voorstellen en plaatsingen. Gekozen als ATS/CRM voor de staffing-kant.

Werk: Inrichting, identifier-afspraak vanaf dag één, en de koppeling naar de datalaag en naar Job Intelligence.

Vacaturebronnen — Catapulze Job Intelligence
v1 live · v2 in spec (0.2)
Eigen module die aanvragen en vacatures scrapet van brokers, MSP's, overheidsportalen, jobboards én werkenbij-sites, normaliseert naar één datamodel en naar de datalaag schrijft; analyse en search erop.

Vandaag v1 op 7 platformen (cron-gebaseerd, dashboard met circuit breaker). Werk: 23 extra bronnen uit het Source Register, uniform datamodel (generiek vs. bron-specifiek), betrouwbare scheduling, DWH-load.

Workspace / identiteit — Microsoft 365
Aanwezig
E-mail, agenda, documenten en samenwerking; tevens de identiteitsbron (SSO) voor mensen én agents.

Werk: Nog geen onderdeel van integraties of identifiers. Mailrouting naar mappen (Finance, Legal, Marketing, Operations, Sales, Tools) loopt al als AI-taak.

Sourcing — LinkedIn
Aanwezig
Kanaal voor het vinden en benaderen van AI- en platform engineers en voor de opbouw van de community.

Werk: Staat los — outreach en reacties landen niet centraal in ATS of datalaag.

Verrijking & prospecting — Clay
Aanwezig
Bedrijfs- en contactdata, prospectlijsten en verrijking van opdrachtgevers en professionals.

Werk: Verrijkte data centraal laten landen in plaats van per lijst of gebruiker.

Detachering backoffice — Please
Externe partner
Outsource-partner voor detachering: contractering, verloning en facturatie van gedetacheerde professionals; sluitstuk van plaatsing → contract → uren → factuur.

Werk: SNA-certificering regelen; vaststellen welke data (plaatsing, uren, marge) terugkomt richting de datalaag.

Administratie — Moneybird
Aanwezig
Boekhouding, verkoop- en inkoopfacturen; de financiële waarheid per plaatsing en per opdrachtgever.

Werk: Plaatsing-ID op facturen; bankkoppeling met Revolut bevestigen.

Bank — Revolut
Aanwezig
Betalingsverkeer en bankkoppeling richting Moneybird.


Gespreksnotities — Metaview (wellicht)
Te onderzoeken
Intake- en kwalificatiegesprekken met professionals en opdrachtgevers opnemen en gestructureerd naar de datalaag schrijven voor betere matching. Nog te onderzoeken of Metaview de juiste keuze is.

Werk: Onderzoek: kosten, integratie met Spott.io en Teams, AVG (opname-toestemming), datalocatie.

Huidige koppelingen: Nog geen keten
Aanname — te valideren
Job Intelligence v1 is vandaag de enige geautomatiseerde datastroom; alle overige systemen staan los van elkaar.

Werk: De keten aanvraag (Job Intelligence) → voorstel en plaatsing (Spott.io) → contract en verloning (Please) → factuur (Moneybird) → betaling (Revolut) ontwerpen als één samenhangend proces met gedeelde identifiers.

Eén taal: Unieke identifiers
Afspraak
Elke professional, opdrachtgever, aanvraag, broker/platform en plaatsing heeft één uniek ID dat in álle core-systemen wordt meegegeven. Dat is de afspraak die de datalaag betrouwbaar maakt — zonder gedeelde identifiers geen bruikbare koppeling van bronnen.

Werk: De Spott.io-inrichting en de Job Intelligence-specificatie zijn hét moment om de identifier-afspraak vanaf het begin in te voeren — er is nog geen legacy om te migreren.
⇩
Identifiers, events & datastromen voeden de datalaag — inzichten stromen terug omhoog
⇧
Laag 1 · Fundament
Datalaag
Nu niet aanwezig — gepland
Eén centrale plek waar alle data uit het ecosysteem samenkomt, gekoppeld en bruikbaar — cloud-agnostisch opgezet


Data warehouse / lakehouse — Postgres + object storage
Gepland
Centrale opslag in zones — van ruw via geschoond naar gecureerd — zodat de lake geen moeras wordt. De single source waarop agents, matching en rapportage bouwen.

Gekozen richting: Postgres + object storage in open formaten; exacte DWH-technologie nog te kiezen.

Instroom & pipelines
Gepland
Koppelingen vullen de datalaag continu vanuit de core-systemen en externe bronnen. Job Intelligence wordt de eerste bron; Spott.io, Clay en Please volgen.

Werk: Per bron koppeltype, richting en frequentie vaststellen (deep dive datastromen).

Sleutelbeheer
Gepland
Bewaakt dat de unieke identifiers uit laag 2 overal kloppen en records uit verschillende bronnen aan elkaar geknoopt kunnen worden — inclusief ontdubbeling van dezelfde aanvraag via meerdere brokers.

Werk: Identifier-afspraak vastleggen vóór de Spott.io-inrichting.

Datakwaliteit & governance
Gepland
Meten, schonen en bewaken bij de bron — inclusief retentie- en verwijderbeleid, zodat AI op schone én rechtmatige data draait.

Werk: Retentie per entiteit (o.a. gescrapete vacatures, persoonsgegevens in aanvragen) technisch afdwingen.

Gecureerde zone: Datamodel als definitielaag
Startpunt beschikbaar
De gecureerde zone spreekt de taal van het bedrijf — professional, aanvraag/vacature, opdrachtgever, broker/platform, plaatsing — met eenduidige definities per veld.

Werk: Het canonieke vacature-model uit de Job Intelligence-specificatie is het startpunt; de overige entiteiten volgen bij de Spott.io-inrichting.
Over alle lagen heen
Harness
AI-toegangslaag voor mensen


Eén gesprek met het hele ecosysteem
Deels aanwezig
Robbie, Julian en het team stellen in gewone taal vragen en krijgen direct toegang tot alle data en systemen binnen het Catapulze-ecosysteem — zonder per applicatie in te loggen.

Vandaag: Claude wordt al ingezet (dagvoorbereiding, mailrouting, Clay), maar zonder koppeling op een gedeelde datalaag.

Tool-agnostisch
De harness is een AI-assistent naar keuze; welke dat is, is inwisselbaar. De waarde zit in de lagen eronder, niet in de assistent zelf.


Via het Company OS
Ook de harness loopt via de besturingslaag: dezelfde koppelingen, dezelfde rechten, dezelfde logging als de agents.


Naast de harness: BI & dashboards
Nieuw op te bouwen
Niet alle toegang is een gesprek — KPI-rapportage (aanvragen per bron, voorstellen, plaatsingen, marge) en de Job Intelligence-search draaien rechtstreeks op de gecureerde datazone.

Werk: BI-tool kiezen; eerste dashboard: aanvragen per bron en scraper-gezondheid.
⇠ verbonden met elke laag
Aanbevolen vervolgstappen — van vandaag naar deze plaat
De volgorde is de boodschap: eerst het fundament en de datastromen, dan de middellaag, dan pas agents opschalen

1
Job Intelligence specificeren
Canoniek vacature-model (generiek vs. bron-specifiek), bronconfiguratie voor de 28 bronnen en werkenbij-sites, en het laadpatroon naar de datalaag. Dit is de eerste echte datastroom en bepaalt de vorm van de datalaag.

2
Datalaag & identifiers neerzetten
DWH-technologie kiezen binnen de cloud-agnostische stack, zones inrichten en de identifier-afspraak direct meenemen in de Spott.io-inrichting, zodat elke bron aan dezelfde professional, opdrachtgever en aanvraag hangt.

3
Keten en applicatie-gaps invullen
De keten Spott.io → Please → Moneybird → Revolut ontwerpen (koppeltype, richting, frequentie per stap) en het Metaview-onderzoek afronden: gesprekken gestructureerd naar de datalaag voor betere matching.

4
Company OS met feedback loop
De middellaag bouwen — MCP-koppelvlak, LangGraph/Pydantic AI, LiteLLM, memory en governance — als voorwaarde vóórdat agents (kwalificatie, matching, outreach) breed worden uitgerold en de harness op alle data wordt aangesloten.

Direct oppakken, parallel aan stap 1: de Spott.io-inrichting starten met de identifier-afspraak erin, de SNA-certificering via het Please-traject regelen, en per vacaturebron de gebruiksvoorwaarden en AVG-implicaties vastleggen.

Laaglogica
LAAG 1 — DATALAAG: Alles begint bij één centrale, schone datalaag; zonder dit fundament blijft elke AI-toepassing gokwerk.

LAAG 2 — CORE-SYSTEMEN: De gekozen en aanvullende applicaties voeden de datalaag via gedeelde identifiers en blijven de plek waar het werk gebeurt.

LAAG 3 — COMPANY OS: De besturingslaag die agents en mensen gecontroleerd toegang geeft tot de core, met feedback loop en memory als lerend mechanisme.

LAAG 4 — AGENTLAAG: Pas bovenop de drie lagen eronder worden agents echt waardevol — ze erven de kwaliteit van alles eronder.

HARNESS: De menselijke ingang tot het geheel, dwars door alle lagen, inwisselbaar van leverancier; klassieke BI en dashboards bestaan ernaast, rechtstreeks op de gecureerde datazone.

COMPLIANCE & SECURITY: AVG, EU AI Act (matching = hoog risico), identiteit & toegang voor mensen én agents, centrale audit/logging via het Company OS, en bronvoorwaarden & arbeidsrecht voor staffing.

De plaat beschrijft rollen in de architectuur, per rol ingevuld met de applicatie die hem vervult. Afgeleid van de FUUSE-doelplaat (versie 4, 20 augustus 2026). Versie 1.1 (2026-08-25): core-systemen ingevuld voor de staffing-kant (aanlevering Robbie); datalaag en Company OS op de cloud-agnostische stack, nog op te bouwen. Onderdelen gemarkeerd als "aanname" zijn door Robbie te valideren.


