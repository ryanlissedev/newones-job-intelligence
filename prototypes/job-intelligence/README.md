# Job Intelligence — interactief ontwerp

Zelfstandig frontendprototype, gebaseerd op de expliciet gekozen Catapulze-referentie. Alle 36 opdrachten zijn fictief. Geen API, productieverbinding, Candidate-module of deployment.

## Lokaal

Vanuit deze map: `npm install`, daarna `npm run dev -- --host 127.0.0.1 --port 4173 --strictPort`. Preview: http://127.0.0.1:4173/.

Kolomzichtbaarheid en volgorde worden bewaard in localStorage (`ji-prototype-columns`). Bewaarde opdrachten en filters bestaan alleen tijdens de huidige demosessie. Kolommen verplaatsen kan met de omhoog/omlaag-knoppen; slepen is niet geïmplementeerd. De mobiele tabel scrollt horizontaal, de uitgeklapte beschrijving past op schermbreedte.

Zoeken gebruikt alle ingevoerde woorden binnen functie en opdrachtgever. Regio is een exacte plaats, geen straalzoekopdracht. Tarieffilters gebruiken het gepubliceerde minimum van de fictieve bandbreedte; onbekende tarieven vallen buiten een actief tarieffilter. Nieuwste gebruikt de vaste demo-invoervolgorde. Filteraantallen tonen de totale demoverdeling, niet dynamische facetcounts.

## Verificatie op 19 september 2026

- `npm ci --ignore-scripts` in deze map: exit 0; de lockfile-installeerde Vite-versie is 6.4.3.
- `npm run build`: exit 0 na de lockfile-installatie; de zelfstandige bundel wordt correct gegenereerd.
- `npm run test:sites`: exit 0, 4 tests (bundled runtime/packaging).
- De repository-gate na de laatste case-correctie eindigde met exit 0: 3272 tests passed, 23 skipped, 0 failed; 11/11 typecheck-projecten, layering en secrets checks passed.

In Codex in-app browser echt bediend: tekstzoeken (Cloud → 3 resultaten), regio (Amersfoort → 6), contract, bron + uren (12), minimumtarief (4), sorteren op hoogste tarief, volgende pagina, inline uit-/inklappen met Enter, selectie bewaren en terugvinden, lege resultaten, kolommen aan/uit/verplaatsen/herstellen, behoud na herladen, Escape in kolommenu, bronnennavigatie, mobiele filters en kolommen. Geen browserconsole-errors bij controle.

Visuele vergelijking en hercontrole staan in `design-qa.md`. Screenshots zijn alleen lokaal onder `/tmp/ji-prototype-proof/`; geen bewijsbestanden in git. Geen MP4: het gebruikte in-app-browseroppervlak biedt geen opname-API. Er is geen PR aangemaakt, gepubliceerd of gedeployed. De bestaande verify-job-intelligence-launcher start de volledige productie-appstack (web/API/database) en past niet op dit zelfstandige Vite-prototype; daarom is dit prototype rechtstreeks in een eigen in-app-tab getest.

## Grenzen

Dit is een ontwerpacceptatie, geen productie-integratie. Geen volledige screenreader-audit. Het losse beeldmerk uit het concept is niet nagemaakt: de header gebruikt voorlopig de Catapulze-woordnaam. Ontbrekende bronwaarden blijven Onbekend. Geen echte externe bronlinks of matchscores.
