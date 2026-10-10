# Beoordelingen (judgments) voor de golden search-benchmark

Dit is de instructie voor recruiters die zoekresultaten beoordelen. Het gaat om het bepalen of een aanvraag (opdracht/vacature) een goed zoekresultaat is voor een bepaalde zoekopdracht — niet om de aanvraag zelf te beoordelen.

## Wat je krijgt

Een `.csv`-bestand (en een `.md`-versie om te lezen in de browser of Linear) met per zoekopdracht een lijst van kandidaat-documenten: de titel, de bron, en een korte samenvatting (snippet) van de aanvraag, plus de huidige beoordeling (`current_label`) als die er al is.

## Hoe je het opent

Open het `.csv`-bestand in Excel of Numbers. Het gebruikt een **puntkomma (`;`)** als scheidingsteken — dat is de standaard voor Excel in Nederland, dus het opent automatisch in kolommen. Zie je alles in één kolom staan, kies dan bij importeren expliciet "puntkomma" als scheidingsteken.

## Wat je invult

Vul de kolom **`grade`** in voor elke rij die je beoordeelt:

| Waarde | Betekenis |
| --- | --- |
| **2** | zeer relevant — dit is precies wat iemand zoekt bij deze zoekopdracht |
| **1** | relevant — dit hoort bij de resultaten |
| **0** | niet relevant — dit hoort niet bij de resultaten |
| _(leeg)_ | je hebt deze rij nog niet beoordeeld — wordt genegeerd bij import |

Stel jezelf bij elke rij de vraag: **"zou je deze aanvraag aan een kandidaat voor deze zoekopdracht voorleggen?"** Beoordeel puur op basis van de titel en de snippet — niet op basis van waar het document nu al staat, en niet op basis van kennis die niet in de tekst staat.

De kolom **`comment`** is optioneel, maar vul hem in bij twijfelgevallen — vooral bij een `0` voor een document dat oppervlakkig gezien relevant lijkt (bijvoorbeeld dezelfde technologie noemt, maar in een heel andere context). Dat soort toelichting helpt een volgende beoordelaar het onderscheid te begrijpen.

Een `0` op een document dat er op het eerste gezicht relevant UITZIET is de waardevolste beoordeling die je kunt geven (een "hard negative") — leg in de comment kort uit waarom het toch niet relevant is.

Voor de score telt alleen het onderscheid leeg / `0` / `≥1`: een `2` en een `1` worden allebei "relevant". Het verschil tussen `2` en `1` is puur jouw eigen nuance voor twijfelgevallen — het beïnvloedt de score niet.

## Hoe je het terugstuurt

Stuur het ingevulde `.csv`-bestand naar Ryan (per mail, of als bijlage in Linear) — Ryan importeert het.
