# RedTeam — Catapulze doelarchitectuur v1.1 (25-08-2026)

ParallelAnalysis: 24 atomaire claims, 11 onafhankelijke reviewers (3 engineers, 3 architects, 3 pentesters, 2 interns) + agent-native audit + Fable-eindreview. Volledige versie: `../artifacts/redteam-doelplaat.html`.

## Verdict: fix-first

De vier lagen, de AI Act-framing (matching = Annex III hoog-risico), agents-als-identiteit, MCP als koppelvlak en de identifier-discipline overleven. Wat moet veranderen: één alinea (bouwvolgorde "eerst fundament, dan pas agents") en één logboekregel ("eerst specificeren, dan vanaf nul bouwen"). Beslissend risico: nul zichtbare matching-waarde vóór laag 3, in een driepersoonsbedrijf zonder toegewezen bouwer.

## Convergentie

| Bevinding | Claim | Reviewers | Ernst |
|---|---|---|---|
| Identifiers: timing goed, haalbaarheid onbewezen — entity-resolution over 28 bronnen is probabilistisch; geen soevereiniteit over Please/jobboards; plaat spreekt zichzelf tegen (Spott.io-ID's gelockt vóór het model) | #5 | 9/11 | kritiek |
| Bottom-up volgorde = Inmon-era big-bang (Lidl eLWIS, Netscape 6); geen verticale snede levert matching-waarde vóór laag 3 | #12 #3 #18 | 4 | kritiek |
| Governance-perimeter dekt het interieur, niet de randen: Please buiten audit, Moneybird/Revolut-schrijftoegang ongescoped, harness = één credential, gescrapete tekst = prompt-injectie in een schrijfpad | #22 #21 #16 | 3 | significant |
| Bouwcapaciteit niet toegewezen (adviesretainer ≠ bouwcapaciteit) | #24 | 2 | significant |
| Agents-laatst ontwerpt het datamodel zonder agent als consument | #4 #12 | agent-native | significant |

Panel splitste op #5: EN-1/EN-3/EN-6/AR-8 vielen aan (MDM-werk, externe governance, zelf-tegenspraak); PT-1/IN-1/IN-2/PT-4 verdedigden (het ene goedkoop-nu besluit). Beide hadden gelijk over een andere helft.

## Agent-native gaps (gerangschikt)

G1 agents laatst → model kent geen agent · G2 harness/BI mens-only, geen pariteitskaart · G3 agents als workflows i.p.v. uitkomsten over primitieven · G4 Please breekt de omzetlus · G5 memory = auditlog, geen leesbare context · G6 geen `complete_task`/eval-als-klaar · G7 goedkeuring niet gekoppeld aan omkeerbaarheid · G8 per-bron normalisatie = statische tool-mapping.

## Aanbeveling (verwerkt in de bouwbrief)

Eén verticale snede: drie entiteiten (opdrachtgever, professional, aanvraag) als minimaal model; Job Intelligence v1 blijft draaien; één aanvraag-kwalificatie-agent over MCP-primitieven met auditlog, goedkeuringsmatrix en `complete_task`; Company OS krimpt tot wat de snede nodig heeft; governance en AVG-grondslag per bron naar stap 0; Please via MCP-adapter; logboekregel "vanaf nul" schrappen.

## Fable-correcties (toegepast)

(1) "Spott.io-ID's ná het canonieke model" herstelde het aangevallen patroon → minimaal drie-entiteitenmodel dat de snede zelf is; (2) claim 3 "weerlegd" → "ondergraven"; (3) 3u/week is de adviesretainer, niet Catapulze's bouwcapaciteit — het gat is "onbezet"; (4) gescrapete input in een schrijvende agent = injectie in een schrijfpad — sterkste argument voor governance op stap 0.
