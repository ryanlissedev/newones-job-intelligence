# Design QA — Job Intelligence

final result: passed

## Visuele grondslag

- Source: `exec-84645729-80d8-4341-83fe-3adc90492598.png`
- Eerste capture: `/tmp/ji-prototype-proof/desktop.png`
- Hercontrole: `/tmp/ji-prototype-proof/desktop-final.png`
- Overdracht: `/tmp/ji-prototype-proof/desktop-handoff.png`
- Mobiel: `/tmp/ji-prototype-proof/mobile-final.png`
- Desktop bron en implementatie: 1513 × 1039 pixels, CSS viewport 1513 × 1039, capture 1×. Geen dichtheidsnormalisatie nodig.
- Mobiel: 390 × 844 CSS/pixels.
- Vergelijkingsstaat: donker, Utrecht + Interim, zoektekst Data engineer, eerste rij uitgeklapt, kolommenu open. Echte gefilterde demoresultaten wijken bewust af van inconsistente mockaantallen. Overdracht heeft filters gewist en menu gesloten.

Bron en implementatie zijn samen in dezelfde visuele tooluitvoer geopend en bekeken; geen beoordeling op bestandsnamen alleen. Volledige beelden waren op native resolutie leesbaar; tabelkop, detailtekst, filters en menu zijn daarbinnen afzonderlijk beoordeeld, zonder aanvullende crop.

## Vergelijkingshistorie

1. [P2] Kolommenu begon onder de tabelwerkbalk en bedekte meer rijen dan het concept. Verplaatst naar de bovenkant van het zoekgebied. Panel blijft wat breder vanwege toegankelijke verplaatsknoppen en twee extra optionele kolommen. Hercontrole: desktop-final.png.
2. [P2] Detailrij had te veel hoogte en een extra praktische rij. Contract staat nu alleen als optionele tabelkolom; detailtypografie en verticale afstand aangepast. Hercontrole: desktop-final.png.
3. [P2] Mobiele detailbeschrijving liep buiten het zichtbare scherm met de tabel mee. Detailinhoud heeft nu schermbrede begrenzing; praktische gegevens en tekst zijn leesbaar. Hercontrole geopend in browser; mobile-final.png.

## Vijf visuele vlakken

- Typografie: systeem-sans met Inter indien aanwezig; Nederlandse hiërarchie 28px titel, 14px tabel/body, 12–13px ondersteunende tekst. De exacte font van het gegenereerde concept is niet bekend; huidige fallback is een acceptabele prototypebenadering.
- Layout: 65px header, 304px vaste desktopfilters, 30px hoofdinhoudmarge, compacte zoekrij, vijf resultaten per pagina, inline details in twee kolommen. Mobiel krijgt een filterlade en horizontaal scrollbare tabel.
- Kleuren: donkerblauwe inkt/raised surfaces, turquoise signaalkleur en zachte grijsblauwe tekst. Gebaseerd op bestaande `apps/web/src/index.css` semantische tokenrichting en gekozen beeld; zelfstandige CSS gebruikt lokale waarden.
- Beelden/iconen: Phosphor regular-iconen voor de dunne lijnstijl. Geen foto’s of illustraties nodig. Het conceptbeeldmerk, datum en thema-/profielacties zijn bewust weggelaten uit deze functionele prototypeheader; tekstuele merknaam blijft. Geen zelfgetekend vervangend logo.
- Copy: Nederlands, expliciete fictieve data, eerlijke aantallen, geen liveclaim of matchscore. Onbekende tarieven/startdatums/looptijd blijven onbekend. Geen externe bronknoppen zonder echte bestemming.

## Functionele verificatie

Zoeken, regio/contract/bron/uren/tarief, sortering, paginering, selectieacties, bewaren, uitklappen met toetsenbord, lege resultaten, kolomzichtbaarheid, verplaatsen, herstellen en persistentie na reload live gecontroleerd. Mobiele filterlade en kolomkeuze bediend. Escape sluit kolommenu en zet focus terug. Browserconsole gecontroleerd: geen errors.

## Reviews en beperkingen

Implementatiereview: lokale opslag valideert toegestane kolommen, zoek/filterwijzigingen resetten paginering en selectie, onbekend tarief sorteert onderaan bij hoogste tarief, geen backendimports. Afzonderlijke eindcontrole tegen het doel: uitsluitend JI, vaste desktopfilters, kolommen plus inline details tegelijk beschikbaar, fictieve data, geen productieaanpassingen.

Geen open P0/P1/P2-ontwerpbevindingen. Geen onafhankelijke subagentreview of screenreader-audit. Repo-brede typecheck/tests niet geslaagd wegens ontbrekende monorepo-dependencies; zie README. Geen MP4-opname-API in het gebruikte browseroppervlak.

## Follow-up polish

[P3] Definitief merkbeeld en exact font kunnen later door de echte brand assets vervangen worden. Het compacte menu gebruikt knoppen in plaats van drag handles; dat houdt ordenen ook met toetsenbord beschikbaar.

## Implementatiechecklist

- [x] Visuele target geopend en samen met implementatie vergeleken.
- [x] P2-bevindingen hersteld en opnieuw zichtbaar beoordeeld.
- [x] Desktop- en mobiele primaire interacties getest.
- [x] Lokale preview blijft draaien; geen publicatie.
