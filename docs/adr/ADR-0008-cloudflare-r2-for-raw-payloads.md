# ADR-0008 — Cloudflare R2 als raw-payload-store

- Status: Accepted
- Datum: 2026-09-01
- Eigenaar: Job Intelligence platform (besluit: Ryan, 2026-09-01)
- Gerelateerd: ADR-0006, ADR-0007, RJC-386, interne kostenkaart (intern operator-document, niet in deze repo), [raw-object-storage.md](../runbooks/raw-object-storage.md), [hetzner-deploy.md](../runbooks/hetzner-deploy.md), [replay-and-backfill.md](../runbooks/replay-and-backfill.md)

## Besluit

**De productie-raw-object-store (ruwe connectorpayloads, RJC-386) draait op
Cloudflare R2 — een S3-compatible bucket buiten de applicatiebox — niet op
MinIO op de Hetzner-box zelf.** Dit sluit de UNDECIDED uit
[hetzner-deploy.md](../runbooks/hetzner-deploy.md) § 1 en stap 6. MinIO
blijft bewust bestaan als lokale ontwikkel-target; dev en productie delen
dezelfde S3-client, dus de pariteit blijft.

**Dit besluit vergt nul regels applicatiecode.** `createRawObjectStore`
(`packages/connectors/src/s3-object-client.ts`) kiest de S3-backend zodra
`RAW_S3_BUCKET` is gezet en praat via Bun's ingebouwde `Bun.S3Client` met
elk S3-compatible endpoint. MinIO, R2 en elke andere S3-provider verschillen
uitsluitend in endpoint en credentials. De keuze is puur configuratie.

## Context en onderbouwing

1. **"Geen van beide" was nooit een optie.** In productie weigeren zowel de
   server als de gewone poll-worker de filesystem-fallback:
   `createProductionSliceADeps` (`apps/server/src/slice-a-registry.ts`) gooit
   bij `nodeEnv === "production"`, en `createPollBronRuntime`
   (`apps/worker/src/poll-bron-run.ts`) bij
   `process.env.NODE_ENV === "production"`, zodra de resolved store
   `filesystem` is. De productiebackfill heeft daarnaast een onafhankelijke,
   expliciete gate: `resolveBackfillObjectStore`
   (`packages/db/src/backfill-runner.ts`) weigert in execution mode
   `production` alles wat niet `kind: "s3"` is. En zou de serverguard ooit
   omzeild raken, dan rapporteert `/readyz` de component `rawObjectStore` als
   `failed` met reason `filesystem_backend_in_production` → overall
   `unavailable`, HTTP 503 (`apps/server/src/readiness.ts`,
   `evaluateRawObjectStore`). Een S3-compatible store móest er komen; open
   was alleen de provider.

2. **S3-compatibiliteit is geverifieerd tegen ons werkelijke gebruik, niet
   aangenomen.** R2 ondersteunt een reeks S3-features níet: ACL-operaties,
   object locking, AWS KMS, request payer, object tagging, bucket policies,
   versioning, replication, logging, website hosting, MFA-headers, bucket
   acceleration en notifications
   ([R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/), gelezen
   2026-09-01). Onze `S3ObjectClient` gebruikt uitsluitend `exists`,
   `write`, `file`, `list` en `delete` — kern-S3, en geen enkel item van die
   lijst. De `ObjectStore`-interface is bovendien maar drie methoden groot
   (`put`, `get`, `deleteExpired`). Er is dus geen feature-gat.

3. **Nul egress is het beslissende verschil.** R2 rekent **$0/GB uitgaand
   verkeer**; opslag is $0,015/GB-maand, Class A-operaties (writes, list)
   $4,50/miljoen, Class B (reads) $0,36/miljoen, met een gratis tier van
   10 GB-maand, 1M Class A en 10M Class B
   ([R2 pricing](https://developers.cloudflare.com/r2/pricing/), gelezen
   2026-09-01). Ruwe orde van grootte bij de jaar-1-aannames uit interne kostenkaart
   (45–90 GB raw, ~1–1,2M fetches/maand, en onze client schrijft body +
   metadata als twee objecten): opslag ≈ $1,20/mnd na de gratis 10 GB,
   writes ≈ $6/mnd na de gratis 1M — samen grofweg **$7/maand**. Dat is
   vergelijkbaar met de €6,49 van Hetzner Object Storage, maar zonder
   egresslimiet. Dat laatste telt hier zwaar: replay-en-backfill leest
   payloads mássaal terug, en dat is precies het verkeer dat bij elke
   andere provider de rekening onvoorspelbaar maakt.

4. **Schijfruimte is de schaarste op de box.** De CCX33-kandidaat heeft
   240 GB NVMe totaal (interne kostenkaart), voor OS + de Manticore-index (corpus
   geprojecteerd op 7,5M docs na 12 maanden) + al het overige. MinIO's
   "gratis" opslag betaalt dus in de schaarste grondstof van de box en
   concurreert met Manticore om dezelfde NVMe-I/O. interne kostenkaart scenario (c)
   plant om verwante redenen al een aparte AX42-searchbox in jaar 2 — de
   box vollopen met raw payloads versnelt dat moment zonder iets op te
   leveren.

5. **Blast radius / gecorreleerde failure.** De raw store is de ontworpen
   replay-bron: RJC-386 bestaat precies zodat opgeslagen payloads later per
   `rawPayloadRef` + `contentHash` terugleesbaar zijn. Eerlijkheidshalve:
   replay-vanaf-de-object-store is vandaag **nog niet geïmplementeerd** —
   `replayBron` gooit op `kind: "object-store"` en
   [replay-and-backfill.md](../runbooks/replay-and-backfill.md) markeert het
   als toekomstwerk; alleen fixture-replay werkt. Dat verandert het argument
   niet: raw payloads die mét de box sterven, sluiten dat pad voorgoed af
   nog vóór het gebouwd is. Met Neon als SoR (ADR-0006) overleeft een dode
   box de zoekindex — die is volledig herbouwbaar uit Postgres en outbox —
   maar originelen zijn nergens anders. De replay-bron co-lokeren met precies
   datgene waarna je wilt replayen is een gecorreleerde failure; een externe
   bucket ontkoppelt die.

6. **MinIO blijft — voor lokaal.** `raw-storage-minio` (+ init) in
   `docker-compose.yml` is en blijft de lokale dev/CI-target achter
   `--profile storage`. Omdat beide kanten dezelfde `createRawObjectStore`
   gebruiken, is dev/prod-pariteit een eigenschap van de client, niet van de
   provider.

## Afgewogen alternatieven

- **Hetzner Object Storage** (€6,49/mnd incl. 1 TB opslag + 1 TB egress) was
  de eerste keuze van dit ADR. Afgevallen om één praktische en één
  inhoudelijke reden: de bucket bestaat niet en de Hetzner-box zelf is nog
  niet besteld (`<TBD: Ryan>` in hetzner-deploy.md), én het 1 TB-egressplafond
  is precies de as waarop replay onvoorspelbaar wordt. Blijft een geldig
  alternatief zodra de box er staat; de migratie is een endpoint- en
  credentialwissel, geen codewijziging.
- **Vercel Blob** is overwogen en afgevallen op een harde technische grond:
  het is **niet S3-compatible**. Er is geen S3-endpoint; toegang loopt
  uitsluitend via de `@vercel/blob`-SDK
  ([Vercel Blob docs](https://vercel.com/docs/vercel-blob), gelezen
  2026-09-01). Dat zou een nieuwe `ObjectStore`-adapter vergen in plaats van
  configuratie, en buiten Vercel (onze worker draait op Trigger.dev) een
  langlevende `BLOB_READ_WRITE_TOKEN` in plaats van de OIDC-rotatie die
  Vercel binnen zijn eigen platform biedt. Bovendien rekent het data transfer
  op downloads — dezelfde replay-as waarop R2 juist nul kost.
- **MinIO op de box**: zie punt 4 en 5.

## Consequenties

- **Nieuwe verplichte productie-env** (namen uit
  `packages/connectors/src/s3-object-client.ts`):
  - `RAW_S3_BUCKET` = `<TBD: Ryan — bucketnaam>`
  - `RAW_S3_ENDPOINT` = `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
    (endpointformaat uit de R2-docs; `<ACCOUNT_ID>` is `<TBD: Ryan>`)
  - `RAW_S3_ACCESS_KEY_ID` / `RAW_S3_SECRET_ACCESS_KEY` = `<TBD: Ryan —
    aanmaken via R2 → Manage API Tokens>`
  - `RAW_S3_REGION` — **kan leeg blijven.** R2 verwacht `auto`, en de
    R2-docs stellen expliciet dat `us-east-1` en lege waarden naar `auto`
    aliassen; onze code-default ís `us-east-1`, dus dit werkt ongezet.

  Server én worker krijgen exact dezelfde waarden — verschillende backends
  per kant is precies de failure die RJC-386 dichtte.

- **Egress-latentie i.p.v. loopback.** Elke raw write/read gaat over het
  netwerk naar een extern endpoint in plaats van naar een lokale MinIO. Voor
  dit schrijfpad (één object per fetch, geen hot path in search) is dat
  acceptabel; het is wel een eigenschap, geen gratis lunch.

- **Operationele readiness-eigenschap:** een onbereikbare of trage S3-bucket
  maakt `/readyz` `rawObjectStore: degraded` (reason `unreachable`/`timeout`)
  → overall `degraded`, **HTTP 200** — de loadbalancer blijft routeren en
  search blijft werken; alleen ingest-reads/replay lijden
  (`apps/server/src/readiness.ts`, `evaluateRawObjectStore`: alleen
  filesystem-in-productie is `failed`). Een R2-storing haalt het product dus
  niet uit de lucht.

- **Poll-worker en productiebackfill falen gesloten.** De gewone
  Trigger.dev-poll-worker weigert zijn runtime op te bouwen wanneer
  `NODE_ENV=production` en de store naar `filesystem` resolveert
  (`createPollBronRuntime`). De productiebackfill gebruikt niet die
  `NODE_ENV`-gate, maar de strengere expliciete execution-mode-gate in
  `resolveBackfillObjectStore`: alleen `kind: "s3"` wordt geaccepteerd. Deze
  guards bewijzen nog niet dat server en worker exact dezelfde bucket,
  endpoint, regio en credentials kregen, of dat een live R2-write plus
  readback werkt. Die env-pariteit en live verificatie blijven daarom harde
  deploygates ([hetzner-deploy.md](../runbooks/hetzner-deploy.md) § 2 en stap
  6).

## Open punten — eerlijk

- **Bucket, account-id en keys bestaan nog niet** — aanmaken is een
  operator-actie van Ryan; dit ADR verzint er geen namen voor.
- **Een rotatiepad voor de bucket-credentials bestaat niet.** Zelfde klasse
  gat als ADR-0006 voor de Neon-credential flagde (RJC-371): de
  `RAW_S3_SECRET_ACCESS_KEY` ontsluit de volledige replay-bron, en er is geen
  gedocumenteerde procedure om hem te roteren zonder ingest-downtime.
  Vastleggen bij het aanmaken van de bucket, niet erna.
- **Wat dit besluit heropent:** groeit het aantal writes ver voorbij de
  aannames, dan gaan Class A-operaties ($4,50/miljoen) domineren in plaats
  van opslag — de kostencurve van R2 hangt aan operaties, niet aan volume.
  Retentie helpt hier vandaag niet automatisch: er bestaat nog geen purge-job
  voor verlopen raw objects
  ([raw-object-storage.md](../runbooks/raw-object-storage.md) § Deferred
  follow-ups). Ook de Infrequent Access-klasse ($0,01/GB-maand opslag, maar
  $0,01/GB retrieval en 30 dagen minimumduur) is bewust **niet** gekozen:
  replay leest onvoorspelbaar terug, en retrievalkosten zijn precies wat we
  met R2 wilden vermijden.
- **Geen enkele latency- of durability-meting tegen een echte R2-bucket is
  gedaan** — alle S3-bewijs is lokaal (MinIO). De eerste deploy-verificatie
  (hetzner-deploy.md stap 6) is tegelijk de eerste echte meting.
