# EXTRACT_LOG — Catapulze Architectuur Explorer

Bron: https://claude.ai/code/artifact/93692ad4-4974-4204-986b-d955d28576dc
Datum: 2026-08-27 · Tool: Interceptor CLI (echte Chrome, read-only) + `curl` van de iframe-bron

## Hoe de data is verkregen

1. Artifact geopend met Interceptor; de plaat draait in een cross-origin iframe (`*.frame.claudeusercontent.com`, frame 16/17/20 — id wisselt bij reload).
2. `interceptor text --frame <id> --markdown` werkt, maar kapt output af op ~50 KB en `eval`/`save` ondersteunen `--frame` niet (CSP + flag lekt de expressie in). "Kopieer JSON" → klembord werkt niet zonder echte user-gesture. `Artifact read` weigert (non-member).
3. Daarom de iframe-URL (signed pad `/_f/1787740964-a3ee/`) met `curl` opgehaald: 339.893 bytes HTML met vier inline scripts. Script 2 bevat `const MODEL = {…}` (JS-literal), script 3 bevat `const JI = {…}`, `const JI_REQ = {…}` en `jiSchema()`.
4. Literals met een brace-matcher geïsoleerd en via `bun -e` naar JSON gedumpt; `schema.json` is gegenereerd door de artifact-eigen `jiSchema()` te draaien op `JI`.
5. Verificatie: de in de browser gerenderde `<pre>` van "Volledig model (JSON)" is over de eerste 50.000 bytes byte-identiek aan `model.json`; het zijpaneel van "Verrijking & prospecting (Clay)" komt overeen met de gegenereerde tekst in `componenten.md`.
6. Deep-dive-tabs zijn wél via de browser uitgelezen (zichtbare tekst na een verse reload — anders zat de verborgen drawer-inhoud mee in de 50 KB).

## Bestanden

| Bestand | Bytes | Herkomst | Panel in de UI |
|---|---:|---|---|
| model.json | 57.914 | `MODEL` uit bron, gevalideerd | Volledig model (JSON) → JSON |
| documenten.md | ~4.400 | `MODEL.documenten` + per-component `documenten` | Documenten → Lijst (+JSON) |
| datamodel.md | ~8.700 | `MODEL.entiteiten` (tabel + per entiteit Uitleg) | Datamodel (entiteiten) → Overzicht (+JSON) |
| beslissingen.json | 978 | `MODEL.beslissingen` | Beslissingen → JSON |
| beslissingen.md | 802 | idem, als tabel | Beslissingen → Lijst |
| spec.json | 69.255 | `JI` | Deep dive → "JSON van de spec" |
| requirements.json | 80.840 | `JI_REQ` (bonus, zelfde knoppenrij) | Deep dive → "JSON van de requirements" |
| schema.json | 14.837 | `jiSchema()` op `JI` | Deep dive → tab JSON Schema (de code-block) |
| componenten.md | ~85.600 | 6 lagen + 33 componenten + 4 vervolgstappen: Uitleg · Data & stromen · JSON · Documenten | zijpanelen `#g/…`, `#c/…`, `#s/…` |
| deep-dive-overzicht.md | 3.293 | browser, zichtbare tekst | Deep dive → Overzicht |
| deep-dive-pipeline.md | 3.474 | browser | Deep dive → Pipeline |
| deep-dive-datamodel.md | 11.387 | browser (75 velden, ongefilterd) | Deep dive → Datamodel |
| deep-dive-datalaag.md | 3.194 | browser | Deep dive → Datalaag |
| deep-dive-config-stack.md | 4.012 | browser | Deep dive → Config & stack |
| deep-dive-fasen-compliance.md | 2.779 | browser | Deep dive → Fasen & compliance |
| deep-dive-json-schema.md | 15.588 | browser | Deep dive → JSON Schema |
| deep-dive-v1-analyse.md | 8.803 | browser | Deep dive → v1-analyse |

Overgeslagen op verzoek: tabs Bronnen, Requirements, Mapping v1 → v2 (al elders geëxporteerd — de onderliggende data zit wel volledig in `spec.json` → `bronnen` en `requirements.json` → `requirements`/`mapping`). Download-knoppen niet aangeraakt.

## Niet uitleesbaar / opmerkingen

- `DASHBOARD_IMG` (screenshot v1-dashboard in het JI-paneel "Data & stromen") is niet geëxporteerd (base64-afbeelding).
- `PRINCIPLES`/`NAMES` zijn UI-constanten, geen inhoud — niet meegenomen.
- Reeds aanwezig in de map en ongemoeid gelaten: `README.md`, `doelplaat-v1.1-tekst.md`.
- Interceptor meldt bij `act` op knoppen soms "click failed at all layers" terwijl de klik wél aankomt; `click <ref>` is betrouwbaarder.
