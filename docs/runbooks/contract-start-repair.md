# Contract-start repair (RJC-432)

Parserversies `tenderned/v2` en `opdrachtoverheid/v2` voorkomen dat een publicatie- of eerste-waarnemingsdatum als contractstart wordt genormaliseerd en in de dedupidentiteit terechtkomt. Deze codecorrectie herstelt bestaande dedupgroepen niet automatisch.

## Afbakening en bewijs

Voer een historische reparatie alleen uit na een afzonderlijk beoordeeld plan. Maak eerst een read-only inventaris per bron en lees voor iedere kandidaat het bijbehorende raw object terug. Gebruik opgeslagen parser- en veldprovenance waar die beschikbaar is, maar behandel ontbrekende `observation.parserVersion` expliciet als een evidence-gap: een filter op uitsluitend `tenderned/v1` of `opdrachtoverheid/v1` vindt niet aantoonbaar alle kandidaten.

- TenderNed: iedere v1-observatie met `start_datum` uit `detail.publicatieDatum` is kandidaat; v2 moet `startDatum=UNKNOWN` opleveren en `publicatieDatum` als `bron_specifiek.publicatie_datum` bewaren.
- Opdrachtoverheid: alleen een v1-observatie waarvan het raw object geen niet-lege `tender_start_date` maar wel `tender_first_seen` bevat, is kandidaat. Een echte `tender_start_date` blijft contractstart; `tender_first_seen` blijft `bron_specifiek`-metadata.

Leg per bron de aantallen, observatie-ID's, raw-objectreferenties, oude en nieuwe startdatum, oude en nieuwe dedupsleutel en betrokken dedupgroep vast. Gebruik geen selectie alleen op oude provenance: Opdrachtoverheid v1 labelde zowel echte startdatums als de fallback met `tender.tender_start_date`.

De huidige `curated.aanvraag`-tabel bewaart geen canonieke startdatum of
veldprovenance, en het SCD2-snapshot bevat deze velden evenmin.
`PostgresCurateStore` reconstrueert bij teruglezen alleen placeholder-provenance.
Leid de gecorrigeerde startdatum en provenance daarom opnieuw af uit het raw
object en leg die in het read-only auditrapport vast; beschrijf ze niet als
bestaande persistente aanvraagvelden.

## Replayplan

1. Draai de selectie en v2-normalisatie read-only en schrijf een deterministisch rapport met aantallen en digests.
2. Classificeer welke aanvragen gelijk blijven, naar een andere bestaande groep bewegen, een groep splitsen of een groep samenvoegen. Laat conflicten en handmatig gekoppelde groepen expliciet beoordelen.
3. Laat het rapport en het mutatieplan apart reviewen en autoriseren. Een parserdeploy op zichzelf is geen toestemming voor historische mutaties.
4. Ontwerp een afzonderlijke, scoped reparatie die de dedupsleutel uit het raw object opnieuw berekent en de aanvraag via gecontroleerde, vooraf getoetste operaties aan de juiste groep koppelt, splitst of samenvoegt. Het huidige curate-pad repareert dit niet: dezelfde content-hash wordt ongewijzigd overgeslagen en bij een gewijzigde hash blijft de bestaande `dedupGroepId` behouden. Een gewone replay of parserdeploy is daarom onvoldoende.
5. Voer alleen de goedgekeurde observatie- en aanvraag-ID's uit in een herstelbare transactie of bounded batch. Bewaar auditbewijs dat raw payload, parserversie, afgeleide startdatum en provenance, oude en nieuwe dedupsleutel en groepswijziging verbindt. Het duurzaam opslaan van canonieke startdatum of provenance vereist een afzonderlijk beoordeelde schemamigratie en valt niet impliciet onder deze reparatie.
6. Herhaal dezelfde read-only inventaris. Verwacht nul onverklaarde kandidaatclassificaties, stabiele rapportdigests bij een tweede reparatierun en verklaarde aanvraag- en dedupgroeptellingen.

Gebruik synthetische of disposable data voor ontwikkeling en destructieve tests. Dit runbook autoriseert geen productie-write, brede migratie of reconstructie zonder raw-objectbewijs.
