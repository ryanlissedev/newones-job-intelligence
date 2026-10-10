# Doelplaat-export — volledig (2026-08-27)

Bron: artifact "Catapulze Architectuur Explorer" (doelarchitectuur v1.1, 25-08-2026) — https://claude.ai/code/artifact/93692ad4-4974-4204-986b-d955d28576dc
Methode: Interceptor (echte Chrome, read-only) + iframe-bron opgehaald; JS-literals `MODEL`, `JI`, `JI_REQ` naar JSON gedumpt; `schema.json` gegenereerd met de artifact-eigen `jiSchema()`. Byte-identiek geverifieerd tegen de gerenderde panelen. Details: `EXTRACT_LOG.md`.

| Bestand | Inhoud | UI-paneel |
|---|---|---|
| `model.json` | Volledig model: 6 lagen, 33 componenten, 4 vervolgstappen, entiteiten, documenten, beslissingen | Volledig model (JSON) |
| `componenten.md` | Per laag/component/stap: Uitleg · Data & stromen · JSON · Documenten | zijpanelen `#g/…`, `#c/…`, `#s/…` |
| `documenten.md` | Documentenlijst (globaal + per component) | Documenten |
| `datamodel.md` | Entiteiten met velden en uitleg | Datamodel (entiteiten) |
| `beslissingen.json` / `.md` | Logboek (6 besluiten, 25-08) | Beslissingen |
| `spec.json` | Job Intelligence specificatie v0.2 (incl. bronnen) | Deep dive → JSON van de spec |
| `requirements.json` | Requirements v2 + mapping v1→v2 (authentiek; kopie in `../REQUIREMENTS_V2.json`) | Deep dive → JSON van de requirements |
| `schema.json` | JSON Schema van het canonieke `aanvraag`-model | Deep dive → JSON Schema |
| `deep-dive-overzicht.md` · `-pipeline.md` · `-datamodel.md` (75 velden) · `-datalaag.md` · `-config-stack.md` · `-fasen-compliance.md` · `-json-schema.md` · `-v1-analyse.md` | Zichtbare tekst per tab | Deep dive: Job Intelligence |
| `doelplaat-v1.1-tekst.md` | Volledige paginatekst van de hoofdplaat | hoofdplaat |

Niet apart geëxporteerd (zit in `spec.json` / `requirements.json` en in `../SOURCE_MATRIX.md`): tabs Bronnen, Requirements, Mapping v1 → v2. Download-knoppen niet gebruikt.

## Beslissingen (logboek, 25-08) met stand 28-08

| Beslissing | Toelichting | Stand 28-08 |
|---|---|---|
| Naam datastroom: Catapulze Job Intelligence | Losse module; platformen + werkenbij-sites; analyse/search erop | ongewijzigd |
| Eerst specificeren, dan bouwen (vanaf nul) | Spec beschrijft de eindsituatie, los van v1 | **heroverwogen**: v1-scrapers hergebruiken, spec groeit uit de slice |
| Uniforme datastructuur + DWH als harde eis | Essentieel voor Robbie | ongewijzigd; DWH = Postgres + DuckLake |
| Spott.io als ATS/CRM | Gekozen; inrichting volgt | ongewijzigd; contract (DEC-006) open |
| Datalaag/Company OS op cloud-agnostische stack | Postgres + object storage, MCP, LangGraph/Pydantic AI, LiteLLM | **aangevuld**: Manticore, Trigger.dev, TypeScript i.p.v. Python |
| DWH-technologie nog niet gekozen | Keuze en laadpatroon horen bij de specificatie | **gekozen (DEC-005/RJC-321):** dedicated PostgreSQL 16 in Docker/on-box + DuckLake; huidige Motian/Lovable-Neon blijft onaangeroerde read-only migratiebron; managed Postgres/Neon alleen als escape hatch |

De keuze is Accepted/Done; implementatie en production-readinessbewijs zijn dat niet. Die blijven open onder RJC-347.
