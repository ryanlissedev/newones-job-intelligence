# Datamodel (entiteiten)

_Uitgelezen uit de artifact-bron (window `MODEL`) op 2026-08-27. Panel: Datamodel (entiteiten) → Overzicht._


## Gecureerde zone — de taal van het bedrijf

Conceptversie. Het canonieke vacature-model uit de Job Intelligence-specificatie is het startpunt; de overige entiteiten volgen bij de Spott.io-inrichting.

_8 entiteiten · concept_

| Entiteit | Bronsysteem | Kenmerken (concept) | Status |
| --- | --- | --- | --- |
| Professional | spott | professional_id, naam, e-mail, linkedin_url, skills, beschikbaarheid, tariefindicatie, inhuurvorm | concept |
| Opdrachtgever | spott | opdrachtgever_id, naam, kvk, domein, type (eindklant/broker/MSP) | concept |
| Aanvraag / vacature | ji | aanvraag_id, bron_id, bron_referentie, titel, opdrachtgever, locatie, remote, uren_per_week, startdatum, einddatum, tarief_max, sluitingsdatum, inhuurvorm, eisen, wensen, status, raw_payload_ref | concept — generiek vs. bron-specifiek nog te bepalen |
| Bron / platform | ji | bron_id, naam, categorie, website, ingestie, polling, login_vereist, voorwaarden | concept |
| Voorstel | spott | voorstel_id, aanvraag_id, professional_id, tarief, status, uitkomst, reden | concept |
| Plaatsing | spott | plaatsing_id, voorstel_id, start, einde, tarief_verkoop, tarief_inkoop, marge, contract_id | concept |
| Contract | please | contract_id, plaatsing_id, partij, looptijd, status | concept |
| Factuur | moneybird | factuur_id, plaatsing_id, bedrag, periode, betaalstatus | concept |

## Per entiteit

### Professional (`professional`)

**Omschrijving.** AI-engineer of platform engineer in de Catapulze-community (ZZP, detachering of via partner).

**Bronsysteem (system of record).** spott

**Kenmerken (concept).** `professional_id`, `naam`, `e-mail`, `linkedin_url`, `skills`, `beschikbaarheid`, `tariefindicatie`, `inhuurvorm`

**Status.** concept

**Gebruikt door.** Spott.io, Microsoft 365, LinkedIn, Clay, Please, Metaview (wellicht), Unieke identifiers, Postgres + object storage, Sleutelbeheer, Datamodel als definitielaag, Agents per procesgebied, AVG / GDPR, EU AI Act

### Opdrachtgever (`opdrachtgever`)

**Omschrijving.** Eindklant of intermediair waarvoor een aanvraag openstaat.

**Bronsysteem (system of record).** spott

**Kenmerken (concept).** `opdrachtgever_id`, `naam`, `kvk`, `domein`, `type (eindklant/broker/MSP)`

**Status.** concept

**Gebruikt door.** Spott.io, Catapulze Job Intelligence, Microsoft 365, Clay, Moneybird, Metaview (wellicht), Unieke identifiers, Postgres + object storage, Sleutelbeheer, Datamodel als definitielaag

### Aanvraag / vacature (`aanvraag`)

**Omschrijving.** Een opdracht of vacature uit een externe bron of rechtstreeks van een opdrachtgever — canoniek model uit Job Intelligence.

**Bronsysteem (system of record).** ji

**Kenmerken (concept).** `aanvraag_id`, `bron_id`, `bron_referentie`, `titel`, `opdrachtgever`, `locatie`, `remote`, `uren_per_week`, `startdatum`, `einddatum`, `tarief_max`, `sluitingsdatum`, `inhuurvorm`, `eisen`, `wensen`, `status`, `raw_payload_ref`

**Status.** concept — generiek vs. bron-specifiek nog te bepalen

**Gebruikt door.** Spott.io, Catapulze Job Intelligence, Metaview (wellicht), Nog geen keten, Unieke identifiers, Postgres + object storage, Sleutelbeheer, Datamodel als definitielaag, Agents per procesgebied, AVG / GDPR, BI & dashboards

### Bron / platform (`bron`)

**Omschrijving.** Externe vacaturebron: broker, MSP, overheidsportaal, jobboard of werkenbij-site.

**Bronsysteem (system of record).** ji

**Kenmerken (concept).** `bron_id`, `naam`, `categorie`, `website`, `ingestie`, `polling`, `login_vereist`, `voorwaarden`

**Status.** concept

**Gebruikt door.** Catapulze Job Intelligence, Unieke identifiers, Postgres + object storage, Datamodel als definitielaag, Bronvoorwaarden & arbeidsrecht

### Voorstel (`voorstel`)

**Omschrijving.** Een professional voorgesteld op een aanvraag, met uitkomst en reden.

**Bronsysteem (system of record).** spott

**Kenmerken (concept).** `voorstel_id`, `aanvraag_id`, `professional_id`, `tarief`, `status`, `uitkomst`, `reden`

**Status.** concept

**Gebruikt door.** Spott.io, Nog geen keten, Datamodel als definitielaag, Feedback loop & memory, Agents per procesgebied, EU AI Act

### Plaatsing (`plaatsing`)

**Omschrijving.** Een gewonnen voorstel: professional werkt bij opdrachtgever.

**Bronsysteem (system of record).** spott

**Kenmerken (concept).** `plaatsing_id`, `voorstel_id`, `start`, `einde`, `tarief_verkoop`, `tarief_inkoop`, `marge`, `contract_id`

**Status.** concept

**Gebruikt door.** Spott.io, Please, Nog geen keten, Unieke identifiers, Postgres + object storage, Sleutelbeheer, Datamodel als definitielaag, Feedback loop & memory, BI & dashboards

### Contract (`contract`)

**Omschrijving.** Contractering van een plaatsing (via Please of rechtstreeks).

**Bronsysteem (system of record).** please

**Kenmerken (concept).** `contract_id`, `plaatsing_id`, `partij`, `looptijd`, `status`

**Status.** concept

**Gebruikt door.** Please, Nog geen keten, Datamodel als definitielaag

### Factuur (`factuur`)

**Omschrijving.** Verkoop- of inkoopfactuur gekoppeld aan een plaatsing.

**Bronsysteem (system of record).** moneybird

**Kenmerken (concept).** `factuur_id`, `plaatsing_id`, `bedrag`, `periode`, `betaalstatus`

**Status.** concept

**Gebruikt door.** Please, Moneybird, Revolut, Nog geen keten, Datamodel als definitielaag

## JSON

`MODEL.entiteiten`

```json
[
  {
    "id": "professional",
    "naam": "Professional",
    "omschrijving": "AI-engineer of platform engineer in de Catapulze-community (ZZP, detachering of via partner).",
    "bronsysteem": "spott",
    "kenmerken": [
      "professional_id",
      "naam",
      "e-mail",
      "linkedin_url",
      "skills",
      "beschikbaarheid",
      "tariefindicatie",
      "inhuurvorm"
    ],
    "status": "concept"
  },
  {
    "id": "opdrachtgever",
    "naam": "Opdrachtgever",
    "omschrijving": "Eindklant of intermediair waarvoor een aanvraag openstaat.",
    "bronsysteem": "spott",
    "kenmerken": [
      "opdrachtgever_id",
      "naam",
      "kvk",
      "domein",
      "type (eindklant/broker/MSP)"
    ],
    "status": "concept"
  },
  {
    "id": "aanvraag",
    "naam": "Aanvraag / vacature",
    "omschrijving": "Een opdracht of vacature uit een externe bron of rechtstreeks van een opdrachtgever — canoniek model uit Job Intelligence.",
    "bronsysteem": "ji",
    "kenmerken": [
      "aanvraag_id",
      "bron_id",
      "bron_referentie",
      "titel",
      "opdrachtgever",
      "locatie",
      "remote",
      "uren_per_week",
      "startdatum",
      "einddatum",
      "tarief_max",
      "sluitingsdatum",
      "inhuurvorm",
      "eisen",
      "wensen",
      "status",
      "raw_payload_ref"
    ],
    "status": "concept — generiek vs. bron-specifiek nog te bepalen"
  },
  {
    "id": "bron",
    "naam": "Bron / platform",
    "omschrijving": "Externe vacaturebron: broker, MSP, overheidsportaal, jobboard of werkenbij-site.",
    "bronsysteem": "ji",
    "kenmerken": [
      "bron_id",
      "naam",
      "categorie",
      "website",
      "ingestie",
      "polling",
      "login_vereist",
      "voorwaarden"
    ],
    "status": "concept"
  },
  {
    "id": "voorstel",
    "naam": "Voorstel",
    "omschrijving": "Een professional voorgesteld op een aanvraag, met uitkomst en reden.",
    "bronsysteem": "spott",
    "kenmerken": [
      "voorstel_id",
      "aanvraag_id",
      "professional_id",
      "tarief",
      "status",
      "uitkomst",
      "reden"
    ],
    "status": "concept"
  },
  {
    "id": "plaatsing",
    "naam": "Plaatsing",
    "omschrijving": "Een gewonnen voorstel: professional werkt bij opdrachtgever.",
    "bronsysteem": "spott",
    "kenmerken": [
      "plaatsing_id",
      "voorstel_id",
      "start",
      "einde",
      "tarief_verkoop",
      "tarief_inkoop",
      "marge",
      "contract_id"
    ],
    "status": "concept"
  },
  {
    "id": "contract",
    "naam": "Contract",
    "omschrijving": "Contractering van een plaatsing (via Please of rechtstreeks).",
    "bronsysteem": "please",
    "kenmerken": [
      "contract_id",
      "plaatsing_id",
      "partij",
      "looptijd",
      "status"
    ],
    "status": "concept"
  },
  {
    "id": "factuur",
    "naam": "Factuur",
    "omschrijving": "Verkoop- of inkoopfactuur gekoppeld aan een plaatsing.",
    "bronsysteem": "moneybird",
    "kenmerken": [
      "factuur_id",
      "plaatsing_id",
      "bedrag",
      "periode",
      "betaalstatus"
    ],
    "status": "concept"
  }
]
```
