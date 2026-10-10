# ADR-0005 — Trigger.dev-workers en de bereikbaarheid van Postgres en Manticore

- Status: Proposed (voorgesteld — het besluit is aan Ryan; dit ADR legt de tegenspraak en de opties vast)
- Zie ook [ADR-0006](ADR-0006-neon-as-system-of-record.md)/[ADR-0007](ADR-0007-search-platform-state-2026-09-01.md) (2026-09-01): de Manticore-helft is nu opgelost door de on-box projector (#96) — de worker hoeft in `onbox`-modus geen Manticore-bereikbaarheid meer te hebben.
- Datum: 2026-08-31
- Herzien: 2026-08-31 (tweemaal) — zie "Revisie" en "Herziening 2" hieronder. Eerst is Optie C1 ongeldig gebleken; daarna is via [ADR-0006](ADR-0006-neon-as-system-of-record.md) Optie A gekozen. De Manticore-helft van de vraag blijft open.
- Eigenaar: Job Intelligence platform
- Gerelateerd: ADR-0004, DEC-005, RJC-373, [orchestration.md](../research/orchestration.md), het verificatierunbook van 2026-08-31 (intern, niet in deze repo) (intern operator-document, niet in deze repo)

## Revisie (2026-08-31)

Dit ADR werd dezelfde dag aanvullend onderzocht tegen Trigger.dev's eigen documentatie, changelog, pricing-pagina en feedbackbord (bronnen hieronder; alle T1 = officiële docs, T2 = officieel maar niet-docs zoals changelog/pricing/feedbackbord). Dat onderzoek **weerlegt de oorspronkelijke aanbeveling** ("onderzoek eerst C1, val terug op B") en **corrigeert één aanname** waarop het hele ADR was gebouwd. Deze sectie legt vast wat er veranderde en waarom — de oorspronkelijke Opties- en Aanbevelingstekst hieronder blijft grotendeels staan zodat de redenering van 2026-08-31 zichtbaar blijft, met inline correcties waar nodig.

**(a) Optie C1 is geen bestaand product.** "Self-hosted workers" — precies het C1-model, workers die je zelf host en die uitgaand verbinden met Trigger.dev Cloud — staat op Trigger.dev's eigen feedbackbord met status **"In Review"**, ~2 jaar oud, prijsmodel "undetermined". ([feedback.trigger.dev/p/self-hosted-workers](https://feedback.trigger.dev/p/self-hosted-workers), T2) Self-hosting is in de officiële docs expliciet all-or-nothing: een Webapp-helft en een Worker-helft, beide van jou; geen gedocumenteerde modus waarin de Worker-helft aan Trigger.dev's gehoste Webapp hangt. ([trigger.dev/docs/self-hosting/overview](https://trigger.dev/docs/self-hosting/overview), T1) Het concrete aangrijpingspunt is `MANAGED_WORKER_SECRET`, dat "needs to match webapp value". ([trigger.dev/docs/self-hosting/env/supervisor](https://trigger.dev/docs/self-hosting/env/supervisor), T1) Preciezer dan een eerdere formulering van deze revisie: dat *doodt* C1 niet aantoonbaar, het **verplaatst de blokkade van client naar server**. Client-side houdt niets het tegen — de supervisor valideert `TRIGGER_API_URL` alleen als well-formed URL, zonder allowlist of host-check. Maar uitgifte én validatie van het worker-group-token gebeuren aan de kant van Trigger.dev, en of Cloud zo'n token aan een externe supervisor verstrekt is zonder account niet vast te stellen. Dat is exact wat de "In Review"-aanvraag vraagt om te ontsluiten. C1 blijft daarmee een weddenschap op een ongeleverde roadmap-post — niet omdat het bewijsbaar onmogelijk is, maar omdat er geen ondersteund pad naar toe is en wij het niet kunnen verifiëren.

**(b) Een kernaanname van dit ADR is weerlegd, niet stilzwijgend geschrapt.** De Context hieronder framede het probleem als: een Trigger.dev Cloud-worker moet ergens *naar binnen* om Postgres en Manticore te bereiken. Dat klopt niet. De supervisor verbindt **uitgaand**: `TRIGGER_API_URL` "should point at the webapp"; authenticatie via `TRIGGER_WORKER_TOKEN` + `MANAGED_WORKER_SECRET`; telemetrie (OTel) ook uitgaand. De enige inkomende poort van de supervisor (standaard 8020) is de Workload API voor de eigen run-containers op dezelfde host — niet voor Trigger.dev. ([trigger.dev/docs/self-hosting/env/supervisor](https://trigger.dev/docs/self-hosting/env/supervisor), T1) **In geen enkele gedocumenteerde topologie belt Trigger.dev naar binnen in ons netwerk, en niets vereist het publiceren van poort 5432.** Dit verzwakt de oorspronkelijke framing van de hele tegenspraak: de echte vraag is niet "moet Trigger.dev naar binnen kunnen", maar "waar draait de taakcode" (on-box, zoals B en C1 pogen; of in Trigger.dev's gehoste compute, zoals A en D, wat dan vraagt om Postgres/Manticore op een andere manier bereikbaar te maken voor die kant).

**(c) De resourcecijfers in Optie B waren te laag, niet fout.** Officiële docs: Docker self-hosting vraagt webapp 3+ vCPU/6+ GB en worker 4+ vCPU/8+ GB → **14+ GB, 7+ vCPU verdeeld over twee machines**; Kubernetes noemt **6+ vCPU en 12+ GB totaal** voor het hele cluster. ([trigger.dev/docs/self-hosting/docker](https://trigger.dev/docs/self-hosting/docker), T1 · [trigger.dev/docs/self-hosting/kubernetes](https://trigger.dev/docs/self-hosting/kubernetes), T1) Het circulerende "~12 GB" komt overeen met het Kubernetes-totaal en onderschat de Docker-route. Belangrijker dan het getal: het is niet "een webapp en een worker" maar **vijf tot zeven stateful diensten** (PostgreSQL, Redis, ClickHouse, object storage/MinIO, container registry, Electric, S2/s2-lite) naast de supervisor en zijn Docker-socket-proxy. Self-hosted v4 heeft bovendien **geen checkpoint-ondersteuning** ("only ever experimental when self-hosting … caused a bunch of issues") — de warme starts die Cloud levert, vervallen dus. De docs zelf: de guide alleen "is unlikely to result in a production-ready deployment."

**(d) Twee aangrenzende feiten, vastgelegd voor de volledigheid.** **BYOC** (Bring Your Own Cloud, changelog [20 apr 2025](https://trigger.dev/changelog/bring-your-own-cloud)) is het dichtstbijzijnde échte product: het *hele* platform gedeployed in je eigen AWS/GCP/Azure-account, door Trigger.dev beheerd, sales-led — geen publieke prijs of tier gevonden, **niet gedocumenteerd**. En **AWS PrivateLink** staat op de publieke pricing-pagina als Pro-plan feature ($50/mo basis). ([trigger.dev/pricing](https://trigger.dev/pricing), T2) Vervolgonderzoek dezelfde dag heeft de richting hiervan alsnog vastgesteld: de klant publiceert zelf een VPC Endpoint Service en autoriseert Trigger.dev's AWS-account als principal; Trigger.dev-gehoste taken bereiken dan de klant-VPC via een private IP, zonder publieke listener. ([trigger.dev/changelog/aws-privatelink](https://trigger.dev/changelog/aws-privatelink), T2, 30 apr 2026) Dit lost hier echter niets op: het is **AWS-only**, en noch Neon, noch een Hetzner-box zit in een AWS-VPC die de klant beheert — dus PrivateLink is voor déze architectuur niet bruikbaar zoals beschreven, en wordt niet als optie meegenomen.

De volledige onderzoeksbronnen — inclusief wat expliciet niet kon worden vastgesteld — staan in `.research-findings.md` in de repo-root van deze worktree (untracked, niet gecommit met dit ADR; alleen ter referentie voor wie dit besluit later opnieuw controleert).

## Context

Twee geaccepteerde besluiten zijn samen niet uitvoerbaar zoals ze er staan:

1. [ADR-0004](ADR-0004-postgres-environment-strategy.md) eist dat productie-Postgres on-box draait en dat poort 5432 **uitsluitend via het private applicatienetwerk** bereikbaar is, zonder publieke listener (regel 21), met als productieverificatie expliciet "afwezigheid van een publieke 5432-listener" (regel 61).
2. [orchestration.md](../research/orchestration.md) besluit **Trigger.dev Cloud** als orchestrator (regel 51): "Trigger.dev Cloud (TS-runtime); self-host als de rekening structureel > $150–200".

Een gedeployde Trigger.dev Cloud-worker draait in Trigger.dev's eigen hosted compute, buiten onze box en zonder vastgelegde egress-IP's. Zo'n worker moet **twee** private diensten bereiken, niet één: de taakcode vereist zowel `DATABASE_URL` als `MANTICORE_URL` — `requireManticoreUrl()` in [`apps/worker/src/poll-bron-env.ts:9`](../../apps/worker/src/poll-bron-env.ts) gooit een harde fout zonder Manticore-URL, en [`apps/worker/src/poll-bron-run.ts:164`](../../apps/worker/src/poll-bron-run.ts) gebruikt die in het drain-pad van elke `poll-bron`-run. Een oplossing die alleen de database bereikbaar maakt, lost het probleem dus niet op.

Het [slice-a-live-smoke-runbook](../runbooks/slice-a-live-smoke.md) (regel 70) noteert al dat de Coolify-compose mogelijk géén workercontainer bevat "omdat Trigger.dev de scheduled runs host" — precies de aanname die met een private 5432 en een private Manticore niet kan kloppen. Niets in de repository lost deze tegenspraak op; dit ADR legt haar vast en zet de opties naast elkaar.

## Reeds verzameld bewijs

Het Neon + Trigger.dev-verificatierunbook van 2026-08-31 (intern operator-document, niet in deze repo) bewijst lokaal:

- de pipeline (poll → staging → curate → outbox → Manticore-drain) werkt end-to-end tegen Neon en is idempotent (TenderNed + Inhuurdesk tweemaal; `curated.aanvraag` stabiel op 4; Manticore bereikbaar met 223 documenten);
- een lokale `trigger dev`-worker registreert alle vier de taken tegen Neon en de cron `schedule-slice-a-polls` vuurde tweemaal succesvol;
- één expliciete `poll-bron`-run faalde met "bron is not pollable" — een correcte business-rule-afwijzing (`actief=false`), geen infrastructuurfout.

Wat dit **niet** bewijst (zelfde runbook, sectie "What this does NOT prove"): Trigger.dev Cloud/hosted workers die Neon of Manticore bereiken; cloud→Manticore-bereikbaarheid überhaupt (Manticore stond op `127.0.0.1:9308`); en iets over een self-hosted Hetzner-Postgres — Neons publieke pooled endpoint is bewust een andere houding dan ADR-0004 voorschrijft. Daarnaast bestaat er nergens een `TRIGGER_SECRET_KEY` (RJC-373), dus taken zijn nu niet programmatisch te triggeren — dat blokkeert ook elk geautomatiseerd staging-bewijs.

## Opties

Elke optie moet beide diensten dekken: Postgres én Manticore.

### A. Managed Postgres (Neon) als system of record

- **Werking:** Cloud-workers bereiken Neon per constructie via het publieke TLS-endpoint. Bewezen bereikbaar vanaf een lokale worker; cloud-worker→Neon is aannemelijk maar onbewezen.
- **Manticore:** blijft onopgelost — er is dan alsnog een publieke Manticore-ingress, VPN of tunnel nodig. Optie A alleen is dus geen volledige oplossing.
- **Kosten:** Neon €60 → 160 → 250/mnd (interne kostenkaart (intern operator-document, niet in deze repo) regel 16), naast de Hetzner-box die voor Manticore en de apps toch nodig blijft. interne kostenkaart (intern operator-document, niet in deze repo) regel 56 telt Neon juist als bespaarpost van de nieuwe SoR-raming.
- **ADR-0004:** vereist amenderen of vervangen. De eigen escape-hatch-voorwaarden (ADR-0004, "Managed Postgres als escape hatch", regel 72–81) eisen *gemeten* bewijs dat de single-host envelope niet volstaat — HA, RTO/RPO, contentie of ops-last. **Geen van die voorwaarden is nu aangetoond**; bereikbaarheid voor een externe orchestrator staat niet in de lijst.
- **Security:** publieke database-endpoint met TLS + credentials; groter aanvalsoppervlak dan private 5432.
- **Bewijs dat beslist:** een gedeployde (niet-lokale) Trigger.dev-run die tegen Neon een volledige `poll-bron` schrijft én de Manticore-drain haalt via welke Manticore-ingress dan ook.

### B. Self-hosted Trigger.dev op de Hetzner-box

- **Werking:** de orchestrator verhuist het private netwerk in; workers draaien on-box en bereiken Postgres en Manticore over compose/Coolify-netwerken. 5432 en Manticore blijven private; ADR-0004 blijft intact.
- **Kosten:** ~€60–80/mnd hardware-equivalent + ops ([orchestration.md](../research/orchestration.md) regel 38, 44–49). De v4-compose vraagt webapp 3+ vCPU/6 GB en worker 4+ vCPU/8 GB (regel 38) — het eerder genoemde "~12 GB RAM" is in de repo niet exact zo vastgelegd; regel 38 telt op tot ~14 GB. Op een CCX33 (32 GB) naast Postgres + Manticore is dat serieuze resource-concurrentie, en DEC-005 geeft Postgres prioriteit.
- **Tegenspraak:** herroept het Cloud-besluit van orchestration.md regel 51, terwijl diens self-host-trigger ($150–200/mnd) een **kosten**voorwaarde was die niet is bereikt; de reden zou hier bereikbaarheid/security zijn, wat een nieuw expliciet besluit rechtvaardigt (dit ADR).
- **Security:** beste houding — geen enkele nieuwe publieke listener.
- **Bewijs dat beslist:** self-hosted stack op de box, een volledige `poll-bron`-run met schrijfpad, plus geheugen-/CPU-metingen die aantonen dat Postgres binnen budget blijft (ADR-0003-cohort).

### C. Cloud-orchestratie behouden, executie of netwerk privé maken

Twee varianten, oplopend in complexiteit:

- **C1 — on-box workercontainer met uitgaande verbinding naar Trigger.dev Cloud.** Zoals `trigger dev` lokaal deed: de worker verbindt *uitgaand* met Cloud, taakcode draait on-box met privaat bereik naar 5432 en Manticore. Geen inkomende poorten, geen tunnel. **[HERZIEN 2026-08-31 — weerlegd]** Dit is geen ondersteund product: "Self-hosted workers" staat op Trigger.dev's eigen feedbackbord als open aanvraag, status "In Review", ~2 jaar oud, prijsmodel onbepaald ([feedback.trigger.dev/p/self-hosted-workers](https://feedback.trigger.dev/p/self-hosted-workers), T2). Concreet geblokkeerd door `MANAGED_WORKER_SECRET`, dat moet overeenkomen met een webapp-waarde die je op een gehoste (niet-zelf-beheerde) webapp niet kunt zetten ([trigger.dev/docs/self-hosting/env/supervisor](https://trigger.dev/docs/self-hosting/env/supervisor), T1). Zie de Revisie-sectie bovenaan voor de volledige onderbouwing. De genoemde open vraag is hiermee beantwoord: **nee, niet als ondersteund product.** Wat wél client-side mogelijk blijkt — de supervisor valideert `TRIGGER_API_URL` alleen als well-formed URL, zonder allowlist of host-check (DeepWiki-index van `triggerdotdev/trigger.dev`, T1-adjacent: echte broncode, AI-samengevat, geen officiële docs — geen URL beschikbaar) — verandert dit niet: token-uitgifte en -validatie zijn server-side, en dat is precies wat de "In Review"-aanvraag vraagt om te ontsluiten.
- **C2 — tunnel-sidecar (WireGuard/Tailscale) vanuit de cloud-worker.** De hosted worker krijgt een netwerkpad het private net in. De tunnel-endpoint draait dan als container op de Hetzner-box; valt de tunnel weg, dan faalt elke run op DB-connect — een extra bewegend deel midden in het kritieke pad, met eigen sleutelbeheer. Of een sidecar überhaupt in Trigger.dev's hosted runtime kan draaien is eveneens onbevestigd.
- **Kosten:** Trigger.dev Cloud-tarief blijft (interne kostenkaart (intern operator-document, niet in deze repo) regel 18: €16 → 62/mnd); C1 kost box-resources voor één workercontainer (veel minder dan optie B's volledige stack); C2 kost tunnelbeheer.
- **ADR-0004:** blijft volledig intact.
- **Security:** C1 uitstekend (alleen uitgaand); C2 introduceert een tunnelsleutel als nieuw geheim en pad.
- **Bewijs dat beslist:** C1 — een productieworker on-box die een door Cloud geplande run uitvoert met schrijfpad; C2 — idem door de tunnel, plus een gedocumenteerde faalmodus-test (tunnel down → run-gedrag).

### D. Split: Cloud triggert een on-box HTTP-endpoint

- **Werking:** Trigger.dev Cloud-taken doen zelf geen DB-werk maar roepen een geauthenticeerd HTTPS-endpoint op `apps/server` (of een aparte on-box service) aan, dat de pipeline lokaal uitvoert. 5432 en Manticore blijven private.
- **Kosten:** Cloud-tarief blijft; extra endpoint- en authcode.
- **ADR-0004:** intact.
- **Security — eerlijk benoemd:** er ontstaat een publiek bereikbaar endpoint dat ingest-runs kan starten. Dat vergt request-signing of een shared secret met rotatie, rate limiting en idempotency-keys; de blast-radius bij een gelekt secret is "willekeurige polls starten", niet "database lezen", maar het is wél een nieuw publiek aanvalsoppervlak dat ADR-0004 juist wilde vermijden voor de data zelf.
- **Nadeel:** Trigger.dev's waarde (durable runs, retries, observability *rond de taakcode*) degradeert tot een cron-met-webhook; retry-semantiek verschuift naar het endpoint.
- **Bewijs dat beslist:** end-to-end run Cloud → endpoint → pipeline → Manticore, plus een auth-negatieftest (ongeldige signature → 401, geen run).

## Aanbeveling

**[HERZIEN 2026-08-31]** De oorspronkelijke aanbeveling — "onderzoek eerst C1, val terug op B" — is niet langer houdbaar: C1 bestaat niet als ondersteund product (Revisie, punt a), dus er valt niets meer te onderzoeken. Het onderzoek maakt de keuze niet volledig dicht, maar wel eenzijdiger dan voorheen:

- **Optie C1 vervalt.** Geen product, geen roadmap-datum, en de enige route erheen loopt via een worker-group-token dat Trigger.dev Cloud aan een externe supervisor zou moeten uitgeven — server-side, ongedocumenteerd, en zonder account niet te verifiëren. Elke planning die op C1 leunt, leunt op een ~2 jaar oude "In Review"-feedbackpost.
- **Optie C2 (tunnel-sidecar) blijft een open vraag, niet een aanbevolen pad.** Of een sidecar in Trigger.dev's gehoste runtime kan draaien is onbevestigd door het onderzoek; er is geen aanwijzing dat het wél kan, dus dit weegt niet zwaarder dan voorheen.
- **Optie A (Neon) blijft af.** De weerlegging in punt (b) van de Revisie verandert hier niets aan: ADR-0004's eigen escape-hatch-voorwaarden (gemeten HA/RTO/RPO/contentie/ops-last-bewijs) zijn nog steeds niet vervuld, en A lost Manticore nog steeds niet op.
- **Optie D blijft een laatste redmiddel.** Koopt bereikbaarheid met een nieuw publiek aanvalsoppervlak en degradeert Trigger.dev's waarde tot cron-met-webhook — ongewijzigd door het onderzoek.
- **Optie B (volledige self-host op de Hetzner-box) is nu de enige overgebleven route die zowel ADR-0004 intact laat als op een daadwerkelijk gedocumenteerd, ondersteund deploymentpad staat** (Docker of Kubernetes, beide met gepubliceerde resource-eisen — Revisie, punt c). De prijs daarvan is nu preciezer bekend en hoger dan het eerder genoemde "~12 GB": **7+ vCPU / 14+ GB over twee Docker-hosts**, of 6+ vCPU/12+ GB in Kubernetes, plus het zelf operationeel dragen van vijf tot zeven stateful diensten (Postgres, Redis, ClickHouse, object storage, container registry, Electric, S2) — waarvan er één (ClickHouse) een eigen operationele last is — én het verlies van checkpoints/warm starts die Cloud wel biedt.
- **BYOC is vastgelegd maar niet aanbevolen.** Het is het enige andere product dat de spanning structureel oplost (heel het platform in eigen cloud-account), maar zonder publieke prijs of tier is het nu niet in te plannen; sales-led, dus geen bewijsstuk voor dit ADR totdat er een offerte is.

**De beslissende risicofactor is dus niet meer "ondersteunt Trigger.dev v4 Cloud een hybride worker" (beantwoord: nee), maar of de ~14 GB/7+ vCPU self-host-stack naast Postgres + Manticore op de box past zonder de DEC-005-prioriteit van Postgres te schenden.** Dat vergt de ADR-0003-cohortmeting die al in de oorspronkelijke tekst als bewijs voor B werd genoemd — die stap is ongewijzigd, alleen niet langer een "val terug op", maar het enige resterende pad. Status blijft Proposed: dit ADR kiest niet namens Ryan tussen "B nu bouwen" en "Cloud-orchestratie-besluit in orchestration.md:51 heroverwegen tegen deze nieuwe kosteninformatie" — dat weegt kosten (B: ~€60–80/mnd hardware-equivalent + volledige ops-last van 5-7 diensten) tegen het bestaande Cloud-tarief (€16→62/mnd) plus het feit dat er geen tussenweg (C1) meer is.

## Gevolgen

- Tot dit ADR is beslist, is de Hetzner-migratie geblokkeerd op orchestratie: de Coolify-compose kan niet worden afgerond zolang onduidelijk is of er een workercontainer in hoort ([slice-a-live-smoke.md](../runbooks/slice-a-live-smoke.md):70).
- Welke optie ook wint: het bewijs moet een *gedeployde/productie-achtige* run met volledig schrijfpad omvatten — het lokale bewijs van 2026-08-31 dekt dat expliciet niet.
- RJC-373 (`TRIGGER_SECRET_KEY` ontbreekt) moet vóór elk geautomatiseerd bewijs worden gesloten.

## Open vragen (niet in de repo vastgelegd)

**[HERZIEN 2026-08-31]** Vraag 1 (C1-ondersteuning) en vraag 3 (exact geheugenbeslag) uit de oorspronkelijke lijst zijn door onderzoek beantwoord — zie Revisie hierboven — en zijn hier verwijderd. Wat overblijft:

1. Kan een tunnel-sidecar (C2) daadwerkelijk draaien binnen Trigger.dev's gehoste runtime? Onbevestigd; niets in het onderzoek wijst op ja of nee.
2. Trigger.dev Cloud publiceert voor zover bekend geen vaste egress-IP-ranges; de enige allowlist-notitie in de repo betreft GCP Cloud NAT ([hosting-cost-comparison-2026-08.md](../research/hosting-cost-comparison-2026-08.md):114), niets over Trigger.dev. IP-allowlisting blijft dus geen aantoonbaar begaanbare route.
3. Werkelijke resourceruimte op de gekozen box (CX43/CPX32 start vs CCX33) naast Postgres + Manticore — ADR-0003-cohortmeting vereist. Nu de enige route naar B, en daarmee de facto de beslissende meting voor dit hele ADR.
4. BYOC: geen publieke prijs, tier of technische architectuur gevonden ([trigger.dev/changelog/bring-your-own-cloud](https://trigger.dev/changelog/bring-your-own-cloud), T2) — sales-led, dus niet in te plannen zonder offerte.
5. Kan een self-hosted supervisor `TRIGGER_API_URL` naar `api.trigger.dev` wijzen, en zou Trigger.dev Cloud daarbij een worker-group-token en bijpassende `MANAGED_WORKER_SECRET` uitgeven? Client-side houdt niets het tegen (geen allowlist/host-check in de supervisor-broncode), maar token-uitgifte en -validatie zijn server-side — dat is onbevestigd en niet testbaar zonder account. Dit is in de kern dezelfde vraag als de "In Review"-status van de self-hosted-workers-aanvraag, nu preciezer geformuleerd.

## Herziening 2 (2026-08-31) — optie A gekozen via ADR-0006

De aanbeveling hierboven — na de eerste revisie: **optie B**, omdat C1 geen bestaand product bleek — is dezelfde dag ingehaald door een eigenaarsbesluit. [ADR-0006](ADR-0006-neon-as-system-of-record.md) maakt **Neon het production system of record**, en daarmee is **optie A de gekozen route**. Beide eerdere lagen blijven hierboven ongewijzigd staan: ze leggen vast wat er bekend was op het moment van schrijven, en waarom de conclusie twee keer verschoof.

Wat dit met de argumentatie doet:

- Het bezwaar tegen A was tweeledig: (1) ADR-0004's escape-hatch-voorwaarden waren aantoonbaar niet vervuld, en (2) A lost Manticore niet op. Punt (1) is niet weerlegd maar **overruled** — ADR-0006 amendeert ADR-0004 expliciet en voert de omkering op bereikbaarheids- en operationele gronden, niet op de escape-hatch-criteria. Dat onderscheid hoort zichtbaar te blijven: de voorwaarden zijn niet alsnog gehaald.
- Punt (2) staat **volledig overeind**. Voor **Postgres** is de bereikbaarheidsvraag van dit ADR hiermee effectief beantwoord; voor **Manticore** niet. Een cloud-worker moet in het drain-pad ook `MANTICORE_URL` bereiken (`apps/worker/src/poll-bron-env.ts`), en Manticore staat privé. Die keuze — publieke ingress met authenticatie, een tunnel, of de drain on-box houden — is met ADR-0006 níét genomen en blijft de resterende blocker voor een volledig gedeployed schrijfpad.
- Optie B (volledige self-host) vervalt daarmee als noodzaak, maar de bijbehorende meting blijft nuttig als de Manticore-helft alsnog on-box wordt opgelost.

**De knoop is dus half gelegd, en dat moet expliciet blijven staan.** Een gedeployde worker die Neon bereikt maar Manticore niet, faalt in `poll-bron` — niet bij het schrijven naar Postgres, maar bij de drain erna. Een onderzoek naar Upstash Search als managed alternatief is op 2026-08-31 uitgevoerd en negatief beoordeeld: geen booleaanse tekstqueries, geen facetten, geen gedocumenteerde Nederlandse taalanalyse, geen totaaltelling of `offset`, en een limiet van 4.096 tekens per document. Dat lost de bereikbaarheid wél op maar kost drie eigenschappen die het product draagt. De goedkopere kandidaten — Manticore achter TLS met authenticatie, of de bestaande `postgres-fts-fallback` die op Neon per definitie bereikbaar is — zijn nog niet uitgewerkt.
