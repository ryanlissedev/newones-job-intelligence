# Bronnenregister discovery

Dit register maakt zichtbaar welke bron voor welk inzicht is gebruikt. Het bewaart bewust geen credentials, volledige privétranscriptie of veranderlijke applicatiedata.

| Bron | Geraadpleegd | Gebruik | Betrouwbaarheid en grens |
|---|---|---|---|
| [Fireflies-call Ryan/Robbie](https://app.fireflies.ai/view/-VIDEO-CALL-Ryan-Robbie::01M0YZCR6ZGV01GP6DYJD6BHHH) | 2026-08-27 | Requirements, taken, tijdlijn en besproken architectuuropties | 628 captions volledig geanalyseerd; ASR vervormt productnamen en enkele domeintermen, daarom timestamps en correcties gebruikt |
| [Gedeelde ChatGPT-analyse](https://chatgpt.com/share/6a904fb1-4a64-83eb-902b-7d6e6324d882) | 2026-08-27 | Eerdere doelplaat en red-team-context | Publieke live share; inhoud kan later wijzigen |
| Geplakt v1.2-oordeel | 2026-08-27 | Slice-first, control-plane vóór effecten en evidence-by-default | Door gebruiker aangeleverde tekst; als ontwerpinput behandeld, niet als automatisch genomen besluit |
| [Fantastic.jobs scrapervergelijking](https://fantastic.jobs/article/best-job-scrapers) | 2026-08-27 | Longlist voor scraper-spike | Leverancier-/marketingtekst, gemarkeerd als bijgewerkt april 2026; prijs, dekking en uptime nog primair verifiëren |
| [Lovable/Neon-prototype](https://neon-data-whisperer.lovable.app/) | 2026-08-27 | Huidige productvorm, facetten, zichtbare aantallen en datacompleetheid | Live read-only momentopname; geen export of screenshot bewaard, dus aantallen zijn niet reproduceerbaar bewijs |

## Transcriptcorrecties die bouwbesluiten raken

- “facturenbron/factuursites” rond 00:30 en 02:53 betekent waarschijnlijk vacaturebron/vacaturesites.
- “factuurprijs” rond 05:07 is onvoldoende betrouwbaar; bevestigd is alleen een prijs-/tariefveld waarvan semantiek nog moet worden bepaald.
- `Spot.io`, `Spock.io` en `Spottet` lijken hetzelfde downstream recruitmentsysteem; exacte naam en URL moeten vóór integratie worden bevestigd.
- `loveball` is Lovable, `Lake Base` is waarschijnlijk Databricks Lakebase, `BetterOck` is Amazon Bedrock en `1.1.n` waarschijnlijk n8n.

## Reproduceerbaarheidsbeleid voor de bouwfase

Nieuwe architectuur- of releasebesluiten mogen niet alleen op een live URL rusten. Leg per besluit minimaal retrievaltijd, relevante response/screenshot of fixture, contenthash waar praktisch, bronversie, eigenaar en eventuele privacybeperking vast in het release-evidencepack.
