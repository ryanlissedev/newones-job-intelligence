# Hetzner-deploy — de geordende procedure

Dit runbook sequencet de bestaande subsysteem-runbooks tot één geordende
deploy die deze repo naar een draaiende Hetzner-host brengt. Het is in het
Nederlands geschreven omdat de runbooks waar het naar verwijst
([coolify-local.md](coolify-local.md), [postgres-on-box.md](postgres-on-box.md))
dat ook zijn. Elke claim hieronder komt uit een bestand in deze repo; waar
iets nog niet besloten of nog niet bewezen is, staat dat er expliciet bij —
een `<TBD: …>` is een echte open beslissing, geen placeholder om in te
vullen.

> **Status (live geverifieerd 2026-09-03):** productie draait op Hetzner-server
> `<hetzner-server-id>`, naam `<hetzner-server-name>`, IP `<hetzner-ip>`, type CX43 in
> Neurenberg (`nbg1`) en Ubuntu 26.04. De server is in-place met
> `hcloud server change-type` omgezet van CPX32 naar CX43. De applicatie is via
> tijdelijke `sslip.io`-hostnamen gerehearsed; de definitieve DNS-cutover en de
> overige gates in dit runbook blijven afzonderlijk bewijs vereisen.

## 1. Service-topologie

`docker-compose.yml` definieert negen services. Niet alles daarin is een
productieservice — de compose-file bedient óók de lokale/CI-lane van
[ADR-0004](../adr/ADR-0004-postgres-environment-strategy.md). Verdict per
service, met bron:

| Compose-service | Op de Hetzner-box in productie? | Onderbouwing |
|---|---|---|
| `postgres` | **Ja — Coolify Postgres-resource (ADR-0011 / RJC-418).** | Productie-SoR verhuist van Neon Free terug on-box. Coolify-apps bereiken hem via het interne netwerk; Trigger.dev Cloud via static egress-IP’s in firewall `catapulze-prod` op TCP 5432. Compose-Postgres blijft daarnaast de lokale/CI-evidence-lane (ADR-0004). Cutover-DoD: RJC-418. |
| `web` | **Ja.** | Next.js-frontend, poort 3001, Dockerfile `apps/web/Dockerfile`; als Coolify-application per [coolify-local.md](coolify-local.md) § Coolify-proef. |
| `server` | **Ja.** | Hono/tRPC-API, poort 3000, Dockerfile `apps/server/Dockerfile`, Docker HEALTHCHECK `/livez` (niet `/readyz` — Coolify rollbackt bij HEALTHCHECK-fail). |
| `redis` | **Ja.** | Zoekresultaat-cache (RJC-388). `REDIS_URL` is optioneel in `packages/env/src/server.ts` — zonder Redis draait de in-process cache — maar in productie weigert de server te starten wanneer een geconfigureerde Redis bij boot onbereikbaar is (`createResultCache`, [ADR-0007](../adr/ADR-0007-search-platform-state-2026-09-01.md), "Invarianten"). |
| `manticore` | **Ja — fallback.** | De bestaande Manticore 6.3.8-service blijft beschikbaar als terugvalpad, maar ontvangt niet de actuele productieprojectie zolang server en projector naar Manticore 29 wijzen. Beide enginepoorten blijven privé per ADR-0006. |
| `manticore29` | **Ja — actuele productie-engine.** | Manticore 29.0.2 draait als Coolify-service `manticore-29`, met hostpoort `127.0.0.1:9312` en intern HTTP op 9308. De hybrid-richting blijft Proposed; zie [search-engine-decision-2026-09-03.md](../research/search-engine-decision-2026-09-03.md) en ADR-0009. |
| `projector` | **Ja — als aparte Coolify-application op de box.** | On-box search-projector (RJC-387): leest de Postgres-outbox (na RJC-418: on-box; tot cutover nog Neon) en schrijft via het private Coolify-netwerk naar Manticore. Dockerfile `apps/server/Dockerfile.projector` hergebruikt de server-imagebuild met `CMD ["bun","run","projector"]`; de compose-service achter profile `projector` gebruikt dezelfde image-role. |
| `poller` | **Ja, als aparte Coolify-application op de box.** | On-box poller: leest `curated.bron.interval` per bron, draait de due bronnen met maximaal `POLLER_CONCURRENCY` tegelijk (standaard 2) en cureert de achterstand binnen een tijdbudget per bron per cyclus. Vervangt de Trigger.dev-schedule `schedule-slice-a-polls` en de taak `poll-bron`, die in dezelfde wijziging zijn verwijderd. Dockerfile `apps/worker/Dockerfile.poller` met `CMD ["bun","src/poller/main.ts"]`; de compose-service achter profile `poller` gebruikt dezelfde image-role. Singleton via een eigen advisory-lockconstante, los van die van de projector. Zie [onbox-poller.md](onbox-poller.md). |
| `raw-storage-minio` + `raw-storage-minio-init` | **Nee — lokale S3-target.** | Het compose-commentaar (RJC-386) noemt dit expliciet een "local S3-compatible target". Productie draait op een S3-compatible store: server en gewone poll-worker weigeren de filesystem-backend in productie, en de productiebackfill accepteert alleen `kind: "s3"` ([raw-object-storage.md](raw-object-storage.md) § Production guard). De provider is **beslist: Cloudflare R2** ([ADR-0008](../adr/ADR-0008-cloudflare-r2-for-raw-payloads.md)) — bestaan en configuratie van bucket en keys moeten live worden geverifieerd en zo nodig ingericht. |

Niet in compose, wél onderdeel van productie:

- **Worker (Trigger.dev Cloud).** Draait buiten de box
  ([ADR-0005](../adr/ADR-0005-trigger-dev-database-reachability.md);
  `apps/worker/trigger.config.ts`). Nog op Trigger: `enrich-incomplete`,
  `schedule-enrich-incomplete`, `drain-outbox` en `backfill-neon-v1`. Pollen en
  cureren zijn hier weg en draaien on-box in de `poller`-application
  ([onbox-poller.md](onbox-poller.md)). In productie: `SEARCH_PROJECTOR=onbox`
  en géén `MANTICORE_URL` ([search-projector.md](search-projector.md)
  § Deploy contract).
- **Migrator-job.** One-shot container op `apps/server/Dockerfile.migrate`
  (`CMD ["bun","run","db:migrate"]`), per
  [coolify-local.md](coolify-local.md) § Coolify-proef.
  Coolify migrator app needs `health_check_enabled=false` (do not set `HEALTHCHECK` in the Dockerfile — `HEALTHCHECK NONE` still breaks Coolify on missing `.State.Health`).

### Deployment-scope-invariant

Catapulze is momenteel **single-tenant per deployment**. De server bepaalt de
scope met de vaste waarde `CATAPULZE_DEPLOYMENT_SCOPE_ID = "catapulze"` in
`apps/server/src/slice-a-registry.ts`; dit is bewust geen environmentvariabele
en kan niet via een request-body, header, gebruikersrol of Better Auth-profiel
worden overschreven. Alle duurzame gebruikerswrites en hun audit/exportrecords
dragen deze `scope_id`.

Een approver/operator binnen dezelfde deployment mag daarom een snapshot van
een andere gebruiker verwerken. Een lookup naar een snapshot, approval of
export uit een andere deployment-scope faalt gesloten als `NOT_FOUND`. Een
latere multi-tenantvariant vereist eerst identity-backed tenantlidmaatschap en
een nieuwe autorisatiebeslissing; alleen de scope configureerbaar maken is niet
voldoende.

## 2. Environment-inventaris

Bron: de `${VAR}`-referenties in `docker-compose.yml` plus wat de processen
werkelijk lezen (`packages/env/src/server.ts`, `packages/env/src/database.ts`,
`apps/server/src`, `apps/worker/src`, `packages/db/drizzle.config.ts`).
Waarden komen uit 1Password (`op run`, [coolify-local.md](coolify-local.md))
of Coolify's secret-UI; **geen enkele secretwaarde hoort in dit document, in
git of in chat.**

### Server (apps/server) — leest via `packages/env/src/server.ts`

| Variabele | Verplicht | Zonder deze | Wie levert |
|---|---|---|---|
| `DATABASE_URL` | ja | boot faalt (zod `min(1)`); compose mapt hem van `CATAPULZE_DATABASE_URL` | **Productie (ADR-0011):** on-box Coolify Postgres app-rol (`ji_app`) op intern netwerk. Neon alleen als tijdelijke pre-cutover / rollback. Secrets via 1Password / Coolify UI — nooit in git. |
| `BETTER_AUTH_SECRET` | ja (min. 32 tekens) | boot faalt | operator/1Password |
| `BETTER_AUTH_URL` | ja (URL) | boot faalt | operator: publieke API-URL |
| `CORS_ORIGIN` | ja (URL) | boot faalt | operator: publieke web-URL |
| `APP_RELEASE_SHA` | **nee** — laat weg in Coolify | de server gebruikt `SOURCE_COMMIT`, dat Coolify in iedere container injecteert (de exacte gebouwde commit); `/version` echoot die waarde. Alleen zetten om bewust te overriden, en dan uitsluitend een 40-teken lowercase Git-SHA: iedere andere waarde (bijv. een branchnaam) laat de boot falen met `Invalid environment variables` en rolt elke rolling update terug (productie, 2026-09-04) | Coolify (`SOURCE_COMMIT`) |
| `MANTICORE_URL` | nee, default `http://127.0.0.1:9308` | zoekopdrachten en `/readyz`-manticore-check falen als de default niet klopt | Productie-API en -projector: `http://manticore29-<service-uuid>:9308` via **Connect to Predefined Network**; handmatige host-readback van Manticore 29: `http://127.0.0.1:9312`; lokaal compose: `http://manticore:9308` |
| `REDIS_URL` | nee | in-process cache; `/readyz` meldt `redis: not-configured` | operator; on-box Redis |
| `RAW_S3_BUCKET` (+ `RAW_S3_ENDPOINT`, `RAW_S3_REGION`, `RAW_S3_ACCESS_KEY_ID`, `RAW_S3_SECRET_ACCESS_KEY`) | in productie effectief ja | zonder `RAW_S3_BUCKET` valt de store terug op filesystem en **weigert de server in productie te starten** (`apps/server/src/slice-a-registry.ts`, RJC-386) | operator; provider beslist: Cloudflare R2 ([ADR-0008](../adr/ADR-0008-cloudflare-r2-for-raw-payloads.md)); bestaan/configuratie live verifiëren en zo nodig inrichten |
| `RAW_OBJECT_STORE_PATH` | nee | alleen relevant voor de filesystem-fallback (niet-productie) | — |
| `NODE_ENV` | nee (default `development`) | productie-guards (filesystem-weigering, Redis-boot-weigering) staan dan uit — zet hem in productie dus expliciet op `production` | deploy-configuratie |
| `PORT` | nee (default 3000) | — | deploy-configuratie |
| `OPENROUTER_API_KEY` | alleen voor de Marktvragen-chat | `POST /marktvragen/chat` geeft 503 `CHAT_NOT_CONFIGURED` en het paneel toont een nette foutmelding; de rest van de API blijft werken | operator/1Password — server-app env in Coolify, komt nooit in de browser |
| `MARKTVRAGEN_CHAT_MODEL` | nee (default `openai/gpt-oss-120b`) | — | operator, modelkeuze; de `:free`-variant van die slug is door OpenRouter uitgeschakeld (404) |

### Web (apps/web) — leest via `packages/env/src/web.ts`

| Variabele | Verplicht | Zonder deze | Wie levert |
|---|---|---|---|
| `NEXT_PUBLIC_SERVER_URL` | ja (URL) | build en boot falen (zod) | operator: publieke API-URL — als build-arg (wordt in de browserbundel ingebakken) én als runtimevariabele; nooit `server:3000` ([coolify-local.md](coolify-local.md)) |
| `INTERNAL_SERVER_URL` | nee (valt terug op `NEXT_PUBLIC_SERVER_URL`) | server-side fetches van Next.js (de Better Auth-sessiecheck in `apps/web/src/app/dashboard/page.tsx`) gaan naar de publieke URL; routeert die niet vanuit de web-container (`localhost:3000` is dáár de web-container zelf), dan rendert `/dashboard` een 500 met `ECONNREFUSED 127.0.0.1:3000` — ook voor uitgelogde bezoekers, die dan geen redirect naar `/login` meer krijgen | deploy-configuratie: de interne API-URL zoals de web-container die ziet — compose zet `http://server:3000`; in Coolify de interne servicenaam en poort van de `server`-application. Alleen runtimevariabele, geen build-arg; komt nooit in browsercode (t3-env `server`-scope gooit bij client-toegang) |

### Worker (apps/worker, Trigger.dev) — leest `process.env` direct

One-shot na Coolify on-box: [trigger-on-box-cutover.md](trigger-on-box-cutover.md) (static IPs + firewall + Trigger `DATABASE_URL`).

| Variabele | Verplicht | Zonder deze | Wie levert |
|---|---|---|---|
| `DATABASE_URL` | ja (`packages/env/src/database.ts`) | taken falen bij import | **Na RJC-418:** on-box `ji_app` URL via Trigger static-IP allowlist ([trigger-on-box-cutover.md](trigger-on-box-cutover.md)). Tot die flip: Neon pooled TLS-URL (tijdelijk). |
| `SEARCH_PROJECTOR` | productie: `onbox` | default `worker` = inline drain, en dan eist de worker Manticore-toegang die hij in de cloud niet heeft ([search-projector.md](search-projector.md)) | deploy-configuratie |
| `MANTICORE_URL` | alleen in `worker`-modus | in `onbox`-modus bewust afwezig | — |
| `RAW_S3_*` (zelfde vijf als server) | in productie ja | met `NODE_ENV=production` weigert de gewone poll-worker de filesystem-backend; de productiebackfill weigert onafhankelijk alles behalve `kind: "s3"` (RJC-386) | exact dezelfde bucket, endpoint, regio en credentials als de server |
| `NODE_ENV` | productie: `production` | de filesystem-weigering van de gewone poll-worker staat anders uit; de productiebackfill blijft apart fail-closed via execution mode | deploy-configuratie |
| `TENDER_NED_TEST_IMPORT_DAYS` | nee (default 14, bereik 1–90) | — | operator, alleen voor test-imports |
| Per-bron live-vlaggen (`TENDER_NED_LIVE`, `INHUURDESK_LIVE`, …) | per bron | bron draait op fixtures i.p.v. live HTTP (`process.env[source.liveEnv] === "1"` in `apps/worker/src/poll-bron-run.ts`; namen in `packages/application/src/sources/*.ts`; de `poller`-app heeft dezelfde twaalf vlaggen nodig, zie `docs/runbooks/onbox-poller.md`) | operator, per bron-activatiebesluit |
| `TRIGGER_PROJECT_REF` | ja (`trigger.config.ts` weigert te laden zonder) | — | Trigger.dev-project |
| `TRIGGER_SECRET_KEY` | voor programmatisch triggeren/deployen | productieconfiguratie is onbewezen/open (RJC-373); gedeployd bewijs ontbreekt | `<TBD: Ryan/Trigger.dev-account>` |

### Projector (on-box proces)

- `DATABASE_URL`: on-box `ji_app` op het Coolify-interne netwerk (Neon alleen pre-cutover);
- `PROJECTOR_DATABASE_URL`: dezelfde on-box database, **directe** session-URL voor de advisory lock (geen pooler-host). Lokaal mag dat dezelfde Compose-URL zijn;
- `MANTICORE_URL=http://manticore29-<service-uuid>:9308` via hetzelfde
  predefined Coolify-network als Manticore. Alleen een handmatige host-run
  gebruikt voor productie-Manticore 29 `http://127.0.0.1:9312`.

De getypeerde projector-env weigert te starten als een variabele ontbreekt.
Als je tijdelijk nog Neon gebruikt, weigert hij ook een bekende Neon-poolerhost
als `PROJECTOR_DATABASE_URL` ([search-projector.md](search-projector.md)).

### Migraties

`MIGRATION_DATABASE_URL` — aparte migrator-rol; `packages/db/drizzle.config.ts`
eist deze variabele expliciet en gebruikt `DATABASE_URL` nooit als fallback.
Alleen de one-shot migrator krijgt deze credential; de server-runtime nooit
([coolify-local.md](coolify-local.md)).

### Alleen lokale/CI-lane (staan wel in compose, niet op de productiebox)

`POSTGRES_ADMIN_USER`, `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_DB`,
`POSTGRES_MIGRATOR_USER`, `POSTGRES_MIGRATOR_PASSWORD`, `POSTGRES_APP_USER`,
`POSTGRES_APP_PASSWORD`, `POSTGRES_HOST_PORT`, `POSTGRES_CPU_LIMIT`,
`POSTGRES_MEMORY_LIMIT`, `POSTGRES_MEMORY_RESERVATION`, `POSTGRES_SHM_SIZE`,
`POSTGRES_DATA_VOLUME`, `RAW_STORAGE_MINIO_ROOT_USER`,
`RAW_STORAGE_MINIO_ROOT_PASSWORD`, `RAW_STORAGE_MINIO_API_PORT`,
`RAW_STORAGE_MINIO_CONSOLE_PORT`, `MANTICORE29_HTTP_PORT`,
`MANTICORE29_MYSQL_PORT`, `MANTICORE_HTTP_PORT`, `MANTICORE_MYSQL_PORT`,
`REDIS_HOST_PORT`. `NEXT_PUBLIC_SERVER_URL` en `INTERNAL_SERVER_URL` staan
ook in compose, maar horen bij de web-inventaris hierboven en zijn in
productie wél nodig (publieke resp. interne API-URL — nooit `server:3000` in
browsercode, [coolify-local.md](coolify-local.md)).

Bij het controleren van env-waarden: scrub elke Postgres-URL vóór hij een
terminal of log raakt — `sed -E 's#postgres(ql)?://[^ "]+#<url>#g'` — en
gebruik nooit `set -x`/`env`/`printenv` in deze route
([coolify-local.md](coolify-local.md)).

Coolify bewaart elke variabele als twéé rijen: een gewone rij en een
preview-rij (`is_preview = true`). `POST /api/v1/applications/{uuid}/envs`
(en in sommige paden ook de UI) kan de gewone rij **leeg** achterlaten
terwijl alleen de preview-rij de waarde draagt; de container krijgt dan een
lege variabele. Zo draaide op 2026-09-04 de migrator met een lege
`MIGRATION_DATABASE_URL` en stopte hij zonder iets toe te passen. De API is
hier geen bewijs: `is_shown_once`-waarden komen gemaskeerd (leeg) terug, dus
"lengte 0" via de API zegt niets. Controleer in Coolify's eigen Postgres:

```bash
docker exec coolify-db psql -U coolify -d coolify -At -c \
  "select key, is_preview, is_shown_once, length(value)
   from environment_variables ev
   join applications a on a.id = ev.resourceable_id
   where a.uuid = '<application-uuid>'"
```

Een lengte `0` of `NULL` op de niet-preview-rij is een echt lege variabele.
Herstel: verwijder die rij (`DELETE /api/v1/applications/{uuid}/envs/{env-uuid}`)
en POST hem opnieuw — dat maakt beide rijen weer aan. De query toont alleen
sleutels en lengtes, nooit waarden; houd dat zo.

## 3. Geordende deploy-sequentie

Elke stap eindigt met een verificatie. Ga niet door zolang die faalt.

### Stap 0 — Hersteltoegang en releasegates

Alleen punt 1 is de harde preconditie voor stap 0.5. Punten 2 en 3 blokkeren
de daarbij genoemde releasestap, maar blokkeren het hostherstel zelf niet.

1. Hersteltoegang is beschikbaar: de operator kan de Hetzner Console openen
   en heeft de benodigde SSH- en Coolify-credentials via 1Password. Dit is de
   preconditie om stap 0.5 te starten; verse boot-, SSH- en Coolify-evidence is
   de uitkomst van die stap en de harde gate vóór stap 1.
2. RJC-371 (gelekte Neon-credential) is geroteerd en de nieuwe credential
   bestaat alleen in 1Password (ADR-0006, "Open punten").
3. **RJC-402: lees eerst de actuele Neon-journal en het bijbehorende schema.**
   De gereviewde integratiebasis
   `80e2882447e1a678855c1334aa30a752808d0f7c` bevat exact 15 geordende
   migraties (`0000`–`0014`), met als staart
   `0013_durable_user_writes` → `0014_auth_user_role`. Een latere release
   moet de verwachte set dynamisch uit zijn eigen volledige `DEPLOY_SHA`
   afleiden; gebruik nooit een bewegende `main`-ref of alleen een count.
   De historische rehearsal in
   [neon-migration-catchup.md](neon-migration-catchup.md) dekt alleen
   `0006`–`0011`. Een lokale, niet-gepubliceerde operatorrecord van
   2026-09-01 claimde een live journal van 13 entries, maar een actuele
   read-only Neon-readback ontbreekt en die claim bewijst `0013`/`0014` niet.
   Draai de catch-up niet voordat de live journal een exact voorvoegsel van
   de deployment-SHA-set is, alle betrokken schema-objecten zijn gelezen, de
   exacte pending set op een verse productiesnapshot is gerehearsed, alle
   writers zijn gepauzeerd, de finale preflight gelijk blijft, een verse
   rollbackbranch inclusief queryability is gevalideerd en de operator pas
   daarna expliciet GO geeft voor exact die evidence.
4. Deploymethode op de box: Coolify draait op `<hetzner-server-name>`. Gebruik
   [coolify-local.md](coolify-local.md) en stap 0.5 hieronder als herstel- en
   validatiepad; voer provisioningstappen niet blind opnieuw uit.

### Stap 0.5 — Host-provisioning en herstelpad voor de host die stap 1 aanneemt

> ⚠️ **INSPECTEER VÓÓR MUTATIE.** Server `<hetzner-server-id>` en Coolify zijn op
> 2026-09-03 live geverifieerd. De opdrachten hieronder blijven een herstel- of
> rebuildpad, geen instructie om bestaande infrastructuur zonder inspectie
> opnieuw aan te maken. Console- en credentialtoegang uit stap 0 zijn vereist
> vóór dit herstel begint. Voer herstel uit met de Console ernaast en kies bij
> twijfel over een firewallregel eerst de Console-route, die je nooit
> buitensluit.

#### 0.5.1 Bestaande server controleren of vervanging bestellen

De productiehost is Hetzner-server `<hetzner-server-id>`, naam
`<hetzner-server-name>`, publiek IPv4 `<hetzner-ip>`: **CX43**, Ubuntu 26.04,
in Neurenberg (`nbg1`). Op 2026-09-03 is deze host in-place met
`hcloud server change-type` omgezet van CPX32 naar CX43. De toen geverifieerde
maandprijzen in `nbg1` waren €19,35 voor CX43 en €42,94 voor CPX32. Geef bij
gelijke geschiktheid voorkeur aan CX, maar controleer eerst actuele voorraad,
type en prijs met `hcloud server-type list`; CX-capaciteit kan ontbreken.

Alleen bij vervanging, via `hcloud` (bron: hcloud CLI, `--help`-gedreven;
volgorde is verplicht — key en firewall moeten bestaan vóór `server create`
ze refereert; gecheckt 2026-09-01):

```bash
hcloud context create catapulze          # token uit Console → project → Security → API Tokens
hcloud location list                     # kies bewust; <TBD: Ryan — locatie>
hcloud server-type list                  # verifieer type + actuele prijs
hcloud ssh-key  create --name <TBD-keynaam> --public-key-from-file ~/.ssh/<TBD>.pub
hcloud firewall create --name <TBD-fw-naam> --rules-file rules.json   # zie 0.5.2
hcloud server   create --name <TBD-servernaam> --type <TBD-servertype> --image ubuntu-26.04 \
                --location <TBD-locatie> --ssh-key <TBD-keynaam> --firewall <TBD-fw-naam>
```

Bij vervanging via de Console (voor wie geen `hcloud` heeft):
console.hetzner.cloud → project → "Add Server" → locatie →
image **Ubuntu 26.04** (Coolify ondersteunt Debian-based; bron:
coolify.io/docs installatiepagina, gecheckt 2026-09-01) → passend type →
SSH-key uploaden → firewall koppelen → Create.

Let op (hcloud-skill gotcha's): publieke IP's worden hergebruikt — na een
eerdere serververwijdering kan `ssh` weigeren met "REMOTE HOST
IDENTIFICATION HAS CHANGED"; dat is dan het oude host-key-record, niet een
aanval (`ssh-keygen -R <ip>` en opnieuw verifiëren).

Een 1Password SSH-item levert de private key standaard als PKCS#8. Exporteer
voor OpenSSH daarom expliciet met:

```bash
umask 077
trap 'rm -f <tijdelijk-keypad>' EXIT
op read "op://<vault>/<item-ssh-key>/private key?ssh-format=openssh" > <tijdelijk-keypad>
```

De restrictieve `umask` geldt vóórdat shell-redirection het bestand aanmaakt;
de trap verwijdert het na de sessie. Zonder `?ssh-format=openssh` weigert
`ssh-keygen` de sleutel met `invalid format`. Log of commit de sleutel nooit.

Het SSH-item heet `<item-ssh-key>` in de vault `<vault>` en
het veld heet `private key`. De overige productiewaarden staan in dezelfde
vault op het item `<item-ji-production>`, als velden en niet als losse
items. De bevestigde velden zijn `DATABASE_URL`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` en `R2_S3_API_ENDPOINT`, dus bijvoorbeeld
`op://<vault>/<item-ji-production>/DATABASE_URL`. Neem
geen andere veldnaam aan zonder het item eerst te lezen.

#### 0.5.2 Firewall — 80/443 publiek; 22 tijdelijk bron-IP-beperkt

**De compose-file publiceert host-poorten; een naïeve deploy zet Manticore
(9308/9306) zonder enige auth aan het internet.** De lokale/CI-Postgres op
5432, Manticore 9308/9306, MinIO, server 3000, web 3001 en het
Coolify-dashboard (8000) zijn NOOIT publiek bereikbaar — verkeer loopt via
het Docker-netwerk of een SSH-tunnel. Nuance uit `docker-compose.yml` zelf:
postgres, redis en
manticore binden op `127.0.0.1` (`host_ip`), maar **`server` (3000) en
`web` (3001) publiceren zónder `host_ip` en binden dus op alle
interfaces** — zonder host-firewall staan die twee direct aan het
internet, vóór de Coolify-proxy en zonder TLS. De firewall is dus geen
tweede laag maar de enige laag voor die poorten.

Primair de **Hetzner Cloud Firewall** (productie: ID `<hetzner-firewall-id>`; buiten de
host, altijd corrigeerbaar
via de Console — een foute regel sluit je dus niet definitief buiten, het
lockout-risico van een verkeerde `ufw`-regel op de host zelf vervalt).
Inbound allow: TCP 80 en TCP 443 algemeen publiek. Sta TCP 22 tijdens herstel
alleen toe vanaf het exacte publieke source-IP van de operator; gebruik geen
any-source-regel. Al het overige inbound blijft dicht. Aanmaken via Console →
Firewalls, of `hcloud firewall create --rules-file rules.json` (JSON-formaat:
`hcloud firewall create --help`; gecheckt 2026-09-01). Een extra `ufw` op de
host is optioneel en niet geverifieerd op de huidige host — niet doen zonder
Console-vangnet.

Bij een SSH-time-out controleer je eerst het actuele operator-egress-IP en de
firewallregels; roteer niet meteen sleutels en open poort 22 nooit wereldwijd:

```bash
curl https://api.ipify.org
hcloud firewall describe <hetzner-firewall-id>
hcloud firewall add-rule <hetzner-firewall-id> --direction in --protocol tcp \
  --port 22 --source-ips <operator-egress-ip>/32
```

Verwijder verouderde `/32`-regels na de sessie. Tailscale of een bastion blijft
de duurzame beheerroute; losse operator-egressregels zijn hersteltoegang.

Coolify-dashboard (poort 8000; bron: coolify.io/docs, gecheckt 2026-09-01)
blijft publiek dicht. Nadat stap 0.5 een verse SSH-login heeft bewezen, is een
SSH-tunnel het bedoelde beheerpad:

```bash
ssh -L 8000:localhost:8000 <TBD-user>@<TBD-server-ip>
# daarna in de browser: http://localhost:8000
```

Voeg na herstel en validatie gewone Tailscale-netwerktoegang toe als geplande
hardening en bewijs de beheer- en SSH-route daarover. Verwijder of sluit pas
daarna de publieke TCP-22-regel. De SSH-tunnel kan vervolgens via Tailscale
blijven lopen; poort 8000 wordt niet publiek geopend.

#### 0.5.3 Basis-hardening

Standaard Ubuntu/OpenSSH-configuratie (geen exotische bron; actuele staat op
deze host niet geverifieerd): maak een non-root gebruiker met sudo, zet SSH op
key-only en schakel wachtwoordlogin uit.

```bash
adduser <TBD-user> && usermod -aG sudo <TBD-user>
# kopieer ~/.ssh/authorized_keys van root naar de nieuwe gebruiker, verifieer
# een LOGIN MET DIE USER IN EEN TWEEDE SESSIE vóór je verder gaat, en pas dan:
# in /etc/ssh/sshd_config: PasswordAuthentication no · PermitRootLogin no
systemctl reload ssh
```

De tweede-sessie-verificatie is de lockout-verzekering: pas `sshd_config`
nooit aan in je enige werkende sessie.

#### 0.5.4 Docker + Coolify

Coolify draait op `<hetzner-server-name>`. Gebruik de officiële
installer alleen als inspectie uitwijst dat herstel of herinstallatie nodig is
(bron: coolify.io/docs/get-started/installation, gecheckt 2026-09-01; geen
versienummer gepind in de docs zelf):

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

**Dit is een gepiped shell-script met root** — lees het vóór uitvoering
(`curl -fsSL … -o install.sh` en dan inspecteren). Wat het volgens de
documentatie doet: basistools (curl, wget, git, jq, openssl) installeren,
**Docker Engine 24+** installeren en configureren (logging, daemon),
`/data/coolify` aanmaken, SSH-keys voor serverbeheer configureren en
Coolify starten. Minimumeisen (2 cores / 2 GB / 30 GB) zijn op een CX43
ruimschoots gedekt. Dashboard daarna via de SSH-tunnel uit 0.5.2.

Browserloos bootstrappen heeft twee niet-intuïtieve stappen. Waarden
`ROOT_USER_*` in `/data/coolify/source/.env` worden noch door een restart,
noch door `php artisan app:init` toegepast. Maak de eerste gebruiker in
Tinker met `App\Models\User::create([...])`; de `booted`-hook van het model
maakt daarbij het persoonlijke team. Gebruik uitsluitend runtime-geïnjecteerde
waarden en laat geen wachtwoord of token in shell history terechtkomen.

`User::createToken()` werkt in Tinker niet, omdat daar geen huidig team uit een
sessie bestaat. Maak een API-token daarom via de relatie van de gebruiker en
het zojuist gemaakte team:

```php
$u->tokens()->create([
    'name' => '<tokennaam>',
    'token' => hash('sha256', $plain),
    'abilities' => ['root'],
    'team_id' => $team->id,
]);
```

De bearerwaarde is `<id>|<plain>`. Sla die alleen op als `COOLIFY_API_KEY` in
de 1Password-vault `<vault>`. Zet daarna via
`InstanceSettings::is_api_enabled` de API bewust aan — standaard staat die
uit — en sluit open registratie met `is_registration_enabled=false`.

Gebruik bij API-beheer de volgende, live geverifieerde semantiek:

- deployen is `POST /deploy`; `GET /deploy` wordt afgewezen met
  `changed to a POST request`;
- `PATCH /applications/{uuid}/envs` wijzigt een bestaande key, maar maakt niets
  aan wanneer de rij is verwijderd. Gebruik dan `POST`; Coolify maakt de
  previewrij automatisch aan en een tweede `POST` voor dezelfde variant geeft
  409;
- dubbele env-rijen zijn echt en de laatste rij wint. Lees daarom eerst alle
  rijen, en verwijder overtollige rijen gericht met
  `DELETE /applications/{uuid}/envs/{env_uuid}`;
- een restart leest de environment niet opnieuw in. Gebruik na een env-wijziging
  `POST /deploy?uuid=<application-uuid>&force=true`.

De eerste deploy kan `git_commit_sha` op één vaste commit vastzetten. De route
`/version` echoot alleen het bij boot opgeloste release-SHA (`APP_RELEASE_SHA`
als die gezet is, anders Coolify's `SOURCE_COMMIT`; zie de env-tabel in § 2) en
bewijst daardoor niet welke code in de container draait. Controleer voor
release-evidence zowel de imagetag `<app-uuid>:<git-sha>` met
`docker ps --format '{{.Image}}'` als een gerichte grep naar een
releasekenmerk in de container. Zet met
`PATCH /applications/{uuid}` de waarde `git_commit_sha` op `HEAD` wanneer de
application voortaan de geconfigureerde branch moet volgen.

#### 0.5.5 DNS en TLS

Domein: `<TBD: Ryan — domein en registrar>`. Een A-record (en AAAA bij
IPv6) per publieke hostname (web, API) naar het server-IP; welke hostnames
dat precies worden hangt af van `BETTER_AUTH_URL`/`CORS_ORIGIN`/
`NEXT_PUBLIC_SERVER_URL` uit § 2 — dezelfde waarden, één keuze. Coolify
gebruikt standaard **Traefik** als proxy met Let's Encrypt-ondersteuning
voor certificaten (bron: coolify.io/docs Traefik-overview, gecheckt
2026-09-01); poorten 80/443 uit 0.5.2 zijn precies wat de HTTP-01-flow en
het productieverkeer nodig hebben. De exacte per-domein
certificaatconfiguratie in Coolify is **niet geverifieerd** — volg de
Coolify-docs bij uitvoering in plaats van een hier verzonnen click-path.

Repetitieer vóór de echte DNS-cutover dezelfde route met tijdelijke hostnamen.
Op 2026-09-03 is Let's Encrypt end-to-end bewezen op
`api.<hetzner-ip-dashed>.sslip.io` en `app.<hetzner-ip-dashed>.sslip.io`. Zet de bijbehorende
auth-, CORS- en publieke webvariabelen tijdens de repetitie consistent op deze
hostnamen; pas na geslaagde TLS-, login-, API- en dashboardchecks de echte
DNS-records en waarden aan.

#### 0.5.6 Cloudflare R2-bucket (ADR-0008)

Verifieer eerst of de raw-payload-bucket en beperkte credentials uit
[ADR-0008](../adr/ADR-0008-cloudflare-r2-for-raw-payloads.md) bestaan en
correct zijn geconfigureerd. Maak ontbrekende onderdelen pas daarna aan. R2
staat los van de Hetzner-box en kan dus onafhankelijk worden gecontroleerd:

1. Cloudflare-dashboard → R2 → controleer bucketnaam en locatie; maak de
   bucket alleen aan als hij ontbreekt. Dit document verzint geen naam.
2. R2 → Manage API Tokens → verifieer een token met lees/schrijfrechten op
   alleen die bucket; maak het alleen aan als het ontbreekt. Dat levert de S3
   access key id en secret.
3. Noteer het account-id: het S3-endpoint is
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

De vijf `RAW_S3_*`-waarden (namen in § 2) gaan naar 1Password en vandaar naar
de Coolify-secrets van server én worker — nooit in git. `RAW_S3_REGION` mag
leeg blijven: R2 verwacht `auto`, en `us-east-1` (onze code-default) aliast
daarnaartoe. Rotatiepad voor deze keys bestaat nog niet — zie ADR-0008
§ Open punten.

#### Hand-off

Provisioning of herstel is pas afgerond wanneer verse evidence aantoont dat
de Ubuntu-host is geboot, een SSH-login slaagt en Docker en Coolify draaien.
TCP 80/443 zijn algemeen publiek; TCP 22 is tijdens herstel hoogstens vanaf
het exacte operator-source-IP bereikbaar en wordt na bewezen Tailscale
publiek gesloten. Alle overige inbound poorten, inclusief 8000, blijven
dicht. DNS wijst correct en de Cloudflare R2-bucket bestaat. **Dit is de harde
gate vóór stap 1; stap 1 (Manticore op de box) neemt exact deze staat aan.** De
bestaande stapnummers hieronder zijn ongewijzigd gelaten zodat alle
kruisverwijzingen (blockers-tabel, § 2) blijven kloppen.

### Stap 1 — Manticore op de box

Productie draait sinds 2026-09-03 op Manticore 29.0.2 als Coolify-service
`manticore-29`. De HTTP-poort is op de host uitsluitend als
`127.0.0.1:9312` gepubliceerd; containers bereiken hem via
`http://manticore29-<service-uuid>:9308`. De bestaande 6.3.8-service blijft
staan als fallback, maar is niet de actieve projectietarget. De onderbouwing
en open hybrid-evaluatie staan in
[search-engine-decision-2026-09-03.md](../research/search-engine-decision-2026-09-03.md)
en de voorgestelde ADR-0009 (hybrid).

Herhaalbare Coolify-inrichting:

1. Maak of herstel de aparte Manticore 29-service met image
   `manticoresearch/manticore:29.0.2@sha256:647ff5da4de6361eb043417a8f19b9e05041d3cfa1c3566665c07bc872cd15c3`,
   mount `tools/manticore/manticore29.conf` writable (`:ro` crasht de
   entrypoint-chown) en mount een persistent volume op `/var/lib/manticore`.
   Laat de 6.3.8-service en zijn volume intact als koude fallback.
2. Publiceer geen domein en geen publiek gebonden host-poort voor 9306 of
   9308. Productie-Manticore 29 bindt HTTP voor host-tools uitsluitend als
   `127.0.0.1:9312:9308`; binnen Coolify blijft 9308 bereikbaar via het
   private Docker-netwerk. Controleer ook de Hetzner-firewall uit stap 0.5.2.
3. Zet voor zowel deze service als de Coolify API-application **Connect to
   Predefined Network** aan. Lees daarna de echte service-UUID uit Coolify en
   configureer de API met
   `MANTICORE_URL=http://manticore29-<service-uuid>:9308`. Vul de geverifieerde
   UUID in; verzin of kopieer geen oude service-ID.
4. Het live bewezen pad op 2026-09-03 was: zet dezelfde URL op server en
   projector, redeploy beide, stop daarna de projector en bewijs dat de laatste
   drain klaar is. Voer met de projector quiescent de generatiewissel uit met
   `bun run search:new-generation --apply --force`, en start de projector pas
   na een geslaagde apply opnieuw. Een restart alleen leest de gewijzigde env
   niet opnieuw.
5. Behandel die omschakeling als maintenance-window: laat geen productieverkeer
   naar de opnieuw gedeployde API toe voordat de generatie volledig is gevuld,
   de projector opnieuw draait, `search:reconcile-projection` geen drift meldt,
   `/readyz` groen is en een echte zoekopdracht het verwachte resultaat geeft.
   Voor een volgende enginewissel mag de target ook vóór de API-cutover met een
   expliciete `MANTICORE_URL` worden gevuld en gereconcilieerd; schakel de API
   dan pas om. De 6.3.8-service is een koude fallback en vereist vóór terugkeer
   een generatie/rebuild plus dezelfde reconcile- en readinessgates.
6. Controleer vanuit de
   API-container dat de naam resolveert en dat poort 9308 antwoordt. Dit is
   de Coolify-containerroute; gebruik hier niet `127.0.0.1`.
7. Verbind de aparte projector-application ook met het predefined network en
   gebruik daar dezelfde interne Manticore 29-service-URL. Alleen voor
   handmatige host-tools mag 9312 op host-loopback zijn gebonden; maak geen
   Manticore-poort publiek bereikbaar.

Verificatie:

```bash
curl -sS http://127.0.0.1:9312/sql \
  --data-urlencode 'query=SHOW TABLES'
curl -sS http://127.0.0.1:9312/sql \
  --data-urlencode 'query=DESCRIBE aanvragen_active'
curl -sS http://127.0.0.1:9312/sql \
  --data-urlencode 'query=DESCRIBE aanvragen_archive'
```

Verwacht: `aanvragen_active` en `aanvragen_archive` in de lijst en
`projection_hash` als string attribute in beide tabellen (v4). `SHOW TABLES`
op Manticore 29 noemt de tabelkolom `Table`; `client.ts` handelt die vorm af.
`/readyz` eist beide tabellen (`apps/server/src/readiness.ts`); de expliciete
`DESCRIBE` voorkomt dat een oud volume alleen door een conf-edit current lijkt.

### Stap 2 — Neon-rollen en credentials

ADR-0006 "Nieuwe verplichtingen" punt 3: migrator-rol, app-rol en read-only
rol op de Catapulze-Neon-instance. Het script bestaat sinds RJC-381:
`tools/postgres/neon-roles.sql` maakt `ji_migrator`/`ji_app`/`ji_readonly`
idempotent aan (vier schema's; usage-header beschrijft de veilige
`psql --set`-aanroep met secrets uit 1Password). Lokaal bewezen, **nog niet
tegen Neon zelf uitgevoerd** (ADR-0006 § Operationele gereedheid). Leg bij
het uitvoeren alleen het resultaat vast, nooit de secretwaarden.

Verificatie: een read-only query met de app-rol over het pooled endpoint
slaagt; de migrator-URL staat uitsluitend in het 1Password-item, nergens in
git (`git grep` op de hostnaam levert niets op).

### Stap 3 — Migraties (gate, geen inline stap)

Preconditie 0.3 begint met een verse read-only live-readback van de volledige
Neon-journal en de betrokken schema-objecten. De oudere runbook-evidence
meldt 6 journalentries; de lokale, ongepubliceerde operatorrecord van
2026-09-01 claimde 13. Geen van beide vervangt de actuele readback of bewijst
dat `0013`/`0014` zijn toegepast. Pin de volledige release-`DEPLOY_SHA` en
gebruik de comparator uit
[neon-migration-catchup.md](neon-migration-catchup.md): die haalt journal en
SQL-bytes uit exact die commit, controleert dat live een exact geordend
voorvoegsel is en toont de pending tags. Voor de gereviewde integratiebasis
betekent volledig toegepast: alle 15 hashes/timestamps, de `0012`
`listing_hash`, de `0013` scope-/markeringobjecten en het `0014`
`public.user.role`-contract. Dit zijn codeverwachtingen, geen livebewijs.

Is Neon al exact current en slagen alle objectchecks, leg die externe
read-only evidence vast en migreer niet opnieuw. Alleen bij een bewezen
achterstand volgt de catch-up uit het subsysteem-runbook. Rehearse de exacte
pending set eerst op een verse child-branch van een onaangeraakte
productiesnapshot, meet de uitvoering en controleer alle objecten. Dat
rehearsal-resultaat is nog geen uitvoering-GO. Pauzeer daarna alle DB-writers,
wacht tot in-flight transacties klaar zijn, herhaal de finale preflight en
bewijs de schone exacte `DEPLOY_SHA`. Maak en valideer onder diezelfde freeze
een nieuwe pristine rollbackbranch: leg branch-ID, parent-ID, `created_at` en
een succesvolle read-only query vast. Verkrijg pas daarna de definitieve GO,
expliciet gebonden aan `DEPLOY_SHA`, pending tags, rehearsal verdict en al die
rollbackevidence. Zonder tussenliggende state change draait dan onmiddellijk
de one-shot migrator-job (`apps/server/Dockerfile.migrate`, alleen
`MIGRATION_DATABASE_URL`). Herstel vereist de gecontroleerde
restore/switchoverprocedure uit het runbook. Bij elke latere release geldt
hetzelfde SHA-afgeleide contract
([coolify-local.md](coolify-local.md)).

**Coolify 4.3.14 kan de migrator-application niet zelf uitrollen** (live
gezien 2026-09-04). De rolling update wacht op een Docker-healthstatus, maar
`apps/server/Dockerfile.migrate` zet `HEALTHCHECK NONE`, waardoor
`docker inspect` op `.State.Health` faalt ("map has no entry for key
Health") en Coolify iedere migrator-deploy als mislukt markeert — ook wanneer
de job zelf goed liep. Het pad dat werkte: laat Coolify de image bouwen (de
"mislukte" deploy laat `<application-uuid>:<sha>` gewoon op de box achter;
voor de migrator is dat `esjfwzdbibaz7kqrhqgatjkh:<sha>`) en draai die image
daarna als one-shot vanaf de host:

```bash
# /home/catapulze/.migrate.env, mode 0600, bevat uitsluitend:
#   MIGRATION_DATABASE_URL=<migrator-url>
#   TURBO_CACHE_DIR=/tmp/turbo
#   TURBO_TELEMETRY_DISABLED=1
docker run --rm --env-file /home/catapulze/.migrate.env --network coolify \
  esjfwzdbibaz7kqrhqgatjkh:<sha> bun run db:migrate
rm /home/catapulze/.migrate.env
```

De twee `TURBO_*`-variabelen zijn nodig omdat de image als user `bun` draait
en `/app/.turbo/cache` niet kan aanmaken. Verwijder het env-bestand direct na
de run. Bewijs is de journal-count vóór en ná
(`SELECT count(*) FROM drizzle.__drizzle_migrations;`): voor `0015` ging die
van 15 naar 16.

Verificatie (met de read-only rol, URL gescrubd):

```sql
SELECT id, hash, created_at::text
FROM drizzle.__drizzle_migrations
ORDER BY created_at, id;
```

Gebruik daarnaast de SHA-afgeleide prefixvergelijking en alle object-voor-
objectqueries uit [neon-migration-catchup.md](neon-migration-catchup.md), met
name de privacyveilige readbacks voor `0013` en `0014`. Verwacht: de hele
journal én het live schema komen overeen met de migraties van de exacte
`DEPLOY_SHA`. De laatste journal-timestamp is de vergelijking die `/readyz`
uitvoert (`packages/db/src/readiness.ts`,
`resolveExpectedMigrationTimestamp`), maar die ene waarde vervangt de
volledige readback vóór een eventuele migratie niet.

Die koppeling snijdt ook de andere kant op: zodra een nieuwe migratie is
toegepast, geeft de **oude** server-container `503` op `/readyz`
(`migration_mismatch` — hij verwacht nog de journal-timestamp van zijn eigen
build) totdat de server met de bijbehorende `DEPLOY_SHA` opnieuw is
uitgerold. Plan migratie en server-redeploy daarom als één venster; tussen
die twee stappen is de API bewust niet "ready".

### Stap 4 — Server (API)

Coolify-application op `apps/server/Dockerfile`, poort 3000, met de
servervariabelen uit § 2 (`NODE_ENV=production`, Neon-`DATABASE_URL`,
`MANTICORE_URL=http://manticore29-<service-uuid>:9308` via het predefined
network naar de on-box Manticore 29-service, `RAW_S3_*`, `REDIS_URL`, auth/CORS).
Lees de service-UUID live uit Coolify. De server-runtime krijgt geen admin-
of migrator-credential. De aparte projector-application gebruikt via hetzelfde
predefined network ook de interne Manticore-service-URL.

Verificatie:

```bash
curl -s http://127.0.0.1:3000/livez
curl -s http://127.0.0.1:3000/readyz
```

`/livez`: 200 zodra het proces draait. `/readyz` direct na een verse deploy:
verwacht nog **geen** `"status":"ready"` — de projector draait nog niet en
de index kan leeg zijn; zie stap 7 en § 4 voor welke componentstatussen op
dit punt acceptabel zijn (`postgres` en `manticore` moeten al `ok` zijn).

**Rolling update faalt met "New container is unhealthy" (open, 2026-09-04).**
Server- en projector-deploys op HEAD faalden die dag herhaaldelijk bij
Coolify's allereerste `docker inspect`, met een lege `Health.Log`, terwijl
dezelfde image handmatig met dezelfde env binnen 15 s gezond was. De oorzaak
was bij het schrijven nog niet gevonden; zie de blockertabel. Het
diagnoserecept dat "image kapot" van "Coolify-orchestratie kapot" scheidt:

```bash
# env van de nog draaiende oude container overnemen (0600, daarna weggooien)
docker inspect <oude-container> \
  --format '{{range .Config.Env}}{{println .}}{{end}}' > /tmp/ji-probe.env
chmod 0600 /tmp/ji-probe.env
docker run -d --name ji-probe --network coolify \
  --env-file /tmp/ji-probe.env <image>
docker exec ji-probe bun -e \
  "fetch('http://localhost:3000/readyz').then(async r => console.log(r.status, await r.text()))"
docker rm -f ji-probe && rm /tmp/ji-probe.env
```

Lees de readiness-JSON, nooit `/version`: dat zegt alleen welke build draait
en niets over de afhankelijkheden. Het env-bestand bevat secrets — scrub de
inhoud met het `sed`-patroon uit § 2 voordat er iets van in een log of ticket
belandt, en verwijder het direct na de probe.

### Stap 5 — Web

Coolify-application op `apps/web/Dockerfile`, poort 3001,
`NEXT_PUBLIC_SERVER_URL` als build-arg én runtimevariabele op de publieke
API-URL, `INTERNAL_SERVER_URL` als runtimevariabele op de interne URL van de
`server`-application (§ 2, Web); domain via de Coolify-proxy.

Verificatie: `curl -s -o /dev/null -w '%{http_code}' https://<web-domain>/`
→ `200`, en de browserconsole doet API-calls naar de publieke API-URL, niet
naar `server:3000`. Daarna zonder cookies
`curl -s -o /dev/null -w '%{http_code}' https://<web-domain>/dashboard` →
`307` naar `/login`; een `500` betekent dat de server-side sessiecheck de API
niet bereikt (`INTERNAL_SERVER_URL` ontbreekt of wijst verkeerd).

Let op, al vóór deze fix aanwezig: draaien web en API op verschillende
hostnamen, dan stuurt de browser het host-only sessiecookie van de API nooit
mee naar de web-domain, en ziet de server-side sessiecheck een uitgelogde
bezoeker — `/dashboard` bounct dan altijd naar `/login`, terwijl de 307-check
hierboven gewoon slaagt. Dat vergt `crossSubDomainCookies` in Better Auth of
een `/api/auth`-proxy op de web-host; apart op te pakken, niet in scope hier.

### Stap 6 — Redis en raw object store

Redis on-box (privaat), `REDIS_URL` op de server. Raw store: een Cloudflare
R2-bucket ([ADR-0008](../adr/ADR-0008-cloudflare-r2-for-raw-payloads.md));
bestaan en configuratie van bucket, endpoint en keys eerst verifiëren en zo
nodig in Cloudflare R2 inrichten. `RAW_S3_*` op server én worker met exact
dezelfde waarden. Met `NODE_ENV=production` weigert de gewone poll-worker te
starten wanneer zijn store naar filesystem resolveert; de productiebackfill
weigert onafhankelijk alles behalve `kind: "s3"`
([raw-object-storage.md](raw-object-storage.md) § Production guard). Deze
guards bewijzen geen env-pariteit of bereikbaarheid: vergelijk de niet-geheime
configuratievelden zonder secrets te loggen en voer een toegestane non-PII
canary-write met exacte R2-readback uit.

Verificatie: `/readyz` toont `redis: {"status":"ok"}` en
`rawObjectStore: {"status":"ok"}`. (`rawObjectStore` probet alleen de
sentinel-key `raw/.readiness-probe`; `reason":"filesystem_backend_in_production"`
betekent dat de RJC-386-guard is omzeild — stoppen en uitzoeken.)

### Stap 7 — Projector on-box + worker naar onbox-modus

Beide kanten van het contract tegelijk omzetten
([search-projector.md](search-projector.md) § Deploy contract — "not one
without the other"):

1. Maak een aparte Coolify Dockerfile-application op
   `apps/server/Dockerfile.projector`, zonder publieke poort of domain. De
   Dockerfile is byte-identiek aan de server-Dockerfile op de role-`CMD` na en
   erft daardoor diens API-healthcheck; schakel die in Coolify uit. Coolify's
   Dockerfile-buildpack negeert een geconfigureerd
   `start_command`; deze role-Dockerfile zet daarom zelf exact
   `CMD ["bun","run","projector"]`. Verbind de application met hetzelfde
   predefined network als Manticore. Env: on-box `DATABASE_URL` (`ji_app`) voor
   dataqueries + directe on-box `PROJECTOR_DATABASE_URL` voor de lock +
   `MANTICORE_URL=http://manticore29-<service-uuid>:9308`, met de UUID live uit
   Coolify gelezen. Alleen een handmatige host-run gebruikt in plaats daarvan
   de loopbackroute `http://127.0.0.1:9312`; Compose gebruikt
   `http://manticore:9308`.
2. Worker (Trigger.dev) op `SEARCH_PROJECTOR=onbox`, zonder `MANTICORE_URL`.

Een handmatige Trigger.dev-run van `drain-outbox` draineert in deze modus
bewust niet: de task retourneert `deferred: true`, zodat cloud-worker en
on-box proces nooit tegelijk eigenaar van de drain zijn.

Verificatie: één cycle-logregel per drain
(`{"event":"projector_cycle","drained":N,…}`; `drained: 0` per ~1s is normaal
bij idle), en een tweede instance-start blijft wachten op de advisory lock in
plaats van te stoppen: `projector_lock_waiting` hooguit elke 30 s, een verse
heartbeat, en geen enkele drain totdat hij de lock heeft.

Een Coolify-rolling-update vereist daarom geen handmatige stop vooraf. Coolify
start de nieuwe container, die healthy op de lock wacht, en verwijdert daarna de
oude; het SIGTERM-pad van de oude maakt de lopende cycle af en geeft de lock
vrij, waarna de nieuwe hem op de eerstvolgende poll pakt. Een stop via Coolify
verwijdert de container nog steeds, dus een bewuste stop blijft een stop en geen
handoff. De deploydriver leest `/projector/runtime` na de switch tot 90 s lang
elke 5 s opnieuw, omdat die endpoint in de paar seconden tussen healthy en
lockhouder nog de oude container kan tonen of 503 met reason `runtime_missing`
of `heartbeat_stale` kan geven.

Faalt de Coolify-deploy van de projector met "New container is unhealthy",
gebruik dan hetzelfde zijcontainer-recept als bij stap 4. De projector heeft
geen `/readyz`; het bewijs is dan de `projector_cycle`-regel in
`docker logs ji-probe`.

### Stap 8 — Search-bootstrap (verse Manticore heeft geen data)

Een verse box heeft lege RT-tabellen terwijl Neon al aanvragen en een
`curated.search_projection_checkpoint` kan hebben die zegt dat alles al
geprojecteerd is — de drain gaat dan níet vanzelf herindexeren. Het
bootstrap-pad is het generatie/reindex-mechanisme uit
[search-schema-migration.md](search-schema-migration.md). Dit pad draait op de
productie-engine **Manticore 29.0.2**. De 6.3.8-service blijft uitsluitend als
fallback bestaan; de hybrid-richting in de voorgestelde ADR-0009 is geen
onderdeel van deze lexicale productiebootstrap.

Stop eerst de singleton projector via zijn supervisor en bewijs dat de laatste
drain klaar is. Trigger.dev moet al `SEARCH_PROJECTOR=onbox` gebruiken, zodat
er geen tweede drain-eigenaar is. Houd de projector gestopt gedurende plan,
apply en finalisatie. Inspecteer daarna read-only wat een geforceerde nieuwe
generatie zou doen:

```bash
bun run search:new-generation --force
```

Dit is de standaard dry-run: er wijzigt geen checkpoint en er worden geen
events geschreven. Leg generation, aantal actuele aanvragen en gepland aantal
replayevents vast. Controleer dat de target-tabellen
`aanvragen_active`/`aanvragen_archive` op 29.0.2 bestaan en in beide
`projection_hash` aanwezig is. Verkrijg expliciete operatorgoedkeuring voor de
geforceerde rebuild. Pas in die bewuste applyfase, met dezelfde geheime
Neon-omgeving geïnjecteerd en de projector nog steeds quiescent, mag exact dit
muterende commando draaien:

```bash
bun run search:new-generation --apply --force
```

Het commando verhoogt de generatie, zet eerst een generation-specifieke
pending marker, legt een high-water-ID vast en maakt vervolgens in begrensde
pagina's een deterministisch, idempotent `aanvraag.search_reindex`-event voor
iedere huidige `curated.aanvraag`. Het leunt niet op bewaarde historische
outboxevents. Pas nadat de volledige replay duurzaam is aangemaakt en er geen
dead-lettered replayevents voor die generatie zijn, vervangt het de pending
marker atomair door de gedeployde `SEARCH_SCHEMA_HASH`. Exit 0 met
`Generation <n> is now available to the projector` is de CLI-evidence voor
die finalisatie. Bij crash, andere pending hash of dead letters: projector
gestopt houden en het resume-/herstelpad uit het subsysteem-runbook volgen;
nooit het checkpoint handmatig aanpassen.

Na die succesvolle finalisatie: start exact één projector, laat zowel de volledige
replay als ondertussen ontstane normale events drainen en bewijs dat de lag en
dead-letterqueue tot nul (of een expliciet verklaarde actieve-producergrens)
zijn gekomen. Stop de projector opnieuw en wacht tot de laatste drain klaar
is. Voer dan de verplichte fysieke preflight uit tegen dezelfde Manticore:

```bash
MANTICORE_URL=http://127.0.0.1:9312 \
  bun run search:reconcile-projection
```

Als die drift of fysieke corruptie meldt, houd de projector gestopt en voer de
erkende compare-and-delete/repairstap uit:

```bash
MANTICORE_URL=http://127.0.0.1:9312 \
  bun run search:reconcile-projection --apply --projector-quiesced
```

Start één projector om nieuwe repairevents te drainen, stop hem weer zonder
in-flight drain en herhaal de read-only reconciliation. Hervat normaal bedrijf
pas bij nul current-documentdivergenties, nul geldige UUID-orphans, nul
fysieke corruptie en exacte initial/scanned/final counts per partitie.

Zolang de index nog leeg/achter is meldt `/readyz` dat eerlijk:
`searchProjection` op `degraded` met `reason":"lag_elevated"` (>300 s) of
`"lag_critical"` (>3600 s) — overall dan `"degraded"`, HTTP 200, want stale
search blijft serveerbaar. Een `schema_hash_mismatch` daarentegen is
`failed` → overall `unavailable` (503) tot de generatiestap is gedaan.

Verificatie:

```sql
SELECT index_name, generation, schema_hash, applied_sequence
FROM curated.search_projection_checkpoint;
```

`schema_hash` is de `SEARCH_SCHEMA_HASH` van de gedeployde commit (geen pending
marker), projectorlag en dead letters zijn gesloten, en de fysieke
reconciliation is schoon. Daarna geeft `POST /v1/aanvragen/search` met
`{"query":"","sort":"closing-soon","limit":5}` echte deadlines terug
([search-schema-migration.md](search-schema-migration.md) § Verification).

### Stap 9 — Worker-deploy (Trigger.dev Cloud)

Productieconfiguratie voor RJC-373 (`TRIGGER_SECRET_KEY`) is open en
onbewezen; ook geldt: "een gedeployde Trigger.dev-worker
is niet getest" (ADR-0006, "Open punten"). Zodra gedeblokkeerd: env uit § 2,
per-bron live-vlaggen pas ná het voorwaarden-besluit per bron
(`voorwaardenStatus` in `packages/application/src/sources/*.ts`).

Verificatie: een poll-run schrijft een nieuwe `curated.outbox_event` en de
on-box projector draint hem (cycle-log `drained ≥ 1`).

## 4. Go/no-go-gate — het echte `/readyz`-contract

Uit `apps/server/src/readiness.ts` (code, niet proza). **Go** is:

```json
{
  "status": "ready",
  "components": {
    "postgres": { "status": "ok", "checkedAt": "…", "durationMs": 0 },
    "manticore": { "status": "ok", "checkedAt": "…", "durationMs": 0 },
    "rawObjectStore": { "status": "ok", "checkedAt": "…", "durationMs": 0 },
    "redis": { "status": "ok", "checkedAt": "…", "durationMs": 0 },
    "searchProjection": {
      "status": "ok",
      "generation": 1,
      "appliedSequence": "…",
      "lagEvents": 0,
      "lagSeconds": 0,
      "schemaHash": "aanvragen-v4[active|archive]:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie,locatie_land,sluitingsdatum,status,tarief_max,tarief_min,titel,projection_hash",
      "checkedAt": "…",
      "durationMs": 0
    }
  }
}
```

(De `schemaHash`-waarde moet gelijk zijn aan `SEARCH_SCHEMA_HASH` in
`packages/search/src/version.ts` van de gedeployde commit; de overige
`generation`/sequence-waarden zijn omgevingsafhankelijk.)

Wat 503 (`unavailable`) geeft — deploy is no-go:

- `postgres.status: "failed"` — reasons `migration_mismatch`,
  `database_error`, `timeout`, `unreachable`;
- `manticore.status: "failed"` — `table_missing`, `timeout`, `unreachable`;
- `rawObjectStore.status: "failed"` — alléén
  `filesystem_backend_in_production`;
- `searchProjection.status: "failed"` — alléén `schema_hash_mismatch`;
- reason `check_error` op een van deze vier (interne check-crash).

Wat `degraded` blijft — HTTP 200, serveert door, wel opvolgen:

- `rawObjectStore` onbereikbaar/timeout op S3 (`unreachable`/`timeout`);
- `redis` onbereikbaar ná boot (`unreachable`/`timeout`/`check_error`);
- `searchProjection` met `lag_elevated` (>300 s), `lag_critical` (>3600 s),
  `projection_read_failed` of `timeout`.

`redis: {"status":"not-configured"}` telt niet mee in het verdict.
`/livez` blijft procesniveau-only en zegt niets over afhankelijkheden.

## 5. Rollback per stap

| Stap | Rollback | Niet omkeerbaar |
|---|---|---|
| 1 Manticore | Container stoppen/verwijderen; volume weggooien mag — de index is een afgeleide, volledig rebuildbare index uit Neon en de outbox (rebuild = stap 8; [ADR-0006](../adr/ADR-0006-neon-as-system-of-record.md)). | Niets. |
| 2 Neon-rollen | Rollen droppen/credential intrekken in Neon + 1Password. | Een eenmaal gelekte credential — dan roteren (les van RJC-371). |
| 3 Migraties | **Geen automatisch pad.** Drizzle-migraties hier hebben geen down-scripts; herstel op Neon loopt via PITR/branch-restore, die [neon-restore.md](neon-restore.md) beschrijft. Voor de catch-up is de vooraf gemaakte Neon-branch alleen de rollback source; herstel vereist de gecontroleerde restore/switchoverprocedure uit [neon-migration-catchup.md](neon-migration-catchup.md) §4. Daarom is de catch-up een gate met eigen runbook, geen inline stap. | Toegepaste migraties + alle writes erna, behoudens Neon-PITR/branch-venster. |
| 4–5 Server/web | Vorige image/release in Coolify uitrollen; stateless. | Niets. |
| 6 Redis / raw store | `REDIS_URL` weghalen (server degradeert naar in-process cache — behalve bij boot in productie, dan is Redis-onbereikbaarheid een startweigering); raw store: eenmaal geschreven objects laten staan. | Reeds geschreven raw payloads verwijderen = observaties onherhaalbaar maken — niet doen. |
| 7 Projector/onbox | Worker terug naar `SEARCH_PROJECTOR=worker` **mét** `MANTICORE_URL` en projector stoppen — beide tegelijk, zelfde contract als heenweg. Let op: in de cloud kán de worker Manticore niet bereiken, dus deze rollback werkt alleen zolang de worker niet cloud-deployed is. | Niets aan data. |
| 8 Search-bootstrap | Blijft de marker pending, houd de projector quiescent en hervat exact die generatie met `--apply` volgens het subsysteem-runbook. Is hij finalized, drain en reconcile. Start alleen na een nieuwe dry-run en expliciete GO nogmaals een geforceerde generatie met `--apply --force`. | Replayevents en generatiemetadata blijven duurzaam; Manticore zelf blijft afgeleid en rebuildbaar uit Neon. |
| 9 Worker | Trigger.dev-deploy terugrollen; reeds geingeste observaties blijven staan (append-only pad). | Geingeste data (bewust — herkomst blijft behouden). |

## Open blockers

Zonder deze punten kan de sequentie niet veilig verder naar de aangeduide
stap. Ze blokkeren herstel alleen waar dat expliciet in de tabel staat en
vallen allemaal buiten het mandaat van dit runbook:

| Blocker | Blokkeert | Wie |
|---|---|---|
| Hersteltoegang: Hetzner Console en benodigde SSH-/Coolify-credentials via 1Password beschikbaar maken | Stap 0.5 | Ryan |
| `<hetzner-server-name>`: vóór de volgende deploy bootstatus, SSH-bereikbaarheid en Coolify-status opnieuw bewijzen | Stap 1 en alles daarna; stap 0.5 is juist het herstelpad | Ryan |
| RJC-402: actuele Neon-journal en `0012`–`0014`-objecten live read-only vergelijken met de exacte `DEPLOY_SHA`; de echte pending set op een verse snapshot rehearsen; daarna writers freezen, finale preflight herhalen en de verse rollbackbranch inclusief parent/`created_at`/queryability valideren; pas op die complete evidence definitief GO geven | Stap 3 en de server-go/no-go totdat de actuele status bekend is | Ryan |
| RJC-371: rotatie gelekte Neon-credential | Stap 2/4 — ADR-0006 is "pas operationeel gedekt als de rotatie is afgerond" | Ryan |
| RJC-373: productieconfiguratie van `TRIGGER_SECRET_KEY` verifiëren of zo nodig inrichten | Stap 9 (worker-deploy en gedeployd bewijs) | Ryan / Trigger.dev-account |
| Voorgestelde ADR-0009: hybrid-evaluatie op Manticore 29 afronden | Geen blokkade voor de huidige lexicale productie-engine 29.0.2; hybrid activeren vereist afzonderlijk gereviewd bewijs | Ryan |
| ~~Raw-store-provider~~ — beslist: Cloudflare R2 ([ADR-0008](../adr/ADR-0008-cloudflare-r2-for-raw-payloads.md)); bestaan/configuratie van bucket + keys verifiëren en zo nodig inrichten | Stap 6 | Ryan |
| Coolify-rolling-update van de server faalt sinds 2026-09-04 met "New container is unhealthy" bij de eerste inspect (lege `Health.Log`), terwijl dezelfde image handmatig gezond is; oorzaak open, diagnoserecept in stap 4. De bekende projectoroorzaak is gesloten: de nieuwe container wacht healthy op de advisory lock in plaats van direct te stoppen, dus een projectorrelease vereist geen handmatige stop vooraf. Keert het symptoom toch terug op de projector, gebruik dan hetzelfde recept uit stap 4. | Stap 4 (elke serverrelease via Coolify) | Ryan |
| Branch protection op `main` | Geen deploystap, wel de release-hygiëne eromheen | Ryan |

Daarnaast: host en Coolify waren op 2026-09-03 live bereikbaar, maar iedere
volgende deploy vereist opnieuw verse evidence voor de actuele toestand en de
volledige herstel- en deploysequentie. Behandel herstelstappen zonder verse
evidence als ongerehearsed. Het
Neon-rollen-script bestaat inmiddels — `tools/postgres/neon-roles.sql`,
RJC-381 — maar is nog niet tegen Neon uitgevoerd; zie stap 2.
