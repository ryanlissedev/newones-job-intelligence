# Componenten (zijpaneel per onderdeel)

_Uitgelezen uit de artifact-bron (window `MODEL`) op 2026-08-27. Panel: klik op laag/kaartje → tabs Uitleg · Data & stromen · JSON · Documenten._


Volgorde: per laag (groep) eerst het laagpaneel, daarna de onderdelen in die laag.

## Laag: Agentlaag (`g/agents`)

_Laag 4 · Agents · status: Nieuw op te bouwen_

### Uitleg

**Wat deze laag doet.** Digitale collega's die afgebakende taken uitvoeren in de staffingprocessen — gebouwd met welk platform dan ook

**Laaglogica.** Pas bovenop de drie lagen eronder worden agents echt waardevol — ze erven de kwaliteit van alles eronder.

**Koppelvlak naar de laag eronder.** Agents handelen & leren uitsluitend via het Company OS

**Onderdelen (4).**

| Rol | Invulling | Status |
| --- | --- | --- |
| Taakgerichte agents | Agents per procesgebied | Nieuw op te bouwen |
| Platform-agnostisch gebouwd | Platform-agnostisch | Ontwerpprincipe |
| Lerend via de feedback loop | Lerend | Ontwerpprincipe |
| Vandaag al | Losse AI-taken zonder gedeelde data | Voorloper aanwezig |

### JSON

`MODEL.groepen[id = "agents"]`

```json
{
  "id": "agents",
  "laag": 4,
  "naam": "Agentlaag",
  "kicker": "Laag 4 · Agents",
  "status": "nieuw",
  "statusLabel": "Nieuw op te bouwen",
  "sub": "Digitale collega's die afgebakende taken uitvoeren in de staffingprocessen — gebouwd met welk platform dan ook",
  "logica": "Pas bovenop de drie lagen eronder worden agents echt waardevol — ze erven de kwaliteit van alles eronder.",
  "koppelvlakOnder": "Agents handelen & leren uitsluitend via het Company OS",
  "componenten": [
    "taakagents",
    "agnostisch",
    "lerend",
    "voorloper"
  ]
}
```

## Agents per procesgebied (`c/taakagents`)

_Laag 4 · Agents · Taakgerichte agents · Nieuw op te bouwen · Eigen_

### Uitleg

**Rol in de architectuur.** Aanvraag-kwalificatie, matching professional ↔ aanvraag, sourcing en outreach, voorstel- en CV-opmaak, datakwaliteit — zelfstandig, maar altijd via het Company OS.

**Waar werk in zit.** Eerste kandidaat: aanvraag-kwalificatie bovenop Job Intelligence (past een aanvraag bij het profiel en de community?).

**Identifiers.** —

**Entiteiten.** Aanvraag / vacature, Professional, Voorstel

**Open vragen.**

- Welke agent eerst: kwalificatie, matching of outreach?

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "taakagents"]`

```json
{
  "id": "taakagents",
  "groep": "agents",
  "rol": "Taakgerichte agents",
  "naam": "Agents per procesgebied",
  "leverancier": "Eigen",
  "status": "nieuw",
  "statusLabel": "Nieuw op te bouwen",
  "samenvatting": "Aanvraag-kwalificatie, matching professional ↔ aanvraag, sourcing en outreach, voorstel- en CV-opmaak, datakwaliteit — zelfstandig, maar altijd via het Company OS.",
  "werk": "Eerste kandidaat: aanvraag-kwalificatie bovenop Job Intelligence (past een aanvraag bij het profiel en de community?).",
  "entiteiten": [
    "aanvraag",
    "professional",
    "voorstel"
  ],
  "stromen": [],
  "identifiers": "—",
  "vragen": [
    "Welke agent eerst: kwalificatie, matching of outreach?"
  ],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

**Vervolgstappen die dit onderdeel raken.** 4 · Company OS met feedback loop

---

## Platform-agnostisch (`c/agnostisch`)

_Laag 4 · Agents · Platform-agnostisch gebouwd · Ontwerpprincipe · —_

### Uitleg

**Rol in de architectuur.** Agents kunnen met verschillende applicaties en frameworks gebouwd worden; de onderliggende lagen bepalen wat ze kunnen, niet het bouwplatform. Zo blijft Catapulze wendbaar bij leverancierswissels — en wordt het ontwerp herbruikbaar richting klanten.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** FUUSE-doelplaat

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "agnostisch"]`

```json
{
  "id": "agnostisch",
  "groep": "agents",
  "rol": "Platform-agnostisch gebouwd",
  "naam": "Platform-agnostisch",
  "leverancier": "—",
  "status": "nieuw",
  "statusLabel": "Ontwerpprincipe",
  "samenvatting": "Agents kunnen met verschillende applicaties en frameworks gebouwd worden; de onderliggende lagen bepalen wat ze kunnen, niet het bouwplatform. Zo blijft Catapulze wendbaar bij leverancierswissels — en wordt het ontwerp herbruikbaar richting klanten.",
  "werk": "",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat"
}
```

### Documenten

_—_

---

## Lerend (`c/lerend`)

_Laag 4 · Agents · Lerend via de feedback loop · Ontwerpprincipe · —_

### Uitleg

**Rol in de architectuur.** Elke agent ziet het resultaat van zijn acties terug (via memory in het Company OS) en verbetert daarmee het proces — matching wordt beter naarmate er meer gestructureerde uitkomsten terugvloeien.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** FUUSE-doelplaat

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "lerend"]`

```json
{
  "id": "lerend",
  "groep": "agents",
  "rol": "Lerend via de feedback loop",
  "naam": "Lerend",
  "leverancier": "—",
  "status": "nieuw",
  "statusLabel": "Ontwerpprincipe",
  "samenvatting": "Elke agent ziet het resultaat van zijn acties terug (via memory in het Company OS) en verbetert daarmee het proces — matching wordt beter naarmate er meer gestructureerde uitkomsten terugvloeien.",
  "werk": "",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat"
}
```

### Documenten

_—_

---

## Losse AI-taken zonder gedeelde data (`c/voorloper`)

_Laag 4 · Agents · Vandaag al · Voorloper aanwezig · Claude (Cowork)_

### Uitleg

**Rol in de architectuur.** Geplande AI-taken (dagvoorbereiding op agenda en contacten, mailrouting) draaien al, en Job Intelligence v1 verzamelt aanvragen van zeven platformen.

**Waar werk in zit.** De uitkomsten landen niet gestructureerd in een datalaag en er is geen feedback loop — precies wat laag 1 t/m 3 moeten oplossen.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** Aanlevering Robbie

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| in | Agenda + mail | live | m365 | connector | dagelijks 09:00 |
| in | Achtergrond gesprekspartners | live | clay | connector | dagelijks |

### JSON

`MODEL.componenten[id = "voorloper"]`

```json
{
  "id": "voorloper",
  "groep": "agents",
  "breed": true,
  "rol": "Vandaag al",
  "naam": "Losse AI-taken zonder gedeelde data",
  "leverancier": "Claude (Cowork)",
  "status": "werk",
  "statusLabel": "Voorloper aanwezig",
  "samenvatting": "Geplande AI-taken (dagvoorbereiding op agenda en contacten, mailrouting) draaien al, en Job Intelligence v1 verzamelt aanvragen van zeven platformen.",
  "werk": "De uitkomsten landen niet gestructureerd in een datalaag en er is geen feedback loop — precies wat laag 1 t/m 3 moeten oplossen.",
  "entiteiten": [],
  "stromen": [
    {
      "richting": "in",
      "met": "m365",
      "wat": "Agenda + mail",
      "type": "connector",
      "frequentie": "dagelijks 09:00",
      "status": "live"
    },
    {
      "richting": "in",
      "met": "clay",
      "wat": "Achtergrond gesprekspartners",
      "type": "connector",
      "frequentie": "dagelijks",
      "status": "live"
    }
  ],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "Aanlevering Robbie"
}
```

### Documenten

_—_

---

## Laag: Company OS — besturingslaag (`g/os`)

_Laag 3 · Middellaag · status: Nieuw op te bouwen_

### Uitleg

**Wat deze laag doet.** De tussenlaag waar agents en mensen veilig en gestandaardiseerd bij de core-applicaties kunnen

**Laaglogica.** De besturingslaag die agents en mensen gecontroleerd toegang geeft tot de core, met feedback loop en memory als lerend mechanisme.

**Koppelvlak naar de laag eronder.** MCP-koppelingen naar de core-applicaties

**Onderdelen (4).**

| Rol | Invulling | Status |
| --- | --- | --- |
| Gestandaardiseerd koppelvlak (MCP) | MCP-koppelvlak | Gekozen richting |
| Feedback loop & memory | Feedback loop & memory | Nieuw op te bouwen |
| Orkestratie & governance | LangGraph / Pydantic AI · LiteLLM | Gekozen richting |
| Observability & evals | Observability & evals | Nieuw op te bouwen |

### JSON

`MODEL.groepen[id = "os"]`

```json
{
  "id": "os",
  "laag": 3,
  "naam": "Company OS — besturingslaag",
  "kicker": "Laag 3 · Middellaag",
  "status": "nieuw",
  "statusLabel": "Nieuw op te bouwen",
  "sub": "De tussenlaag waar agents en mensen veilig en gestandaardiseerd bij de core-applicaties kunnen",
  "logica": "De besturingslaag die agents en mensen gecontroleerd toegang geeft tot de core, met feedback loop en memory als lerend mechanisme.",
  "koppelvlakOnder": "MCP-koppelingen naar de core-applicaties",
  "componenten": [
    "mcp",
    "memory",
    "governance",
    "observability"
  ]
}
```

## MCP-koppelvlak (`c/mcp`)

_Laag 3 · Middellaag · Gestandaardiseerd koppelvlak (MCP) · Gekozen richting · Open standaard_

### Uitleg

**Rol in de architectuur.** Eén uniforme manier waarop agents functioneren in de core-applicaties: lezen, schrijven en taken uitvoeren via MCP-koppelingen in plaats van losse maatwerk-integraties per tool.

**Waar werk in zit.** Vandaag geen koppelvlak. Per core-systeem een MCP-server (of bestaande connector) inrichten; te beginnen bij Job Intelligence en Spott.io.

**Identifiers.** —

**Entiteiten.** —

**Open vragen.**

- Welke systemen hebben al een bruikbare MCP-connector (M365, Clay) en welke bouwen we zelf (Spott.io, Job Intelligence, Moneybird)?

**Herkomst.** Cloud-agnostische stack: MCP als toolgrens

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "mcp"]`

```json
{
  "id": "mcp",
  "groep": "os",
  "rol": "Gestandaardiseerd koppelvlak (MCP)",
  "naam": "MCP-koppelvlak",
  "leverancier": "Open standaard",
  "status": "nieuw",
  "statusLabel": "Gekozen richting",
  "samenvatting": "Eén uniforme manier waarop agents functioneren in de core-applicaties: lezen, schrijven en taken uitvoeren via MCP-koppelingen in plaats van losse maatwerk-integraties per tool.",
  "werk": "Vandaag geen koppelvlak. Per core-systeem een MCP-server (of bestaande connector) inrichten; te beginnen bij Job Intelligence en Spott.io.",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [
    "Welke systemen hebben al een bruikbare MCP-connector (M365, Clay) en welke bouwen we zelf (Spott.io, Job Intelligence, Moneybird)?"
  ],
  "documenten": [],
  "herkomst": "Cloud-agnostische stack: MCP als toolgrens"
}
```

### Documenten

_—_

**Vervolgstappen die dit onderdeel raken.** 4 · Company OS met feedback loop

---

## Feedback loop & memory (`c/memory`)

_Laag 3 · Middellaag · Feedback loop & memory · Nieuw op te bouwen · Eigen_

### Uitleg

**Rol in de architectuur.** Het OS onthoudt wat agents deden en wat het opleverde. Die terugkoppeling stroomt terug naar de agents én naar de datalaag, zodat het proces zichzelf aantoonbaar verbetert.

**Waar werk in zit.** Uitkomsten (voorgesteld, afgewezen, geplaatst, waarom) gestructureerd terugschrijven.

**Identifiers.** —

**Entiteiten.** Voorstel, Plaatsing

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "memory"]`

```json
{
  "id": "memory",
  "groep": "os",
  "rol": "Feedback loop & memory",
  "naam": "Feedback loop & memory",
  "leverancier": "Eigen",
  "status": "nieuw",
  "statusLabel": "Nieuw op te bouwen",
  "samenvatting": "Het OS onthoudt wat agents deden en wat het opleverde. Die terugkoppeling stroomt terug naar de agents én naar de datalaag, zodat het proces zichzelf aantoonbaar verbetert.",
  "werk": "Uitkomsten (voorgesteld, afgewezen, geplaatst, waarom) gestructureerd terugschrijven.",
  "entiteiten": [
    "voorstel",
    "plaatsing"
  ],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

**Vervolgstappen die dit onderdeel raken.** 4 · Company OS met feedback loop

---

## LangGraph / Pydantic AI · LiteLLM (`c/governance`)

_Laag 3 · Middellaag · Orkestratie & governance · Gekozen richting · Open source_

### Uitleg

**Rol in de architectuur.** Wie of wat mag welke actie in welk systeem: rechten, logging en menselijke goedkeuring op gevoelige stappen (een voorstel indienen, een tarief bevestigen). Dé plek waar AVG-randvoorwaarden afdwingbaar worden.

**Waar werk in zit.** Agentlogica in LangGraph / Pydantic AI, modelrouting via LiteLLM; goedkeuringsstappen definiëren.

**Identifiers.** —

**Entiteiten.** —

**Open vragen.**

- Welke acties vereisen altijd menselijke goedkeuring?

**Herkomst.** Cloud-agnostische stack

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "governance"]`

```json
{
  "id": "governance",
  "groep": "os",
  "rol": "Orkestratie & governance",
  "naam": "LangGraph / Pydantic AI · LiteLLM",
  "leverancier": "Open source",
  "status": "nieuw",
  "statusLabel": "Gekozen richting",
  "samenvatting": "Wie of wat mag welke actie in welk systeem: rechten, logging en menselijke goedkeuring op gevoelige stappen (een voorstel indienen, een tarief bevestigen). Dé plek waar AVG-randvoorwaarden afdwingbaar worden.",
  "werk": "Agentlogica in LangGraph / Pydantic AI, modelrouting via LiteLLM; goedkeuringsstappen definiëren.",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [
    "Welke acties vereisen altijd menselijke goedkeuring?"
  ],
  "documenten": [],
  "herkomst": "Cloud-agnostische stack"
}
```

### Documenten

_—_

**Vervolgstappen die dit onderdeel raken.** 4 · Company OS met feedback loop

---

## Observability & evals (`c/observability`)

_Laag 3 · Middellaag · Observability & evals · Nieuw op te bouwen · Te kiezen_

### Uitleg

**Rol in de architectuur.** Tracing van agent-acties, kwaliteits- en kostenmetrieken per taak, en evaluaties vóórdat een agent-wijziging live gaat. Maakt de feedback loop meetbaar in plaats van een intentie.

**Waar werk in zit.** Tooling kiezen (bv. Langfuse/OpenTelemetry) en evals per agent-taak opzetten.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "observability"]`

```json
{
  "id": "observability",
  "groep": "os",
  "rol": "Observability & evals",
  "naam": "Observability & evals",
  "leverancier": "Te kiezen",
  "status": "nieuw",
  "statusLabel": "Nieuw op te bouwen",
  "samenvatting": "Tracing van agent-acties, kwaliteits- en kostenmetrieken per taak, en evaluaties vóórdat een agent-wijziging live gaat. Maakt de feedback loop meetbaar in plaats van een intentie.",
  "werk": "Tooling kiezen (bv. Langfuse/OpenTelemetry) en evals per agent-taak opzetten.",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

**Vervolgstappen die dit onderdeel raken.** 4 · Company OS met feedback loop

---

## Laag: Core-systemen (`g/core`)

_Laag 2 · Uitvoering · status: Deels aanwezig_

### Uitleg

**Wat deze laag doet.** De applicaties waarin het dagelijkse werk gebeurt — elk systeem werkt met unieke identifiers richting de datalaag

**Laaglogica.** De gekozen en aanvullende applicaties voeden de datalaag via gedeelde identifiers en blijven de plek waar het werk gebeurt.

**Koppelvlak naar de laag eronder.** Identifiers, events & datastromen voeden de datalaag — inzichten stromen terug omhoog

**Onderdelen (11).**

| Rol | Invulling | Status |
| --- | --- | --- |
| ATS/CRM | Spott.io | Gekozen |
| Vacaturebronnen | Catapulze Job Intelligence | v1 live · v2 in spec (0.2) |
| Workspace / identiteit | Microsoft 365 | Aanwezig |
| Sourcing | LinkedIn | Aanwezig |
| Verrijking & prospecting | Clay | Aanwezig |
| Detachering backoffice | Please | Externe partner |
| Administratie | Moneybird | Aanwezig |
| Bank | Revolut | Aanwezig |
| Gespreksnotities | Metaview (wellicht) | Te onderzoeken |
| Huidige koppelingen | Nog geen keten | Aanname — te valideren |
| Eén taal | Unieke identifiers | Afspraak |

### JSON

`MODEL.groepen[id = "core"]`

```json
{
  "id": "core",
  "laag": 2,
  "naam": "Core-systemen",
  "kicker": "Laag 2 · Uitvoering",
  "status": "werk",
  "statusLabel": "Deels aanwezig",
  "sub": "De applicaties waarin het dagelijkse werk gebeurt — elk systeem werkt met unieke identifiers richting de datalaag",
  "logica": "De gekozen en aanvullende applicaties voeden de datalaag via gedeelde identifiers en blijven de plek waar het werk gebeurt.",
  "koppelvlakOnder": "Identifiers, events & datastromen voeden de datalaag — inzichten stromen terug omhoog",
  "componenten": [
    "spott",
    "ji",
    "m365",
    "linkedin",
    "clay",
    "please",
    "moneybird",
    "revolut",
    "metaview",
    "koppelingen",
    "identifiers"
  ]
}
```

## Spott.io (`c/spott`)

_Laag 2 · Uitvoering · ATS/CRM · Gekozen · Spott_

### Uitleg

**Rol in de architectuur.** De recruitmentkern: professionals, opdrachtgevers, aanvragen, voorstellen en plaatsingen. Gekozen als ATS/CRM voor de staffing-kant.

**Waar werk in zit.** Inrichting, identifier-afspraak vanaf dag één, en de koppeling naar de datalaag en naar Job Intelligence.

**Identifiers.** Spott-ID's voor professional, opdrachtgever, aanvraag en plaatsing worden leidend zolang de datalaag geen eigen sleutels uitgeeft; datalaag bewaart de mapping.

**Entiteiten.** Professional, Opdrachtgever, Aanvraag / vacature, Voorstel, Plaatsing

**Open vragen.**

- Welke API-mogelijkheden biedt Spott.io (lezen/schrijven, webhooks) voor de koppeling met Job Intelligence en de datalaag?
- Contractstatus en go-live-datum?

**Herkomst.** Aanlevering Robbie, 25-08-2026

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| in | Gekwalificeerde aanvragen (genormaliseerd) als nieuwe job/aanvraag in het ATS | to-be | ji | API (te onderzoeken) | near-realtime |
| uit | Professionals, aanvragen, voorstellen, plaatsingen + statuswijzigingen (events) | to-be | datalaag | API/export | continu |
| uit | Plaatsing (professional, opdrachtgever, tarief, start/einde) voor contractering | to-be | please | handmatig → later koppeling | per plaatsing |
| in | Verrijkte bedrijfs- en contactdata van opdrachtgevers | to-be | clay | API/CSV | per lijst |

### JSON

`MODEL.componenten[id = "spott"]`

```json
{
  "id": "spott",
  "groep": "core",
  "rol": "ATS/CRM",
  "naam": "Spott.io",
  "leverancier": "Spott",
  "status": "werk",
  "statusLabel": "Gekozen",
  "samenvatting": "De recruitmentkern: professionals, opdrachtgevers, aanvragen, voorstellen en plaatsingen. Gekozen als ATS/CRM voor de staffing-kant.",
  "werk": "Inrichting, identifier-afspraak vanaf dag één, en de koppeling naar de datalaag en naar Job Intelligence.",
  "entiteiten": [
    "professional",
    "opdrachtgever",
    "aanvraag",
    "voorstel",
    "plaatsing"
  ],
  "stromen": [
    {
      "richting": "in",
      "met": "ji",
      "wat": "Gekwalificeerde aanvragen (genormaliseerd) als nieuwe job/aanvraag in het ATS",
      "type": "API (te onderzoeken)",
      "frequentie": "near-realtime",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "datalaag",
      "wat": "Professionals, aanvragen, voorstellen, plaatsingen + statuswijzigingen (events)",
      "type": "API/export",
      "frequentie": "continu",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "please",
      "wat": "Plaatsing (professional, opdrachtgever, tarief, start/einde) voor contractering",
      "type": "handmatig → later koppeling",
      "frequentie": "per plaatsing",
      "status": "to-be"
    },
    {
      "richting": "in",
      "met": "clay",
      "wat": "Verrijkte bedrijfs- en contactdata van opdrachtgevers",
      "type": "API/CSV",
      "frequentie": "per lijst",
      "status": "to-be"
    }
  ],
  "identifiers": "Spott-ID's voor professional, opdrachtgever, aanvraag en plaatsing worden leidend zolang de datalaag geen eigen sleutels uitgeeft; datalaag bewaart de mapping.",
  "vragen": [
    "Welke API-mogelijkheden biedt Spott.io (lezen/schrijven, webhooks) voor de koppeling met Job Intelligence en de datalaag?",
    "Contractstatus en go-live-datum?"
  ],
  "documenten": [
    {
      "type": "doc",
      "titel": "IT-architectuur staffing (projectdoc)",
      "ref": "projects/it-architectuur-staffing.md"
    },
    {
      "type": "link",
      "titel": "Spott.io",
      "ref": "https://spott.io"
    }
  ],
  "herkomst": "Aanlevering Robbie, 25-08-2026"
}
```

### Documenten

- **IT-architectuur staffing (projectdoc)** (doc) — projects/it-architectuur-staffing.md
- **Spott.io** (link) — https://spott.io

**Vervolgstappen die dit onderdeel raken.** 2 · Datalaag & identifiers neerzetten, 3 · Keten en applicatie-gaps invullen

---

## Catapulze Job Intelligence (`c/ji`)

_Laag 2 · Uitvoering · Vacaturebronnen · v1 live · v2 in spec (0.2) · Eigen module_

### Uitleg

**Rol in de architectuur.** Eigen module die aanvragen en vacatures scrapet van brokers, MSP's, overheidsportalen, jobboards én werkenbij-sites, normaliseert naar één datamodel en naar de datalaag schrijft; analyse en search erop.

**Waar werk in zit.** Vandaag v1 op 7 platformen (cron-gebaseerd, dashboard met circuit breaker). Werk: 23 extra bronnen uit het Source Register, uniform datamodel (generiek vs. bron-specifiek), betrouwbare scheduling, DWH-load.

**Identifiers.** Per aanvraag: bron-ID + bron-referentie als natuurlijke sleutel; eigen aanvraag-ID in de datalaag; ontdubbeling over bronnen (dezelfde aanvraag via meerdere brokers) is een expliciete stap.

**Entiteiten.** Aanvraag / vacature, Bron / platform, Opdrachtgever

**Open vragen.**

- Welke datapunten zijn generiek (canoniek model) en welke bron-specifiek? (categorie-niveau gedaan; per bron te valideren bij onboarding)
- Welke DWH-technologie en welk laadpatroon? (voorstel: Postgres + object storage, fase 1)
- Welke werkenbij-sites hebben prioriteit?
- Spott.io-push automatisch boven een drempel of altijd na menselijke markering? (JI-INT-04 / JI-SEC-07)
- Rolmodel viewer / recruiter / beheerder voldoende? (JI-SEC-01)

**Herkomst.** Aanlevering Robbie (screenshot v1-dashboard + Source Register), 25-08-2026

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| in | Aanvragen/vacatures van 28 bronnen (7 v1 + 23 nieuw) + werkenbij-sites | v1 deels | extern | Playwright / HTML / API / RSS (per bron) | 5 min – dagelijks, per bron |
| uit | Ruwe payload (raw-zone) + genormaliseerde aanvraag (gecureerde zone) + run-metadata | to-be | datalaag | batch/upsert | per run |
| uit | Gekwalificeerde aanvragen naar het ATS | to-be | spott | API (te onderzoeken) | near-realtime |
| uit | Search en analyse op de verzamelde aanvragen | to-be | harness | query op gecureerde zone | on demand |

**Bronnen (28) — v1 + Source Register.**

| naam | categorie | website | ingestie | polling | login | v1 | schemaV1 | prio | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Flextender | Broker / DAS | https://flextender.nl | Playwright | 10 min | Ja | True | elke 4 uur | A | Researching |
| MiPublic | Overheidsportaal |  | v1 |  |  | True | dagelijks |  | v1 (circuit open) |
| Nationale Vacaturebank | Jobboard | https://www.nationalevacaturebank.nl | v1 |  | Nee | True | elke 6 uur |  | v1 |
| Opdrachtoverheid | Overheidsportaal | https://www.opdrachtoverheid.nl | v1 |  |  | True | elke 4 uur |  | v1 |
| Starapple | IT-broker / platform | https://www.starapple.nl | v1 |  |  | True | elke 4 uur |  | v1 |
| Striive / HeadFirst Group | MSP / Broker | https://striive.com | Playwright | 5 min | Ja | True | elke 4 uur | A | v1 + Researching |
| Werkzoeken | Jobboard | https://www.werkzoeken.nl | v1 |  | Nee | True | elke 6 uur |  | v1 |
| Staffing Management Services (SMS) | MSP / Broker | https://www.headfirst.nl/staffingms | Playwright | 5 min | Ja | False | — | A | Researching |
| Circle8 | MSP / Broker | https://circle8.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| BlueTrail | MSP / Broker | https://www.bluetrail.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| Harvey Nash | MSP / Broker | https://www.harveynash.com | Playwright | 15 min | Ja | False | — | A | Researching |
| Magnit | Global MSP | https://www.magnitglobal.com | API waar beschikbaar | 15 min | Ja | False | — | A | Researching |
| Randstad Enterprise | MSP | https://www.randstadenterprise.com | Playwright/API | 15 min | Ja | False | — | A | Researching |
| Between Staffing | Broker | https://between.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| Brainnet | Broker | https://brainnet.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| Hero | Broker | https://hero.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| Bconnect | Broker | https://bconnect.nu | Playwright | 10 min | Ja | False | — | A | Researching |
| Flinter | Broker | https://flinter.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| StaffingNow | Broker | https://staffingnow.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| Need Staffing IT | Broker | https://needstaffingit.com | Playwright | 10 min | Ja | False | — | A | Researching |
| Onefellow | Broker | https://onefellow.com | Playwright | 10 min | Ja | False | — | A | Researching |
| OneStopSourcing | Broker | https://onestopsourcing.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| Pro-Act IT | Broker | https://pro-act.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| TenderNed | Government DAS | https://www.tenderned.nl | Officiële API/RSS | Realtime | Optioneel | False | — | A | Researching |
| Mercell | Government DAS | https://www.mercell.com/nl-nl | Playwright | 10 min | Ja | False | — | A | Researching |
| DigiInhuur | Government Portal | https://www.digiinhuur.nl | Playwright | 10 min | Ja | False | — | A | Researching |
| Inhuurdesk | Government Portal | https://www.inhuurdesk.nl | HTML/Playwright | 10 min | Vaak | False | — | A | Researching |
| CTM Solution | Tender Platform | https://www.ctmsolution.nl | Playwright | 15 min | Ja | False | — | A | Researching |

**v1-dashboard, stand 25-08-2026.** Alle scrapers stonden op “Achterstallig” en MiPublic op “Circuit geopend” — betrouwbaarheid van de scheduler is een aandachtspunt in v2. (Screenshot niet geëxporteerd.)

### JSON

`MODEL.componenten[id = "ji"]`

```json
{
  "id": "ji",
  "groep": "core",
  "rol": "Vacaturebronnen",
  "naam": "Catapulze Job Intelligence",
  "leverancier": "Eigen module",
  "status": "werk",
  "statusLabel": "v1 live · v2 in spec (0.2)",
  "samenvatting": "Eigen module die aanvragen en vacatures scrapet van brokers, MSP's, overheidsportalen, jobboards én werkenbij-sites, normaliseert naar één datamodel en naar de datalaag schrijft; analyse en search erop.",
  "werk": "Vandaag v1 op 7 platformen (cron-gebaseerd, dashboard met circuit breaker). Werk: 23 extra bronnen uit het Source Register, uniform datamodel (generiek vs. bron-specifiek), betrouwbare scheduling, DWH-load.",
  "entiteiten": [
    "aanvraag",
    "bron",
    "opdrachtgever"
  ],
  "stromen": [
    {
      "richting": "in",
      "met": "extern",
      "wat": "Aanvragen/vacatures van 28 bronnen (7 v1 + 23 nieuw) + werkenbij-sites",
      "type": "Playwright / HTML / API / RSS (per bron)",
      "frequentie": "5 min – dagelijks, per bron",
      "status": "v1 deels"
    },
    {
      "richting": "uit",
      "met": "datalaag",
      "wat": "Ruwe payload (raw-zone) + genormaliseerde aanvraag (gecureerde zone) + run-metadata",
      "type": "batch/upsert",
      "frequentie": "per run",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "spott",
      "wat": "Gekwalificeerde aanvragen naar het ATS",
      "type": "API (te onderzoeken)",
      "frequentie": "near-realtime",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "harness",
      "wat": "Search en analyse op de verzamelde aanvragen",
      "type": "query op gecureerde zone",
      "frequentie": "on demand",
      "status": "to-be"
    }
  ],
  "identifiers": "Per aanvraag: bron-ID + bron-referentie als natuurlijke sleutel; eigen aanvraag-ID in de datalaag; ontdubbeling over bronnen (dezelfde aanvraag via meerdere brokers) is een expliciete stap.",
  "vragen": [
    "Welke datapunten zijn generiek (canoniek model) en welke bron-specifiek? (categorie-niveau gedaan; per bron te valideren bij onboarding)",
    "Welke DWH-technologie en welk laadpatroon? (voorstel: Postgres + object storage, fase 1)",
    "Welke werkenbij-sites hebben prioriteit?",
    "Spott.io-push automatisch boven een drempel of altijd na menselijke markering? (JI-INT-04 / JI-SEC-07)",
    "Rolmodel viewer / recruiter / beheerder voldoende? (JI-SEC-01)"
  ],
  "documenten": [
    {
      "type": "doc",
      "titel": "Projectdoc Catapulze Job Intelligence",
      "ref": "projects/vacature-scraper.md"
    },
    {
      "type": "doc",
      "titel": "Specificatie v2 (architectuur, canoniek model, datalaag)",
      "ref": "projects/job-intelligence-specificatie.md",
      "open": "ji/overzicht"
    },
    {
      "type": "doc",
      "titel": "IT-requirements v2 (110 requirements, veldmapping v1 → v2)",
      "ref": "projects/job-intelligence-requirements.md",
      "open": "ji/requirements"
    },
    {
      "type": "ref",
      "titel": "Neon-schema v1 (33 tabellen, 432 kolommen, 26-08-2026)",
      "ref": "neonschema.json / neonschema.md",
      "where": "Aangeleverd door Robbie; samengevat in de tab v1-analyse",
      "open": "ji/v1"
    },
    {
      "type": "link",
      "titel": "v1-app Jobs Intelligence (Lovable)",
      "ref": "https://neon-data-whisperer.lovable.app/"
    },
    {
      "type": "doc",
      "titel": "Bronnenregister (28 bronnen)",
      "ref": "projects/vacature-scraper-bronnen.md"
    },
    {
      "type": "data",
      "titel": "Catapulze Source Register.xlsx (23 nieuwe bronnen)",
      "ref": "bronnen"
    },
    {
      "type": "data",
      "titel": "v1-dashboard, stand 25-08-2026",
      "ref": "dashboard"
    }
  ],
  "herkomst": "Aanlevering Robbie (screenshot v1-dashboard + Source Register), 25-08-2026"
}
```

### Documenten

- **Projectdoc Catapulze Job Intelligence** (doc) — projects/vacature-scraper.md
- **Specificatie v2 (architectuur, canoniek model, datalaag)** (doc) — projects/job-intelligence-specificatie.md
- **IT-requirements v2 (110 requirements, veldmapping v1 → v2)** (doc) — projects/job-intelligence-requirements.md
- **Neon-schema v1 (33 tabellen, 432 kolommen, 26-08-2026)** (ref) — neonschema.json / neonschema.md
- **v1-app Jobs Intelligence (Lovable)** (link) — https://neon-data-whisperer.lovable.app/
- **Bronnenregister (28 bronnen)** (doc) — projects/vacature-scraper-bronnen.md
- **Catapulze Source Register.xlsx (23 nieuwe bronnen)** (data) — bronnen
- **v1-dashboard, stand 25-08-2026** (data) — dashboard

**Vervolgstappen die dit onderdeel raken.** 1 · Job Intelligence specificeren

---

## Microsoft 365 (`c/m365`)

_Laag 2 · Uitvoering · Workspace / identiteit · Aanwezig · Microsoft_

### Uitleg

**Rol in de architectuur.** E-mail, agenda, documenten en samenwerking; tevens de identiteitsbron (SSO) voor mensen én agents.

**Waar werk in zit.** Nog geen onderdeel van integraties of identifiers. Mailrouting naar mappen (Finance, Legal, Marketing, Operations, Sales, Tools) loopt al als AI-taak.

**Identifiers.** Entra-identiteit als bron voor 'wie deed wat' in audit & logging.

**Entiteiten.** Professional, Opdrachtgever

**Open vragen.**

- Worden agents als eigen identiteiten (service principals) in Entra ingericht?

**Herkomst.** Aanlevering Robbie, 25-08-2026

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| uit | Agenda en mail als context voor dagvoorbereiding | live (los) | harness | Graph API (via connector) | dagelijks |
| uit | Identiteiten en rechten (SSO) voor mensen en agents | to-be | os | Entra ID | continu |

### JSON

`MODEL.componenten[id = "m365"]`

```json
{
  "id": "m365",
  "groep": "core",
  "rol": "Workspace / identiteit",
  "naam": "Microsoft 365",
  "leverancier": "Microsoft",
  "status": "live",
  "statusLabel": "Aanwezig",
  "samenvatting": "E-mail, agenda, documenten en samenwerking; tevens de identiteitsbron (SSO) voor mensen én agents.",
  "werk": "Nog geen onderdeel van integraties of identifiers. Mailrouting naar mappen (Finance, Legal, Marketing, Operations, Sales, Tools) loopt al als AI-taak.",
  "entiteiten": [
    "professional",
    "opdrachtgever"
  ],
  "stromen": [
    {
      "richting": "uit",
      "met": "harness",
      "wat": "Agenda en mail als context voor dagvoorbereiding",
      "type": "Graph API (via connector)",
      "frequentie": "dagelijks",
      "status": "live (los)"
    },
    {
      "richting": "uit",
      "met": "os",
      "wat": "Identiteiten en rechten (SSO) voor mensen en agents",
      "type": "Entra ID",
      "frequentie": "continu",
      "status": "to-be"
    }
  ],
  "identifiers": "Entra-identiteit als bron voor 'wie deed wat' in audit & logging.",
  "vragen": [
    "Worden agents als eigen identiteiten (service principals) in Entra ingericht?"
  ],
  "documenten": [
    {
      "type": "link",
      "titel": "Microsoft 365",
      "ref": "https://www.microsoft.com/microsoft-365"
    }
  ],
  "herkomst": "Aanlevering Robbie, 25-08-2026"
}
```

### Documenten

- **Microsoft 365** (link) — https://www.microsoft.com/microsoft-365

---

## LinkedIn (`c/linkedin`)

_Laag 2 · Uitvoering · Sourcing · Aanwezig · LinkedIn_

### Uitleg

**Rol in de architectuur.** Kanaal voor het vinden en benaderen van AI- en platform engineers en voor de opbouw van de community.

**Waar werk in zit.** Staat los — outreach en reacties landen niet centraal in ATS of datalaag.

**Identifiers.** LinkedIn-profiel-URL als extern kenmerk van een professional; nooit als primaire sleutel.

**Entiteiten.** Professional

**Open vragen.**

- Welke licentievorm (Recruiter, Sales Navigator, standaard) en hoeveel seats?
- Geautomatiseerde outreach: binnen de gebruiksvoorwaarden houden.

**Herkomst.** Aanlevering Robbie, 25-08-2026

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| uit | Gesourcete professionals en outreach-status | to-be | spott | handmatig / extensie | ad hoc |

### JSON

`MODEL.componenten[id = "linkedin"]`

```json
{
  "id": "linkedin",
  "groep": "core",
  "rol": "Sourcing",
  "naam": "LinkedIn",
  "leverancier": "LinkedIn",
  "status": "live",
  "statusLabel": "Aanwezig",
  "samenvatting": "Kanaal voor het vinden en benaderen van AI- en platform engineers en voor de opbouw van de community.",
  "werk": "Staat los — outreach en reacties landen niet centraal in ATS of datalaag.",
  "entiteiten": [
    "professional"
  ],
  "stromen": [
    {
      "richting": "uit",
      "met": "spott",
      "wat": "Gesourcete professionals en outreach-status",
      "type": "handmatig / extensie",
      "frequentie": "ad hoc",
      "status": "to-be"
    }
  ],
  "identifiers": "LinkedIn-profiel-URL als extern kenmerk van een professional; nooit als primaire sleutel.",
  "vragen": [
    "Welke licentievorm (Recruiter, Sales Navigator, standaard) en hoeveel seats?",
    "Geautomatiseerde outreach: binnen de gebruiksvoorwaarden houden."
  ],
  "documenten": [
    {
      "type": "link",
      "titel": "LinkedIn",
      "ref": "https://www.linkedin.com"
    }
  ],
  "herkomst": "Aanlevering Robbie, 25-08-2026"
}
```

### Documenten

- **LinkedIn** (link) — https://www.linkedin.com

---

## Clay (`c/clay`)

_Laag 2 · Uitvoering · Verrijking & prospecting · Aanwezig · Clay_

### Uitleg

**Rol in de architectuur.** Bedrijfs- en contactdata, prospectlijsten en verrijking van opdrachtgevers en professionals.

**Waar werk in zit.** Verrijkte data centraal laten landen in plaats van per lijst of gebruiker.

**Identifiers.** Bedrijf: KvK-nummer of domein als natuurlijke sleutel; persoon: e-mail + LinkedIn-URL.

**Entiteiten.** Opdrachtgever, Professional

**Herkomst.** Aanlevering Robbie, 25-08-2026

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| uit | Verrijkte bedrijfs- en contactrecords | to-be | datalaag | API/CSV | per lijst |
| uit | Opdrachtgevers en contacten als accounts in het ATS/CRM | to-be | spott | API | per lijst |
| uit | Achtergrond van gesprekspartners voor dagvoorbereiding | live (los) | harness | connector | dagelijks |

### JSON

`MODEL.componenten[id = "clay"]`

```json
{
  "id": "clay",
  "groep": "core",
  "rol": "Verrijking & prospecting",
  "naam": "Clay",
  "leverancier": "Clay",
  "status": "live",
  "statusLabel": "Aanwezig",
  "samenvatting": "Bedrijfs- en contactdata, prospectlijsten en verrijking van opdrachtgevers en professionals.",
  "werk": "Verrijkte data centraal laten landen in plaats van per lijst of gebruiker.",
  "entiteiten": [
    "opdrachtgever",
    "professional"
  ],
  "stromen": [
    {
      "richting": "uit",
      "met": "datalaag",
      "wat": "Verrijkte bedrijfs- en contactrecords",
      "type": "API/CSV",
      "frequentie": "per lijst",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "spott",
      "wat": "Opdrachtgevers en contacten als accounts in het ATS/CRM",
      "type": "API",
      "frequentie": "per lijst",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "harness",
      "wat": "Achtergrond van gesprekspartners voor dagvoorbereiding",
      "type": "connector",
      "frequentie": "dagelijks",
      "status": "live (los)"
    }
  ],
  "identifiers": "Bedrijf: KvK-nummer of domein als natuurlijke sleutel; persoon: e-mail + LinkedIn-URL.",
  "vragen": [],
  "documenten": [
    {
      "type": "link",
      "titel": "Clay",
      "ref": "https://www.clay.com"
    }
  ],
  "herkomst": "Aanlevering Robbie, 25-08-2026"
}
```

### Documenten

- **Clay** (link) — https://www.clay.com

---

## Please (`c/please`)

_Laag 2 · Uitvoering · Detachering backoffice · Externe partner · Please (externe partner)_

### Uitleg

**Rol in de architectuur.** Outsource-partner voor detachering: contractering, verloning en facturatie van gedetacheerde professionals; sluitstuk van plaatsing → contract → uren → factuur.

**Waar werk in zit.** SNA-certificering regelen; vaststellen welke data (plaatsing, uren, marge) terugkomt richting de datalaag.

**Identifiers.** Plaatsing-ID uit Spott meegeven op elk contract en elke factuur, zodat marge per plaatsing herleidbaar is.

**Entiteiten.** Plaatsing, Contract, Factuur, Professional

**Open vragen.**

- Welke data levert Please terug en in welke vorm?
- Wie is contracthouder richting de professional en de opdrachtgever?

**Herkomst.** Aanlevering Robbie, 25-08-2026

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| in | Plaatsingsgegevens voor contractering | to-be | spott | handmatig → later koppeling | per plaatsing |
| uit | Facturen/afrekening richting de administratie | to-be | moneybird | te bepalen | maandelijks |
| uit | Uren, contractstatus en marge per plaatsing | to-be | datalaag | export/API (te bepalen) | maandelijks |

### JSON

`MODEL.componenten[id = "please"]`

```json
{
  "id": "please",
  "groep": "core",
  "rol": "Detachering backoffice",
  "naam": "Please",
  "leverancier": "Please (externe partner)",
  "status": "werk",
  "statusLabel": "Externe partner",
  "samenvatting": "Outsource-partner voor detachering: contractering, verloning en facturatie van gedetacheerde professionals; sluitstuk van plaatsing → contract → uren → factuur.",
  "werk": "SNA-certificering regelen; vaststellen welke data (plaatsing, uren, marge) terugkomt richting de datalaag.",
  "entiteiten": [
    "plaatsing",
    "contract",
    "factuur",
    "professional"
  ],
  "stromen": [
    {
      "richting": "in",
      "met": "spott",
      "wat": "Plaatsingsgegevens voor contractering",
      "type": "handmatig → later koppeling",
      "frequentie": "per plaatsing",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "moneybird",
      "wat": "Facturen/afrekening richting de administratie",
      "type": "te bepalen",
      "frequentie": "maandelijks",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "datalaag",
      "wat": "Uren, contractstatus en marge per plaatsing",
      "type": "export/API (te bepalen)",
      "frequentie": "maandelijks",
      "status": "to-be"
    }
  ],
  "identifiers": "Plaatsing-ID uit Spott meegeven op elk contract en elke factuur, zodat marge per plaatsing herleidbaar is.",
  "vragen": [
    "Welke data levert Please terug en in welke vorm?",
    "Wie is contracthouder richting de professional en de opdrachtgever?"
  ],
  "documenten": [
    {
      "type": "doc",
      "titel": "Catapulze services-sessie (detachering via externe partner, SNA)",
      "ref": "memory: catapulze — services"
    }
  ],
  "herkomst": "Aanlevering Robbie, 25-08-2026"
}
```

### Documenten

- **Catapulze services-sessie (detachering via externe partner, SNA)** (doc) — memory: catapulze — services

**Vervolgstappen die dit onderdeel raken.** 3 · Keten en applicatie-gaps invullen

---

## Moneybird (`c/moneybird`)

_Laag 2 · Uitvoering · Administratie · Aanwezig · Moneybird_

### Uitleg

**Rol in de architectuur.** Boekhouding, verkoop- en inkoopfacturen; de financiële waarheid per plaatsing en per opdrachtgever.

**Waar werk in zit.** Plaatsing-ID op facturen; bankkoppeling met Revolut bevestigen.

**Identifiers.** Contact-ID Moneybird ↔ opdrachtgever-ID; factuurreferentie bevat plaatsing-ID.

**Entiteiten.** Factuur, Opdrachtgever

**Herkomst.** Aanlevering Robbie, 25-08-2026

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| in | Banktransacties | te valideren | revolut | bankkoppeling | dagelijks |
| uit | Facturen, betalingen, omzet per opdrachtgever/plaatsing | to-be | datalaag | API | dagelijks |

### JSON

`MODEL.componenten[id = "moneybird"]`

```json
{
  "id": "moneybird",
  "groep": "core",
  "rol": "Administratie",
  "naam": "Moneybird",
  "leverancier": "Moneybird",
  "status": "live",
  "statusLabel": "Aanwezig",
  "samenvatting": "Boekhouding, verkoop- en inkoopfacturen; de financiële waarheid per plaatsing en per opdrachtgever.",
  "werk": "Plaatsing-ID op facturen; bankkoppeling met Revolut bevestigen.",
  "entiteiten": [
    "factuur",
    "opdrachtgever"
  ],
  "stromen": [
    {
      "richting": "in",
      "met": "revolut",
      "wat": "Banktransacties",
      "type": "bankkoppeling",
      "frequentie": "dagelijks",
      "status": "te valideren"
    },
    {
      "richting": "uit",
      "met": "datalaag",
      "wat": "Facturen, betalingen, omzet per opdrachtgever/plaatsing",
      "type": "API",
      "frequentie": "dagelijks",
      "status": "to-be"
    }
  ],
  "identifiers": "Contact-ID Moneybird ↔ opdrachtgever-ID; factuurreferentie bevat plaatsing-ID.",
  "vragen": [],
  "documenten": [
    {
      "type": "link",
      "titel": "Moneybird",
      "ref": "https://www.moneybird.nl"
    }
  ],
  "herkomst": "Aanlevering Robbie, 25-08-2026"
}
```

### Documenten

- **Moneybird** (link) — https://www.moneybird.nl

**Vervolgstappen die dit onderdeel raken.** 3 · Keten en applicatie-gaps invullen

---

## Revolut (`c/revolut`)

_Laag 2 · Uitvoering · Bank · Aanwezig · Revolut Business_

### Uitleg

**Rol in de architectuur.** Betalingsverkeer en bankkoppeling richting Moneybird.

**Identifiers.** —

**Entiteiten.** Factuur

**Herkomst.** Aanlevering Robbie, 25-08-2026

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| uit | Transacties voor afletteren | te valideren | moneybird | bankkoppeling | dagelijks |

### JSON

`MODEL.componenten[id = "revolut"]`

```json
{
  "id": "revolut",
  "groep": "core",
  "rol": "Bank",
  "naam": "Revolut",
  "leverancier": "Revolut Business",
  "status": "live",
  "statusLabel": "Aanwezig",
  "samenvatting": "Betalingsverkeer en bankkoppeling richting Moneybird.",
  "werk": "",
  "entiteiten": [
    "factuur"
  ],
  "stromen": [
    {
      "richting": "uit",
      "met": "moneybird",
      "wat": "Transacties voor afletteren",
      "type": "bankkoppeling",
      "frequentie": "dagelijks",
      "status": "te valideren"
    }
  ],
  "identifiers": "—",
  "vragen": [],
  "documenten": [
    {
      "type": "link",
      "titel": "Revolut Business",
      "ref": "https://www.revolut.com/business/"
    }
  ],
  "herkomst": "Aanlevering Robbie, 25-08-2026"
}
```

### Documenten

- **Revolut Business** (link) — https://www.revolut.com/business/

**Vervolgstappen die dit onderdeel raken.** 3 · Keten en applicatie-gaps invullen

---

## Metaview (wellicht) (`c/metaview`)

_Laag 2 · Uitvoering · Gespreksnotities · Te onderzoeken · Metaview_

### Uitleg

**Rol in de architectuur.** Intake- en kwalificatiegesprekken met professionals en opdrachtgevers opnemen en gestructureerd naar de datalaag schrijven voor betere matching. Nog te onderzoeken of Metaview de juiste keuze is.

**Waar werk in zit.** Onderzoek: kosten, integratie met Spott.io en Teams, AVG (opname-toestemming), datalocatie.

**Identifiers.** Gesprek koppelen aan professional-ID en aanvraag-ID.

**Entiteiten.** Professional, Opdrachtgever, Aanvraag / vacature

**Open vragen.**

- Is Metaview de juiste keuze, of een alternatief?
- Toestemming en bewaartermijn van opnames (AVG).

**Herkomst.** Aanlevering Robbie, 25-08-2026 ('wellicht, moet nog onderzocht worden')

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| uit | Gespreksnotities en gestructureerde kenmerken bij de professional/aanvraag | open | spott | integratie (te onderzoeken) | per gesprek |
| uit | Transcript + gestructureerde extractie | open | datalaag | API/export | per gesprek |

### JSON

`MODEL.componenten[id = "metaview"]`

```json
{
  "id": "metaview",
  "groep": "core",
  "rol": "Gespreksnotities",
  "naam": "Metaview (wellicht)",
  "leverancier": "Metaview",
  "status": "open",
  "statusLabel": "Te onderzoeken",
  "samenvatting": "Intake- en kwalificatiegesprekken met professionals en opdrachtgevers opnemen en gestructureerd naar de datalaag schrijven voor betere matching. Nog te onderzoeken of Metaview de juiste keuze is.",
  "werk": "Onderzoek: kosten, integratie met Spott.io en Teams, AVG (opname-toestemming), datalocatie.",
  "entiteiten": [
    "professional",
    "opdrachtgever",
    "aanvraag"
  ],
  "stromen": [
    {
      "richting": "uit",
      "met": "spott",
      "wat": "Gespreksnotities en gestructureerde kenmerken bij de professional/aanvraag",
      "type": "integratie (te onderzoeken)",
      "frequentie": "per gesprek",
      "status": "open"
    },
    {
      "richting": "uit",
      "met": "datalaag",
      "wat": "Transcript + gestructureerde extractie",
      "type": "API/export",
      "frequentie": "per gesprek",
      "status": "open"
    }
  ],
  "identifiers": "Gesprek koppelen aan professional-ID en aanvraag-ID.",
  "vragen": [
    "Is Metaview de juiste keuze, of een alternatief?",
    "Toestemming en bewaartermijn van opnames (AVG)."
  ],
  "documenten": [
    {
      "type": "link",
      "titel": "Metaview",
      "ref": "https://www.metaview.ai"
    }
  ],
  "herkomst": "Aanlevering Robbie, 25-08-2026 ('wellicht, moet nog onderzocht worden')"
}
```

### Documenten

- **Metaview** (link) — https://www.metaview.ai

**Vervolgstappen die dit onderdeel raken.** 3 · Keten en applicatie-gaps invullen

---

## Nog geen keten (`c/koppelingen`)

_Laag 2 · Uitvoering · Huidige koppelingen · Aanname — te valideren · —_

### Uitleg

**Rol in de architectuur.** Job Intelligence v1 is vandaag de enige geautomatiseerde datastroom; alle overige systemen staan los van elkaar.

**Waar werk in zit.** De keten aanvraag (Job Intelligence) → voorstel en plaatsing (Spott.io) → contract en verloning (Please) → factuur (Moneybird) → betaling (Revolut) ontwerpen als één samenhangend proces met gedeelde identifiers.

**Identifiers.** Plaatsing-ID loopt door de hele keten mee.

**Entiteiten.** Aanvraag / vacature, Voorstel, Plaatsing, Contract, Factuur

**Open vragen.**

- Welke koppelingen bestaan er vandaag al (bv. Revolut ↔ Moneybird)?

**Herkomst.** Aanname Claude op basis van aanlevering; door Robbie te valideren

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| uit | Aanvraag → voorstel/plaatsing | to-be | spott | te ontwerpen | — |
| uit | Plaatsing → contract/verloning | to-be | please | te ontwerpen | — |
| uit | Contract/uren → factuur | to-be | moneybird | te ontwerpen | — |
| uit | Factuur → betaling | te valideren | revolut | bankkoppeling | — |

### JSON

`MODEL.componenten[id = "koppelingen"]`

```json
{
  "id": "koppelingen",
  "groep": "core",
  "breed": true,
  "rol": "Huidige koppelingen",
  "naam": "Nog geen keten",
  "leverancier": "—",
  "status": "werk",
  "statusLabel": "Aanname — te valideren",
  "samenvatting": "Job Intelligence v1 is vandaag de enige geautomatiseerde datastroom; alle overige systemen staan los van elkaar.",
  "werk": "De keten aanvraag (Job Intelligence) → voorstel en plaatsing (Spott.io) → contract en verloning (Please) → factuur (Moneybird) → betaling (Revolut) ontwerpen als één samenhangend proces met gedeelde identifiers.",
  "entiteiten": [
    "aanvraag",
    "voorstel",
    "plaatsing",
    "contract",
    "factuur"
  ],
  "stromen": [
    {
      "richting": "uit",
      "met": "spott",
      "wat": "Aanvraag → voorstel/plaatsing",
      "type": "te ontwerpen",
      "frequentie": "—",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "please",
      "wat": "Plaatsing → contract/verloning",
      "type": "te ontwerpen",
      "frequentie": "—",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "moneybird",
      "wat": "Contract/uren → factuur",
      "type": "te ontwerpen",
      "frequentie": "—",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "revolut",
      "wat": "Factuur → betaling",
      "type": "bankkoppeling",
      "frequentie": "—",
      "status": "te valideren"
    }
  ],
  "identifiers": "Plaatsing-ID loopt door de hele keten mee.",
  "vragen": [
    "Welke koppelingen bestaan er vandaag al (bv. Revolut ↔ Moneybird)?"
  ],
  "documenten": [],
  "herkomst": "Aanname Claude op basis van aanlevering; door Robbie te valideren"
}
```

### Documenten

_—_

---

## Unieke identifiers (`c/identifiers`)

_Laag 2 · Uitvoering · Eén taal · Afspraak · —_

### Uitleg

**Rol in de architectuur.** Elke professional, opdrachtgever, aanvraag, broker/platform en plaatsing heeft één uniek ID dat in álle core-systemen wordt meegegeven. Dat is de afspraak die de datalaag betrouwbaar maakt — zonder gedeelde identifiers geen bruikbare koppeling van bronnen.

**Waar werk in zit.** De Spott.io-inrichting en de Job Intelligence-specificatie zijn hét moment om de identifier-afspraak vanaf het begin in te voeren — er is nog geen legacy om te migreren.

**Identifiers.** Voorstel: UUID per entiteit uitgegeven door de datalaag; systeem-ID's (Spott, Moneybird, bron-referenties) als aliassen in een mappingtabel.

**Entiteiten.** Professional, Opdrachtgever, Aanvraag / vacature, Bron / platform, Plaatsing

**Open vragen.**

- Wie geeft de sleutel uit: het ATS of de datalaag?

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

**Entiteiten in de gecureerde zone.**

| Entiteit | Bronsysteem | Kenmerken (concept) | Status |
| --- | --- | --- | --- |
| Professional | spott | professional_id, naam, e-mail, linkedin_url, skills, beschikbaarheid, tariefindicatie, inhuurvorm | concept |
| Opdrachtgever | spott | opdrachtgever_id, naam, kvk, domein, type (eindklant/broker/MSP) | concept |
| Aanvraag / vacature | ji | aanvraag_id, bron_id, bron_referentie, titel, opdrachtgever, locatie, remote, uren_per_week, startdatum, einddatum, tarief_max, sluitingsdatum, inhuurvorm, eisen, wensen, status, raw_payload_ref | concept — generiek vs. bron-specifiek nog te bepalen |
| Bron / platform | ji | bron_id, naam, categorie, website, ingestie, polling, login_vereist, voorwaarden | concept |
| Plaatsing | spott | plaatsing_id, voorstel_id, start, einde, tarief_verkoop, tarief_inkoop, marge, contract_id | concept |

### JSON

`MODEL.componenten[id = "identifiers"]`

```json
{
  "id": "identifiers",
  "groep": "core",
  "breed": true,
  "rol": "Eén taal",
  "naam": "Unieke identifiers",
  "leverancier": "—",
  "status": "ink",
  "statusLabel": "Afspraak",
  "samenvatting": "Elke professional, opdrachtgever, aanvraag, broker/platform en plaatsing heeft één uniek ID dat in álle core-systemen wordt meegegeven. Dat is de afspraak die de datalaag betrouwbaar maakt — zonder gedeelde identifiers geen bruikbare koppeling van bronnen.",
  "werk": "De Spott.io-inrichting en de Job Intelligence-specificatie zijn hét moment om de identifier-afspraak vanaf het begin in te voeren — er is nog geen legacy om te migreren.",
  "entiteiten": [
    "professional",
    "opdrachtgever",
    "aanvraag",
    "bron",
    "plaatsing"
  ],
  "stromen": [],
  "identifiers": "Voorstel: UUID per entiteit uitgegeven door de datalaag; systeem-ID's (Spott, Moneybird, bron-referenties) als aliassen in een mappingtabel.",
  "vragen": [
    "Wie geeft de sleutel uit: het ATS of de datalaag?"
  ],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

---

## Laag: Datalaag (`g/data`)

_Laag 1 · Fundament · status: Nu niet aanwezig — gepland_

### Uitleg

**Wat deze laag doet.** Eén centrale plek waar alle data uit het ecosysteem samenkomt, gekoppeld en bruikbaar — cloud-agnostisch opgezet

**Laaglogica.** Alles begint bij één centrale, schone datalaag; zonder dit fundament blijft elke AI-toepassing gokwerk.

**Onderdelen (5).**

| Rol | Invulling | Status |
| --- | --- | --- |
| Data warehouse / lakehouse | Postgres + object storage | Gepland |
| Instroom & pipelines | Pipelines | Gepland |
| Sleutelbeheer | Sleutelbeheer | Gepland |
| Datakwaliteit & governance | Datakwaliteit & governance | Gepland |
| Gecureerde zone | Datamodel als definitielaag | Startpunt beschikbaar |

### JSON

`MODEL.groepen[id = "data"]`

```json
{
  "id": "data",
  "laag": 1,
  "naam": "Datalaag",
  "kicker": "Laag 1 · Fundament",
  "status": "nieuw",
  "statusLabel": "Nu niet aanwezig — gepland",
  "sub": "Eén centrale plek waar alle data uit het ecosysteem samenkomt, gekoppeld en bruikbaar — cloud-agnostisch opgezet",
  "logica": "Alles begint bij één centrale, schone datalaag; zonder dit fundament blijft elke AI-toepassing gokwerk.",
  "componenten": [
    "dwh",
    "pipelines",
    "sleutels",
    "kwaliteit",
    "gecureerd"
  ]
}
```

## Postgres + object storage (`c/dwh`)

_Laag 1 · Fundament · Data warehouse / lakehouse · Gepland · Cloud-agnostisch_

### Uitleg

**Rol in de architectuur.** Centrale opslag in zones — van ruw via geschoond naar gecureerd — zodat de lake geen moeras wordt. De single source waarop agents, matching en rapportage bouwen.

**Waar werk in zit.** Gekozen richting: Postgres + object storage in open formaten; exacte DWH-technologie nog te kiezen.

**Identifiers.** Datalaag bewaart de mapping tussen systeem-ID's en de eigen sleutel per entiteit.

**Entiteiten.** Aanvraag / vacature, Professional, Opdrachtgever, Plaatsing, Bron / platform

**Open vragen.**

- Managed Postgres (Supabase/Neon/RDS) of eigen beheer?
- Zones: raw / staging / gecureerd — welke formaten (Parquet/JSON)?

**Herkomst.** Eerder besproken cloud-agnostische stack; bevestigd door Robbie 25-08-2026

### Data & stromen

| richting | wat | status | met | type | frequentie |
| --- | --- | --- | --- | --- | --- |
| in | Eerste bron: aanvragen (raw + gecureerd) | to-be | ji | batch/upsert | per run |
| in | ATS-entiteiten en events | to-be | spott | API | continu |
| uit | BI, dashboards en search op de gecureerde zone | to-be | harness | SQL/query | on demand |

**Entiteiten in de gecureerde zone.**

| Entiteit | Bronsysteem | Kenmerken (concept) | Status |
| --- | --- | --- | --- |
| Aanvraag / vacature | ji | aanvraag_id, bron_id, bron_referentie, titel, opdrachtgever, locatie, remote, uren_per_week, startdatum, einddatum, tarief_max, sluitingsdatum, inhuurvorm, eisen, wensen, status, raw_payload_ref | concept — generiek vs. bron-specifiek nog te bepalen |
| Professional | spott | professional_id, naam, e-mail, linkedin_url, skills, beschikbaarheid, tariefindicatie, inhuurvorm | concept |
| Opdrachtgever | spott | opdrachtgever_id, naam, kvk, domein, type (eindklant/broker/MSP) | concept |
| Plaatsing | spott | plaatsing_id, voorstel_id, start, einde, tarief_verkoop, tarief_inkoop, marge, contract_id | concept |
| Bron / platform | ji | bron_id, naam, categorie, website, ingestie, polling, login_vereist, voorwaarden | concept |

### JSON

`MODEL.componenten[id = "dwh"]`

```json
{
  "id": "dwh",
  "groep": "data",
  "rol": "Data warehouse / lakehouse",
  "naam": "Postgres + object storage",
  "leverancier": "Cloud-agnostisch",
  "status": "nieuw",
  "statusLabel": "Gepland",
  "samenvatting": "Centrale opslag in zones — van ruw via geschoond naar gecureerd — zodat de lake geen moeras wordt. De single source waarop agents, matching en rapportage bouwen.",
  "werk": "Gekozen richting: Postgres + object storage in open formaten; exacte DWH-technologie nog te kiezen.",
  "entiteiten": [
    "aanvraag",
    "professional",
    "opdrachtgever",
    "plaatsing",
    "bron"
  ],
  "stromen": [
    {
      "richting": "in",
      "met": "ji",
      "wat": "Eerste bron: aanvragen (raw + gecureerd)",
      "type": "batch/upsert",
      "frequentie": "per run",
      "status": "to-be"
    },
    {
      "richting": "in",
      "met": "spott",
      "wat": "ATS-entiteiten en events",
      "type": "API",
      "frequentie": "continu",
      "status": "to-be"
    },
    {
      "richting": "uit",
      "met": "harness",
      "wat": "BI, dashboards en search op de gecureerde zone",
      "type": "SQL/query",
      "frequentie": "on demand",
      "status": "to-be"
    }
  ],
  "identifiers": "Datalaag bewaart de mapping tussen systeem-ID's en de eigen sleutel per entiteit.",
  "vragen": [
    "Managed Postgres (Supabase/Neon/RDS) of eigen beheer?",
    "Zones: raw / staging / gecureerd — welke formaten (Parquet/JSON)?"
  ],
  "documenten": [
    {
      "type": "doc",
      "titel": "Projectdoc Job Intelligence — DWH-integratie",
      "ref": "projects/vacature-scraper.md"
    }
  ],
  "herkomst": "Eerder besproken cloud-agnostische stack; bevestigd door Robbie 25-08-2026"
}
```

### Documenten

- **Projectdoc Job Intelligence — DWH-integratie** (doc) — projects/vacature-scraper.md

**Vervolgstappen die dit onderdeel raken.** 1 · Job Intelligence specificeren, 2 · Datalaag & identifiers neerzetten

---

## Pipelines (`c/pipelines`)

_Laag 1 · Fundament · Instroom & pipelines · Gepland · Eigen_

### Uitleg

**Rol in de architectuur.** Koppelingen vullen de datalaag continu vanuit de core-systemen en externe bronnen. Job Intelligence wordt de eerste bron; Spott.io, Clay en Please volgen.

**Waar werk in zit.** Per bron koppeltype, richting en frequentie vaststellen (deep dive datastromen).

**Identifiers.** Elke run schrijft run-metadata (bron, tijdstip, aantal records, fouten).

**Entiteiten.** —

**Open vragen.**

- Orkestratie: cron, Airflow/Dagster, of scheduler binnen de eigen module?

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "pipelines"]`

```json
{
  "id": "pipelines",
  "groep": "data",
  "rol": "Instroom & pipelines",
  "naam": "Pipelines",
  "leverancier": "Eigen",
  "status": "nieuw",
  "statusLabel": "Gepland",
  "samenvatting": "Koppelingen vullen de datalaag continu vanuit de core-systemen en externe bronnen. Job Intelligence wordt de eerste bron; Spott.io, Clay en Please volgen.",
  "werk": "Per bron koppeltype, richting en frequentie vaststellen (deep dive datastromen).",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "Elke run schrijft run-metadata (bron, tijdstip, aantal records, fouten).",
  "vragen": [
    "Orkestratie: cron, Airflow/Dagster, of scheduler binnen de eigen module?"
  ],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

---

## Sleutelbeheer (`c/sleutels`)

_Laag 1 · Fundament · Sleutelbeheer · Gepland · Eigen_

### Uitleg

**Rol in de architectuur.** Bewaakt dat de unieke identifiers uit laag 2 overal kloppen en records uit verschillende bronnen aan elkaar geknoopt kunnen worden — inclusief ontdubbeling van dezelfde aanvraag via meerdere brokers.

**Waar werk in zit.** Identifier-afspraak vastleggen vóór de Spott.io-inrichting.

**Identifiers.** Eén ID per professional, opdrachtgever, aanvraag, broker/platform en plaatsing; systeem-ID's als aliassen.

**Entiteiten.** Aanvraag / vacature, Professional, Opdrachtgever, Plaatsing

**Open vragen.**

- Wie geeft de sleutel uit: het ATS of de datalaag?

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

**Entiteiten in de gecureerde zone.**

| Entiteit | Bronsysteem | Kenmerken (concept) | Status |
| --- | --- | --- | --- |
| Aanvraag / vacature | ji | aanvraag_id, bron_id, bron_referentie, titel, opdrachtgever, locatie, remote, uren_per_week, startdatum, einddatum, tarief_max, sluitingsdatum, inhuurvorm, eisen, wensen, status, raw_payload_ref | concept — generiek vs. bron-specifiek nog te bepalen |
| Professional | spott | professional_id, naam, e-mail, linkedin_url, skills, beschikbaarheid, tariefindicatie, inhuurvorm | concept |
| Opdrachtgever | spott | opdrachtgever_id, naam, kvk, domein, type (eindklant/broker/MSP) | concept |
| Plaatsing | spott | plaatsing_id, voorstel_id, start, einde, tarief_verkoop, tarief_inkoop, marge, contract_id | concept |

### JSON

`MODEL.componenten[id = "sleutels"]`

```json
{
  "id": "sleutels",
  "groep": "data",
  "rol": "Sleutelbeheer",
  "naam": "Sleutelbeheer",
  "leverancier": "Eigen",
  "status": "nieuw",
  "statusLabel": "Gepland",
  "samenvatting": "Bewaakt dat de unieke identifiers uit laag 2 overal kloppen en records uit verschillende bronnen aan elkaar geknoopt kunnen worden — inclusief ontdubbeling van dezelfde aanvraag via meerdere brokers.",
  "werk": "Identifier-afspraak vastleggen vóór de Spott.io-inrichting.",
  "entiteiten": [
    "aanvraag",
    "professional",
    "opdrachtgever",
    "plaatsing"
  ],
  "stromen": [],
  "identifiers": "Eén ID per professional, opdrachtgever, aanvraag, broker/platform en plaatsing; systeem-ID's als aliassen.",
  "vragen": [
    "Wie geeft de sleutel uit: het ATS of de datalaag?"
  ],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

**Vervolgstappen die dit onderdeel raken.** 2 · Datalaag & identifiers neerzetten

---

## Datakwaliteit & governance (`c/kwaliteit`)

_Laag 1 · Fundament · Datakwaliteit & governance · Gepland · Eigen_

### Uitleg

**Rol in de architectuur.** Meten, schonen en bewaken bij de bron — inclusief retentie- en verwijderbeleid, zodat AI op schone én rechtmatige data draait.

**Waar werk in zit.** Retentie per entiteit (o.a. gescrapete vacatures, persoonsgegevens in aanvragen) technisch afdwingen.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "kwaliteit"]`

```json
{
  "id": "kwaliteit",
  "groep": "data",
  "rol": "Datakwaliteit & governance",
  "naam": "Datakwaliteit & governance",
  "leverancier": "Eigen",
  "status": "nieuw",
  "statusLabel": "Gepland",
  "samenvatting": "Meten, schonen en bewaken bij de bron — inclusief retentie- en verwijderbeleid, zodat AI op schone én rechtmatige data draait.",
  "werk": "Retentie per entiteit (o.a. gescrapete vacatures, persoonsgegevens in aanvragen) technisch afdwingen.",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

---

## Datamodel als definitielaag (`c/gecureerd`)

_Laag 1 · Fundament · Gecureerde zone · Startpunt beschikbaar · Eigen_

### Uitleg

**Rol in de architectuur.** De gecureerde zone spreekt de taal van het bedrijf — professional, aanvraag/vacature, opdrachtgever, broker/platform, plaatsing — met eenduidige definities per veld.

**Waar werk in zit.** Het canonieke vacature-model uit de Job Intelligence-specificatie is het startpunt; de overige entiteiten volgen bij de Spott.io-inrichting.

**Identifiers.** Definitie per veld; bron-specifieke velden apart van het canonieke model.

**Entiteiten.** Professional, Aanvraag / vacature, Opdrachtgever, Bron / platform, Voorstel, Plaatsing, Contract, Factuur

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

**Entiteiten in de gecureerde zone.**

| Entiteit | Bronsysteem | Kenmerken (concept) | Status |
| --- | --- | --- | --- |
| Professional | spott | professional_id, naam, e-mail, linkedin_url, skills, beschikbaarheid, tariefindicatie, inhuurvorm | concept |
| Aanvraag / vacature | ji | aanvraag_id, bron_id, bron_referentie, titel, opdrachtgever, locatie, remote, uren_per_week, startdatum, einddatum, tarief_max, sluitingsdatum, inhuurvorm, eisen, wensen, status, raw_payload_ref | concept — generiek vs. bron-specifiek nog te bepalen |
| Opdrachtgever | spott | opdrachtgever_id, naam, kvk, domein, type (eindklant/broker/MSP) | concept |
| Bron / platform | ji | bron_id, naam, categorie, website, ingestie, polling, login_vereist, voorwaarden | concept |
| Voorstel | spott | voorstel_id, aanvraag_id, professional_id, tarief, status, uitkomst, reden | concept |
| Plaatsing | spott | plaatsing_id, voorstel_id, start, einde, tarief_verkoop, tarief_inkoop, marge, contract_id | concept |
| Contract | please | contract_id, plaatsing_id, partij, looptijd, status | concept |
| Factuur | moneybird | factuur_id, plaatsing_id, bedrag, periode, betaalstatus | concept |

### JSON

`MODEL.componenten[id = "gecureerd"]`

```json
{
  "id": "gecureerd",
  "groep": "data",
  "breed": true,
  "rol": "Gecureerde zone",
  "naam": "Datamodel als definitielaag",
  "leverancier": "Eigen",
  "status": "nieuw",
  "statusLabel": "Startpunt beschikbaar",
  "samenvatting": "De gecureerde zone spreekt de taal van het bedrijf — professional, aanvraag/vacature, opdrachtgever, broker/platform, plaatsing — met eenduidige definities per veld.",
  "werk": "Het canonieke vacature-model uit de Job Intelligence-specificatie is het startpunt; de overige entiteiten volgen bij de Spott.io-inrichting.",
  "entiteiten": [
    "professional",
    "aanvraag",
    "opdrachtgever",
    "bron",
    "voorstel",
    "plaatsing",
    "contract",
    "factuur"
  ],
  "stromen": [],
  "identifiers": "Definitie per veld; bron-specifieke velden apart van het canonieke model.",
  "vragen": [],
  "documenten": [
    {
      "type": "doc",
      "titel": "Projectdoc Job Intelligence — canoniek datamodel",
      "ref": "projects/vacature-scraper.md"
    }
  ],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

- **Projectdoc Job Intelligence — canoniek datamodel** (doc) — projects/vacature-scraper.md

**Vervolgstappen die dit onderdeel raken.** 1 · Job Intelligence specificeren

---

## Laag: Compliance & security (`g/compliance`)

_Over alle lagen heen · status: Randvoorwaarde_

### Uitleg

**Wat deze laag doet.** Randvoorwaarden, dwars door elke laag

**Laaglogica.** AVG, EU AI Act (matching = hoog risico), identiteit & toegang voor mensen én agents, centrale audit/logging via het Company OS, en bronvoorwaarden & arbeidsrecht voor staffing.

**Onderdelen (5).**

| Rol | Invulling | Status |
| --- | --- | --- |
| AVG / GDPR | AVG / GDPR | Randvoorwaarde |
| EU AI Act | EU AI Act | Hoog risico |
| Identiteit & toegang | Identiteit & toegang | Randvoorwaarde |
| Audit & logging | Audit & logging | Randvoorwaarde |
| Bronvoorwaarden & arbeidsrecht | Bronvoorwaarden & arbeidsrecht | Randvoorwaarde |

### JSON

`MODEL.groepen[id = "compliance"]`

```json
{
  "id": "compliance",
  "laag": 0,
  "naam": "Compliance & security",
  "kicker": "Over alle lagen heen",
  "status": "dwars",
  "statusLabel": "Randvoorwaarde",
  "sub": "Randvoorwaarden, dwars door elke laag",
  "logica": "AVG, EU AI Act (matching = hoog risico), identiteit & toegang voor mensen én agents, centrale audit/logging via het Company OS, en bronvoorwaarden & arbeidsrecht voor staffing.",
  "componenten": [
    "avg",
    "aiact",
    "iam",
    "audit",
    "bronvoorwaarden"
  ]
}
```

## AVG / GDPR (`c/avg`)

_Over alle lagen heen · AVG / GDPR · Randvoorwaarde · —_

### Uitleg

**Rol in de architectuur.** Verwerkingsregister, grondslagen en verwerkersovereenkomsten op orde — ook voor professionals in de community en voor gescrapete vacaturedata; retentie- en verwijderbeleid technisch afdwingbaar in de datalaag.

**Waar werk in zit.** Verwerkingsregister opstellen; retentie per entiteit in de datalaag.

**Identifiers.** —

**Entiteiten.** Professional, Aanvraag / vacature

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "avg"]`

```json
{
  "id": "avg",
  "groep": "compliance",
  "rol": "AVG / GDPR",
  "naam": "AVG / GDPR",
  "leverancier": "—",
  "status": "dwars",
  "statusLabel": "Randvoorwaarde",
  "samenvatting": "Verwerkingsregister, grondslagen en verwerkersovereenkomsten op orde — ook voor professionals in de community en voor gescrapete vacaturedata; retentie- en verwijderbeleid technisch afdwingbaar in de datalaag.",
  "werk": "Verwerkingsregister opstellen; retentie per entiteit in de datalaag.",
  "entiteiten": [
    "professional",
    "aanvraag"
  ],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

---

## EU AI Act (`c/aiact`)

_Over alle lagen heen · EU AI Act · Hoog risico · —_

### Uitleg

**Rol in de architectuur.** AI-gedreven matching van professionals op aanvragen valt onder werkgelegenheid en daarmee vrijwel zeker in de hoog-risicocategorie: aantoonbare menselijke oversight, transparantie richting professionals en technische documentatie zijn verplicht.

**Waar werk in zit.** Compliance/AI Act onderzoeken (open actie uit de focus-sessie).

**Identifiers.** —

**Entiteiten.** Professional, Voorstel

**Open vragen.**

- Welke onderdelen van matching blijven expliciet mensbesluiten?

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "aiact"]`

```json
{
  "id": "aiact",
  "groep": "compliance",
  "rol": "EU AI Act",
  "naam": "EU AI Act",
  "leverancier": "—",
  "status": "open",
  "statusLabel": "Hoog risico",
  "samenvatting": "AI-gedreven matching van professionals op aanvragen valt onder werkgelegenheid en daarmee vrijwel zeker in de hoog-risicocategorie: aantoonbare menselijke oversight, transparantie richting professionals en technische documentatie zijn verplicht.",
  "werk": "Compliance/AI Act onderzoeken (open actie uit de focus-sessie).",
  "entiteiten": [
    "professional",
    "voorstel"
  ],
  "stromen": [],
  "identifiers": "—",
  "vragen": [
    "Welke onderdelen van matching blijven expliciet mensbesluiten?"
  ],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

---

## Identiteit & toegang (`c/iam`)

_Over alle lagen heen · Identiteit & toegang · Randvoorwaarde · Microsoft Entra_

### Uitleg

**Rol in de architectuur.** Mensen én agents zijn identiteiten met eigen rechten (autorisatiematrix, SSO via Microsoft 365). Een agent handelt nooit anoniem — elke actie hangt aan een identiteit en een verantwoordelijke.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "iam"]`

```json
{
  "id": "iam",
  "groep": "compliance",
  "rol": "Identiteit & toegang",
  "naam": "Identiteit & toegang",
  "leverancier": "Microsoft Entra",
  "status": "dwars",
  "statusLabel": "Randvoorwaarde",
  "samenvatting": "Mensen én agents zijn identiteiten met eigen rechten (autorisatiematrix, SSO via Microsoft 365). Een agent handelt nooit anoniem — elke actie hangt aan een identiteit en een verantwoordelijke.",
  "werk": "",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

---

## Audit & logging (`c/audit`)

_Over alle lagen heen · Audit & logging · Randvoorwaarde · Company OS_

### Uitleg

**Rol in de architectuur.** Elke actie herleidbaar: wie of welke agent deed wat, in welk systeem, op basis van welke data. Het Company OS is de plek waar dit centraal wordt vastgelegd.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** FUUSE-doelplaat

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "audit"]`

```json
{
  "id": "audit",
  "groep": "compliance",
  "rol": "Audit & logging",
  "naam": "Audit & logging",
  "leverancier": "Company OS",
  "status": "dwars",
  "statusLabel": "Randvoorwaarde",
  "samenvatting": "Elke actie herleidbaar: wie of welke agent deed wat, in welk systeem, op basis van welke data. Het Company OS is de plek waar dit centraal wordt vastgelegd.",
  "werk": "",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat"
}
```

### Documenten

_—_

---

## Bronvoorwaarden & arbeidsrecht (`c/bronvoorwaarden`)

_Over alle lagen heen · Bronvoorwaarden & arbeidsrecht · Randvoorwaarde · —_

### Uitleg

**Rol in de architectuur.** Gebruiksvoorwaarden van de vacaturebronnen (portalen, brokers, werkenbij-sites) per bron vastgelegd; detacheringsregels en certificering (SNA) lopen via het Please-traject.

**Waar werk in zit.** Per bron voorwaarden en AVG-implicaties vastleggen in het bronnenregister.

**Identifiers.** —

**Entiteiten.** Bron / platform

**Herkomst.** Toegevoegd voor Catapulze (staffing-specifiek)

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "bronvoorwaarden"]`

```json
{
  "id": "bronvoorwaarden",
  "groep": "compliance",
  "rol": "Bronvoorwaarden & arbeidsrecht",
  "naam": "Bronvoorwaarden & arbeidsrecht",
  "leverancier": "—",
  "status": "dwars",
  "statusLabel": "Randvoorwaarde",
  "samenvatting": "Gebruiksvoorwaarden van de vacaturebronnen (portalen, brokers, werkenbij-sites) per bron vastgelegd; detacheringsregels en certificering (SNA) lopen via het Please-traject.",
  "werk": "Per bron voorwaarden en AVG-implicaties vastleggen in het bronnenregister.",
  "entiteiten": [
    "bron"
  ],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [
    {
      "type": "doc",
      "titel": "Bronnenregister",
      "ref": "projects/vacature-scraper-bronnen.md"
    }
  ],
  "herkomst": "Toegevoegd voor Catapulze (staffing-specifiek)"
}
```

### Documenten

- **Bronnenregister** (doc) — projects/vacature-scraper-bronnen.md

---

## Laag: Harness (`g/harness`)

_Over alle lagen heen · status: AI-toegangslaag_

### Uitleg

**Wat deze laag doet.** AI-toegangslaag voor mensen

**Laaglogica.** De menselijke ingang tot het geheel, dwars door alle lagen, inwisselbaar van leverancier; klassieke BI en dashboards bestaan ernaast, rechtstreeks op de gecureerde datazone.

**Onderdelen (4).**

| Rol | Invulling | Status |
| --- | --- | --- |
| Eén gesprek met het hele ecosysteem | Conversationele toegang | Deels aanwezig |
| Tool-agnostisch | Tool-agnostisch | Ontwerpprincipe |
| Via het Company OS | Via het Company OS | Ontwerpprincipe |
| Naast de harness: BI & dashboards | BI & dashboards | Nieuw op te bouwen |

### JSON

`MODEL.groepen[id = "harness"]`

```json
{
  "id": "harness",
  "laag": 0,
  "naam": "Harness",
  "kicker": "Over alle lagen heen",
  "status": "dwars",
  "statusLabel": "AI-toegangslaag",
  "sub": "AI-toegangslaag voor mensen",
  "logica": "De menselijke ingang tot het geheel, dwars door alle lagen, inwisselbaar van leverancier; klassieke BI en dashboards bestaan ernaast, rechtstreeks op de gecureerde datazone.",
  "componenten": [
    "gesprek",
    "toolagnostisch",
    "viaos",
    "bi"
  ]
}
```

## Conversationele toegang (`c/gesprek`)

_Over alle lagen heen · Eén gesprek met het hele ecosysteem · Deels aanwezig · Claude (inwisselbaar)_

### Uitleg

**Rol in de architectuur.** Robbie, Julian en het team stellen in gewone taal vragen en krijgen direct toegang tot alle data en systemen binnen het Catapulze-ecosysteem — zonder per applicatie in te loggen.

**Waar werk in zit.** Vandaag: Claude wordt al ingezet (dagvoorbereiding, mailrouting, Clay), maar zonder koppeling op een gedeelde datalaag.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** Aanlevering Robbie

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "gesprek"]`

```json
{
  "id": "gesprek",
  "groep": "harness",
  "rol": "Eén gesprek met het hele ecosysteem",
  "naam": "Conversationele toegang",
  "leverancier": "Claude (inwisselbaar)",
  "status": "werk",
  "statusLabel": "Deels aanwezig",
  "samenvatting": "Robbie, Julian en het team stellen in gewone taal vragen en krijgen direct toegang tot alle data en systemen binnen het Catapulze-ecosysteem — zonder per applicatie in te loggen.",
  "werk": "Vandaag: Claude wordt al ingezet (dagvoorbereiding, mailrouting, Clay), maar zonder koppeling op een gedeelde datalaag.",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "Aanlevering Robbie"
}
```

### Documenten

_—_

---

## Tool-agnostisch (`c/toolagnostisch`)

_Over alle lagen heen · Tool-agnostisch · Ontwerpprincipe · —_

### Uitleg

**Rol in de architectuur.** De harness is een AI-assistent naar keuze; welke dat is, is inwisselbaar. De waarde zit in de lagen eronder, niet in de assistent zelf.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** FUUSE-doelplaat

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "toolagnostisch"]`

```json
{
  "id": "toolagnostisch",
  "groep": "harness",
  "rol": "Tool-agnostisch",
  "naam": "Tool-agnostisch",
  "leverancier": "—",
  "status": "dwars",
  "statusLabel": "Ontwerpprincipe",
  "samenvatting": "De harness is een AI-assistent naar keuze; welke dat is, is inwisselbaar. De waarde zit in de lagen eronder, niet in de assistent zelf.",
  "werk": "",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat"
}
```

### Documenten

_—_

---

## Via het Company OS (`c/viaos`)

_Over alle lagen heen · Via het Company OS · Ontwerpprincipe · —_

### Uitleg

**Rol in de architectuur.** Ook de harness loopt via de besturingslaag: dezelfde koppelingen, dezelfde rechten, dezelfde logging als de agents.

**Identifiers.** —

**Entiteiten.** —

**Herkomst.** FUUSE-doelplaat

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "viaos"]`

```json
{
  "id": "viaos",
  "groep": "harness",
  "rol": "Via het Company OS",
  "naam": "Via het Company OS",
  "leverancier": "—",
  "status": "dwars",
  "statusLabel": "Ontwerpprincipe",
  "samenvatting": "Ook de harness loopt via de besturingslaag: dezelfde koppelingen, dezelfde rechten, dezelfde logging als de agents.",
  "werk": "",
  "entiteiten": [],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat"
}
```

### Documenten

_—_

---

## BI & dashboards (`c/bi`)

_Over alle lagen heen · Naast de harness: BI & dashboards · Nieuw op te bouwen · Te kiezen_

### Uitleg

**Rol in de architectuur.** Niet alle toegang is een gesprek — KPI-rapportage (aanvragen per bron, voorstellen, plaatsingen, marge) en de Job Intelligence-search draaien rechtstreeks op de gecureerde datazone.

**Waar werk in zit.** BI-tool kiezen; eerste dashboard: aanvragen per bron en scraper-gezondheid.

**Identifiers.** —

**Entiteiten.** Aanvraag / vacature, Plaatsing

**Herkomst.** FUUSE-doelplaat, toegepast op Catapulze

### Data & stromen

_Geen datastromen vastgelegd._

### JSON

`MODEL.componenten[id = "bi"]`

```json
{
  "id": "bi",
  "groep": "harness",
  "rol": "Naast de harness: BI & dashboards",
  "naam": "BI & dashboards",
  "leverancier": "Te kiezen",
  "status": "nieuw",
  "statusLabel": "Nieuw op te bouwen",
  "samenvatting": "Niet alle toegang is een gesprek — KPI-rapportage (aanvragen per bron, voorstellen, plaatsingen, marge) en de Job Intelligence-search draaien rechtstreeks op de gecureerde datazone.",
  "werk": "BI-tool kiezen; eerste dashboard: aanvragen per bron en scraper-gezondheid.",
  "entiteiten": [
    "aanvraag",
    "plaatsing"
  ],
  "stromen": [],
  "identifiers": "—",
  "vragen": [],
  "documenten": [],
  "herkomst": "FUUSE-doelplaat, toegepast op Catapulze"
}
```

### Documenten

_—_

---

## Vervolgstappen (`s/<nr>`)

### 1. Job Intelligence specificeren

Canoniek vacature-model (generiek vs. bron-specifiek), bronconfiguratie voor de 28 bronnen en werkenbij-sites, en het laadpatroon naar de datalaag. Dit is de eerste echte datastroom en bepaalt de vorm van de datalaag.

**Raakt.** Catapulze Job Intelligence, Postgres + object storage, Datamodel als definitielaag

**Parallel.** Direct oppakken, parallel aan stap 1: de Spott.io-inrichting starten met de identifier-afspraak erin, de SNA-certificering via het Please-traject regelen, en per vacaturebron de gebruiksvoorwaarden en AVG-implicaties vastleggen.

`MODEL.vervolgstappen[nr = 1]`

```json
{
  "nr": 1,
  "titel": "Job Intelligence specificeren",
  "tekst": "Canoniek vacature-model (generiek vs. bron-specifiek), bronconfiguratie voor de 28 bronnen en werkenbij-sites, en het laadpatroon naar de datalaag. Dit is de eerste echte datastroom en bepaalt de vorm van de datalaag.",
  "raakt": [
    "ji",
    "dwh",
    "gecureerd"
  ]
}
```

### 2. Datalaag & identifiers neerzetten

DWH-technologie kiezen binnen de cloud-agnostische stack, zones inrichten en de identifier-afspraak direct meenemen in de Spott.io-inrichting, zodat elke bron aan dezelfde professional, opdrachtgever en aanvraag hangt.

**Raakt.** Postgres + object storage, Sleutelbeheer, Spott.io

`MODEL.vervolgstappen[nr = 2]`

```json
{
  "nr": 2,
  "titel": "Datalaag & identifiers neerzetten",
  "tekst": "DWH-technologie kiezen binnen de cloud-agnostische stack, zones inrichten en de identifier-afspraak direct meenemen in de Spott.io-inrichting, zodat elke bron aan dezelfde professional, opdrachtgever en aanvraag hangt.",
  "raakt": [
    "dwh",
    "sleutels",
    "spott"
  ]
}
```

### 3. Keten en applicatie-gaps invullen

De keten Spott.io → Please → Moneybird → Revolut ontwerpen (koppeltype, richting, frequentie per stap) en het Metaview-onderzoek afronden: gesprekken gestructureerd naar de datalaag voor betere matching.

**Raakt.** Spott.io, Please, Moneybird, Revolut, Metaview (wellicht)

`MODEL.vervolgstappen[nr = 3]`

```json
{
  "nr": 3,
  "titel": "Keten en applicatie-gaps invullen",
  "tekst": "De keten Spott.io → Please → Moneybird → Revolut ontwerpen (koppeltype, richting, frequentie per stap) en het Metaview-onderzoek afronden: gesprekken gestructureerd naar de datalaag voor betere matching.",
  "raakt": [
    "spott",
    "please",
    "moneybird",
    "revolut",
    "metaview"
  ]
}
```

### 4. Company OS met feedback loop

De middellaag bouwen — MCP-koppelvlak, LangGraph/Pydantic AI, LiteLLM, memory en governance — als voorwaarde vóórdat agents (kwalificatie, matching, outreach) breed worden uitgerold en de harness op alle data wordt aangesloten.

**Raakt.** MCP-koppelvlak, Feedback loop & memory, LangGraph / Pydantic AI · LiteLLM, Observability & evals, Agents per procesgebied

`MODEL.vervolgstappen[nr = 4]`

```json
{
  "nr": 4,
  "titel": "Company OS met feedback loop",
  "tekst": "De middellaag bouwen — MCP-koppelvlak, LangGraph/Pydantic AI, LiteLLM, memory en governance — als voorwaarde vóórdat agents (kwalificatie, matching, outreach) breed worden uitgerold en de harness op alle data wordt aangesloten.",
  "raakt": [
    "mcp",
    "memory",
    "governance",
    "observability",
    "taakagents"
  ]
}
```
