# Deep dive: Job Intelligence — Fasen & compliance

_Zichtbare tekst van het tabblad, uitgelezen via Interceptor op 2026-08-27._

Terug naar de plaat
Laag 2 · Vacaturebronnen · deep dive · spec 0.2 + requirements

## Catapulze Job Intelligence

v1 live · v2 in specificatieCatapulze Job Intelligence — specificatie v2 (concept)versie 0.2 · 2026-08-26

Download HTMLJSON van de specJSON van de requirementsKaart op de plaat

OverzichtPipelineDatamodelBronnenDatalaagConfig & stackFasen & complianceJSON Schemav1-analyseRequirementsMapping v1 → v2

v2.0

### Fundament

Canoniek model (Pydantic + JSON Schema), raw/staging/curated/marts, scheduler met circuit breaker en freshness-SLA, adapters voor de 7 v1-bronnen, bron-gezondheidsdashboard.

Resultaat Zelfde bronnen als v1, maar gestructureerd, versiebeheerd en betrouwbaar in de datalaag.

v2.1

### Bronnen uitbreiden

TenderNed (API/RSS) en Opdrachtoverheid eerst (publiek, laag risico); daarna DAS-platformen en broker-portalen na juridische toets per bron; LLM-fallback voor nieuwe bronnen zonder adapter.

Resultaat Source Register grotendeels ontsloten; per bron gedocumenteerde unieke velden.

v2.2

### Werkenbij-sites

Bedrijvenlijst (Clay) → ATS-detectie → ATS-API/JSON-LD/sitemap+LLM; dagelijkse polling.

Resultaat Directe vacatures van doelbedrijven naast broker-aanvragen.

v2.3

### Search & analyse

Full-text + vector search, filters, MCP-tools, marts en dashboards, alerts op relevante aanvragen.

Resultaat Analyse/search voor Robbie, Julian en agents.

v2.4

### Koppeling & agents

Push van relevante aanvragen naar Spott.io (outbox), kwalificatie-agent via Company OS, feedback (voorgesteld/geplaatst) terug naar de datalaag.

Resultaat Gesloten loop van bron tot plaatsing.

### Compliance en voorwaarden

| Onderwerp | Regel |
| --- | --- |
| Gebruiksvoorwaarden per bron | Voor elke bron in het bronregister: ToS-URL, status (toegestaan / te toetsen / niet toegestaan) en of een eigen account nodig is. Bronnen met status 'niet toegestaan' worden niet gescrapet. |
| Publieke sites | robots.txt respecteren, rate limits per bron, identificeerbare user-agent met contactadres. |
| Portalen achter login | Alleen met eigen leveranciersaccount, binnen de voorwaarden van het portaal; geen omzeiling van beveiliging; per portaal juridisch toetsen vóór activering. |
| AVG | Contactpersonen zijn persoonsgegevens: minimaal opslaan, 90 dagen na sluiting verwijderen, niet in search-index; verwerkingsregister-entry 'Job Intelligence'. |
| EU AI Act | relevantie_score is ondersteunend, geen besluit; reden altijd zichtbaar; menselijke beoordeling vóór voorstellen aan opdrachtgevers. |
| Open data | TenderNed-data (CC-0) mag vrij hergebruikt worden; bronvermelding als goede praktijk. |
