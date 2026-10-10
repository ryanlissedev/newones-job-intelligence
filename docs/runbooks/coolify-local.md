# Lokale Docker/Coolify-lane

Deze lane maakt de lokale productieachtige route reproduceerbaar terwijl de Hetzner-host nog niet beschikbaar is. De geordende deploy-procedure naar die host staat in [hetzner-deploy.md](hetzner-deploy.md). De huidige Compose-stack bevat Postgres 16, de API en de webapp. Manticore, Redis en object storage worden pas toegevoegd wanneer de applicatiecode daarvan afhankelijk is.

> **Notitie 2026-09-06:** [ADR-0011](../adr/ADR-0011-postgres-on-box-trigger-static-ips.md) herstelt on-box Coolify Postgres als productie-SoR (ADR-0006 superseded). De Coolify-Postgres-proef hieronder is weer de productierichting; Trigger.dev Cloud bereikt die DB via static egress-IP allowlist — zie [trigger-on-box-cutover.md](trigger-on-box-cutover.md). Lokale Compose-Postgres blijft de CI/dev-lane.

## Lokale Docker-proef met 1Password

Vereisten: Bun 1.3.14, Docker Desktop/OrbStack, 1Password CLI met een actieve sessie en een lege of bestaande Docker-volume-naam.

```bash
bun install --frozen-lockfile
cp .env.example .env.1password
git check-ignore .env.1password
```

Vervang in het lokale, door Git genegeerde `.env.1password` iedere credential door een `op://`-referentie. Dat geldt minimaal voor de drie Postgres-wachtwoorden, `CATAPULZE_DATABASE_URL`, `PROJECTOR_DATABASE_URL` en `BETTER_AUTH_SECRET`. Voeg ook `MIGRATION_DATABASE_URL` toe als referentie naar de volledige lokale migrator-URL. Niet-geheime instellingen, zoals poorten, databasenamen en resourcegrenzen, mogen gewone waarden blijven. Lokaal mogen `CATAPULZE_DATABASE_URL` en `PROJECTOR_DATABASE_URL` dezelfde directe Compose-Postgres-URL bevatten; productie gebruikt voor de projectorlock expliciet Neons directe endpoint terwijl gewone runtimequeries gepoold mogen blijven.

Voer de smoke-test uit met hetzelfde referentiebestand voor zowel 1Password-injectie als alle Compose-aanroepen:

```bash
COMPOSE_ENV_FILE=.env.1password op run --env-file=.env.1password -- bun run docker:smoke
```

`op run` injecteert de opgeloste waarden alleen in het proces. Commit `.env.1password` nooit, plak geen secretwaarden in documentatie of chat en schakel de standaard outputmaskering niet uit. Gebruik geen `set -x`, `env`, `printenv` of handmatige `docker compose config` tijdens deze route: die kunnen opgeloste waarden in terminal- of CI-logs tonen.

## Plaintext fallback zonder 1Password

Wie 1Password niet gebruikt, kan de bestaande lokale bestanden blijven gebruiken:

```bash
cp .env.example .env
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
# Vul uitsluitend lokaal de placeholders en ontwikkelcredentials in.
bun run docker:smoke
```

Zonder `COMPOSE_ENV_FILE` gebruikt het script standaard `.env`. De smoke-test stopt direct wanneer de gekozen Compose-env-file ontbreekt. Voor de migratie is daarnaast óf `apps/server/.env` óf een geïnjecteerde `MIGRATION_DATABASE_URL` vereist.

De smoke-test bouwt de images, wacht eerst alleen op Postgres, voert daarna de Drizzle-migratie uit en start vervolgens de API en webapp met `--wait`. Zo kan `/readyz` terecht eisen dat de migratie al aanwezig is. Daarna controleert de test `/readyz` en de webroot. `docker compose down` wordt na afloop uitgevoerd met exact dezelfde env-file; het vooraf aangemaakte externe Postgres-volume blijft behouden. Gebruik nooit `docker compose down -v` voor dit volume.

## Coolify-proef

Maak in een lokale Linux-VM of lokale Coolify-installatie één project en importeer deze GitHub-repository. Configureer drie langlevende Docker-applications:

1. `server`: Dockerfile `apps/server/Dockerfile`, poort `3000`, Docker HEALTHCHECK `/livez` (process liveness). Do not point Coolify/Docker HEALTHCHECK at `/readyz` — a 503 readiness response caused tip-deploy rollback after `aca8478`. Keep `/readyz` as the app readiness contract for Traefik/ops probes. Zet geen `APP_RELEASE_SHA`: de server leest het release-SHA uit `SOURCE_COMMIT`, dat Coolify zelf in iedere container injecteert; een handmatige niet-SHA-waarde laat de boot falen.
2. `web`: Dockerfile `apps/web/Dockerfile`, poort `3001`, build argument `NEXT_PUBLIC_SERVER_URL` met de publieke API-URL en runtimevariabele `INTERNAL_SERVER_URL` met de interne URL van de `server`-application.
3. `projector`: Dockerfile `apps/server/Dockerfile.projector`, zonder publieke poort of domain. Schakel de van de byte-identieke server-image overgenomen API-HTTP-healthcheck in Coolify uit, want de projector luistert niet op poort 3000. Geef alleen `DATABASE_URL`, `PROJECTOR_DATABASE_URL` en `MANTICORE_URL` mee en verbind de application met hetzelfde predefined network als Manticore.

Maak daarnaast een Postgres 16 service met een persistent volume. De database is uitsluitend intern bereikbaar op servicenaam `postgres`; publiceer poort 5432 niet. Initialiseer op een leeg volume eerst de afzonderlijke admin-, migrator- en app-rollen uit `tools/postgres/init/10-bootstrap-roles.sh`. Als de Coolify-databaseservice geen init-script kan mounten, voer dezelfde bootstrap eenmalig als admin uit en leg alleen het resultaat vast, nooit de secretwaarden. Geef de server uitsluitend `DATABASE_URL` met de interne app-rol-URL en voeg de Better Auth- en CORS-secrets toe via Coolify's secret/configuration UI. De server-runtime krijgt geen admin- of migrator-credential.

Configureer een aparte one-shot migrator-job op basis van `apps/server/Dockerfile.migrate` (niet `apps/server/Dockerfile`). Coolify's Dockerfile-buildpack gebruikt de image-`CMD` en negeert doorgaans een aparte `start_command`; de migrator-Dockerfile zet daarom expliciet `CMD ["bun","run","db:migrate"]` zonder `HEALTHCHECK`, zodat de container na Drizzle met exitcode 0 stopt in plaats van de API te starten. Alleen deze job krijgt `MIGRATION_DATABASE_URL` en voert vóór iedere server-release uit.

Hetzelfde buildpackgedrag geldt voor de projector: `apps/server/Dockerfile.projector` is byte-identiek aan de server-Dockerfile op alleen `CMD ["bun","run","projector"]` na. Configureer geen afwijkend start command in Coolify. Daardoor erft de image ook de API-healthcheck; schakel die voor deze application uit. De projector serveert geen HTTP-endpoint; runtimebewijs bestaat uit een draaiende container, `projector_cycle`-logs en `searchProjection` met `lagEvents: 0` nadat een nieuw outboxevent is gedraind.

De repository staat in die image op `/app`. Laat de job na een succesvolle migratie stoppen en rol alleen dan de server uit. Hergebruik de migrator-URL nooit als runtimevariabele van de server en voer de job niet met de app-credential uit. Configureer de web-domain via de Coolify-proxy en zet `NEXT_PUBLIC_SERVER_URL` zowel als build argument als runtimevariabele op de publiek bereikbare API-domain; `server:3000` mag nooit in browsercode terechtkomen. Zet daarnaast `INTERNAL_SERVER_URL` (alleen runtime, geen build argument) op de interne URL waarop de web-container de `server`-application bereikt, zoals `http://server:3000` in Compose: de server-side sessiecheck van `/dashboard` gebruikt die, en zonder deze variabele probeert Next.js de publieke URL vanuit de container te bereiken — lokaal is `localhost:3000` dan de web-container zelf en rendert `/dashboard` een 500 (`ECONNREFUSED`).

### Motian Neon v1 backfill (optioneel)

Voor een read-only historische import uit Motian-Neon (DEC-005), injecteer **`MOTIAN_DATABASE_URL`** uitsluitend in een one-shot backfill-job of operator-shell — nooit in de langlevende `server`-service en nooit als `DATABASE_URL`. Zie [motian-neon-backfill.md](./motian-neon-backfill.md).

## Nog geen productie-bewijs

Deze lokale lane bewijst image builds, env-wiring, migraties, readiness en basis-restarts. Productie blijft geblokkeerd totdat private firewall-poorten, off-site WAL/base backups, een geteste lege restore, monitoring/alerts, resourceprioriteit en DNS/TLS op de Hetzner-host met bewijs zijn gevalideerd. Lokale credentials en testdata mogen niet naar productie worden hergebruikt.
