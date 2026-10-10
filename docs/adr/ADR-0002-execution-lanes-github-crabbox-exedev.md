# ADR-0002 — Execution lanes voor GitHub, Crabbox en exe.dev

- Status: Accepted
- Datum: 2026-08-28
- Eigenaar: Job Intelligence platform
- Gerelateerd: ADR-0001, ADR-0003, RJC-334, RJC-344

## Context

Eén runner kan niet tegelijk snelle PR-feedback, reproduceerbare cold runs, een warme langlopende omgeving en production-like loadbewijs leveren. Provider-wall-clock is bovendien ruisgevoelig. We scheiden daarom correctness, orchestration en trendmeting.

## Besluit

| Lane | Rol | Autoriteit | Grens |
|---|---|---|---|
| GitHub-hosted Actions | Verplichte clean PR-gate en bron voor queue/job/stepduur | Correctness en delivery-feedback | Noisy runner; geen product-SLO uit één run |
| Crabbox v0.62.0 | Opt-in orchestration en evidence voor schone remote runs | Lease/sync/command/cleanup, JUnit en artifacts | Shadow lane totdat authenticatie en echte runs zijn bewezen |
| exe.dev via Crabbox | Dedicated secundaire Linux/Docker-lane voor herhaalde cold/warm trends | Trend binnen exact hetzelfde exe.dev-cohort | Gedeelde capaciteit; geen absolute vergelijking met GitHub of andere providers |

GitHub CI blijft bij maximaal twee testworkers, gebruikt Postgres als service en is de vereiste merge-gate. Queue-/runner-/stepmetingen worden gekoppeld aan workflow-run-ID en commit-SHA. Queuevertraging mag worden gerapporteerd, maar is geen door code beïnvloedbare performance-gate.

Crabbox wordt gepind op de stabiele release `v0.62.0`. De officiële macOS arm64-archive is `crabbox_0.62.0_darwin_arm64.tar.gz` met SHA-256 `7e742950103248c976b429c3ceab6fc6c37e091c96cfd47b473c29565f68f2dc`; die digest is vóór installatie geverifieerd. Voor deze ondersteunde macOS arm64-host is ook de uitgepakte binary-digest `a3efd851358ada2624c8cccf3254a64fab52afe8e8e2c3ec399db9c707a06d01` in de launcher gepind. De launcher vereist daarnaast een naast de binary opgeslagen provenance-bestand met beide digests. Zo wordt de exacte geïnstalleerde executable opnieuw gecontroleerd voordat een providercommando start; ontbrekende of afwijkende provenance stopt de run. Andere platformen vereisen eerst een apart gereviewde release- en binary-digest. De jobconfig valideert de geplande warmup → hydrate → run → stop-orchestration en verzamelt onze applicatie-eigen timing-JSON, expliciete fasemarkers, JUnit en verplichte artifacts. Een gewone `crabbox job run` levert geen Crabbox operationele timing-JSON: v0.62.0 accepteert daar geen `--timing-json` of `--timing-record`, en het job-schema biedt daarvoor geen pass-through.

Alleen de onderliggende `crabbox run` ondersteunt `--timing-json` voor de finale timing-JSON op stdout van de lokale CLI en `--timing-record <path>` voor een lokale append-only JSONL-ledger. Een geautoriseerde performance-run moet daarom eerst het job-dry-run-plan inspecteren en daarna de daaruit afgeleide onderliggende run-stap met beide timingflags uitvoeren binnen dezelfde gegarandeerde stop/finally-cleanup. Het exacte dynamische providercommando wordt niet in dit ADR vastgelegd; de operator leidt het af uit het geïnspecteerde plan en de gepinde `crabbox run --help`/documentatie.

Zolang een gecontroleerde direct-run-wrapper dit pad en de cleanup niet heeft bewezen, blijft Crabbox providerfasetiming een open acceptance gap en is `crabbox job run` shadow-only. De deterministische performancebudget-backend van Crabbox is nog een contract en wordt niet als geleverde gate behandeld.

exe.dev wordt alleen via de Crabbox-provider of rechtstreeks via SSH bediend. Een lane gebruikt vaste CPU/RAM/disk/regio, een gepinde image/toolchain en een schoon Docker Compose-profiel. De eerste uitvoering is trusted-branch-only en non-blocking. Een persistent algemene PR-runner is niet toegestaan zonder een apart threat model voor forkcode, secrets, isolatie en cleanup.

## Operationele voorwaarden

- Geen VM, lease of betaalde benchmark zonder werkende authenticatie, actief plan en expliciete kostengoedkeuring.
- Iedere remote job heeft timeout/TTL, `stop: always` of een aantoonbaar gelijkwaardige cleanup en een teruggelezen eindstatus.
- Secrets blijven in provider/GitHub secret stores en verschijnen niet in commando, timingrecord of artifact.
- Provider, machine, regio, image, lockfile, dataset, concurrency en cold/warm zijn verplichte dimensies.
- Crabbox- en exe.dev-resultaten krijgen eigen baselines. We publiceren geen provider-ranglijst.
- exe.dev-statistieken zijn context; de eigen monotone applicatiefasetimers zijn leidend voor de job. Ze vervangen geen ontbrekende Crabbox providerfasetiming.

## Waarom niet anders

- Crabbox vervangt GitHub CI niet: GitHub blijft de merge- en permission-boundary.
- exe.dev is niet de primaire schone lane: persistente disk en gedeelde compute maken cold-state en isolatie minder vanzelfsprekend.
- Eén getal voor alle providers zou machineverschillen en provisioningruis als coderegressie presenteren.

## Bronnen

- [Crabbox v0.62.0 release](https://github.com/openclaw/crabbox/releases/tag/v0.62.0)
- [Crabbox run/timing, gepinde release](https://github.com/openclaw/crabbox/blob/v0.62.0/docs/commands/run.md)
- [Crabbox bench, gepinde release](https://github.com/openclaw/crabbox/blob/v0.62.0/docs/commands/bench.md)
- [Crabbox deterministic performance-status](https://github.com/openclaw/crabbox/blob/v0.62.0/docs/features/deterministic-perf-evidence.md)
- [Crabbox exe.dev-provider](https://github.com/openclaw/crabbox/blob/v0.62.0/docs/providers/exe-dev.md)
- [exe.dev VM-model](https://exe.dev/docs/what-is-exe) en [SSH-API](https://exe.dev/docs/api)
- [exe.dev capaciteit/billing](https://exe.dev/docs/billing/overview), [Docker](https://exe.dev/docs/faq/docker) en [voorwaarden](https://exe.dev/docs/terms-of-service)

De Crabbox v0.62.0-releasemetadata, archive en checksum zijn op 19 september 2026 rechtstreeks opgehaald en inhoudelijk gecontroleerd. De host-side provenance-check is de geaccepteerde integriteitsgrens voor de `exe-dev-shadow`-launcher van deze unsigned local install; de performance-job start direct op de remote workspace en valt onder zijn eigen shadow-only acceptance gap. Een mislukte macOS `codesign --verify --deep --strict`-check wordt niet omzeild of als groen bewijs gepresenteerd. De overige provider- en exe.dev-documentatie is de operationele referentie voor deze lane.

## Onopgelost bewijs

Er is in deze ADR geen Crabbox-lease of exe.dev-VM gestart. Provider-authenticatie, betaalstatus, Docker-preflight, werkelijke cleanup en een eerste timingartifact moeten in een geautoriseerde shadow run worden bewezen voordat de lane “operationeel” heet. Acceptatie vereist daarnaast een gecontroleerde direct-run-wrapper die `--timing-json` en een lokale `--timing-record <path>` gebruikt zonder de stop/finally-cleanup te omzeilen.

## Addendum 2026-08-31 — exe.dev sizing

De eerste live provisioning-poging (`crabbox job run exe-dev-shadow`, lease `cbx_f04fd7cdd10c`) werd door exe.dev geweigerd: het huidige plan (Individual — Small: 2 vCPU en 8 GB geheugen totaal, gedeeld over alle VM's; 100 GB pooled disk) staat maximaal `--cpu 2` toe. De vaste sizing van de exe.dev-lane is daarom teruggebracht van `4cpu-8gb-40gb` naar **`2cpu-8gb-40gb`** (`.crabbox.yaml` `exeDev.cpus/memory`, `PERF_MACHINE`, `MACHINE_CLASS` in `scripts/crabbox-exe-dev-shadow.sh`). Dit is een nieuwe cohortdimensie: records met `machine=2cpu-8gb-40gb` mogen niet met een eventuele latere 4-vCPU-cohort worden samengevoegd. De schijf blijft 40 GB omdat de doctor minimaal 20 GB eist en Docker-images ruimte nodig hebben.
