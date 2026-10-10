# Lokale Effect all-flags-on E2E-lane

Deze lane start een volledig disposable Compose-project voor een lokale
acceptatierun. Het project gebruikt een unieke Compose-projectnaam, eigen
Postgres- en Manticore-volumes en loopback-poorten. Het leest geen
`apps/*/.env` en stopt geen bestaande workload.

Start de lane vanuit de repositoryroot:

```sh
bun run e2e:effect:local
```

De runner bouwt de bestaande server-, web-, projector- en worker-images, start
Postgres, Redis en Manticore, voert migraties uit met een expliciete
`MIGRATION_DATABASE_URL`, maakt een synthetische recruiter én operator aan en
start daarna API en web. De seed schrijft direct één synthetische canonieke
aanvraag, bron, scrape-run en outbox-event in de disposable database; dit is
geen connector-ingestieclaim. Daarna voert de runner de bounded worker-probe
uit vóór de projector start. De recruiter bewijst de zoekroute én wordt
aantoonbaar geweigerd voor `/bronnen` en `GET /v1/dashboard`; de operator
bewijst de afgeschermde `/bronnen`-monitor met de eigen seeded bronkaart en
KPI-tellingen. Alle vijf flags staan
exact op `1` in de processen die ze gebruiken:

De API draait in `NODE_ENV=test` met een server-local filesystem raw store. Dat
is bewust een lokale disposable modus en geen productie-equivalente
persistentieclaim; de productieguard blijft actief voor `NODE_ENV=production`.

Na een succesvolle build kan een herhaalrun op een krappe host de bestaande
images hergebruiken, maar alleen vanuit een aantoonbaar schone Git-workspace
met revision-scoped images:

```sh
EFFECT_E2E_SKIP_BUILD=1 bun run e2e:effect:local
```

Deze optie verwacht de revision-scoped images en de publieke API-poort waarop
die web-image tijdens de build is geconfigureerd. Geef die poorten expliciet
mee bij reuse, bijvoorbeeld `EFFECT_E2E_SERVER_PORT=51259
EFFECT_E2E_WEB_PORT=47627`; zonder passende images of vrije poorten faalt
Compose veilig in plaats van een andere stack te gebruiken. Bij dirty,
untracked of Git-loze broncode weigert de runner `EFFECT_E2E_SKIP_BUILD=1` en
moet de lane opnieuw bouwen.

| Oppervlak | Variabele |
| --- | --- |
| Database | `JI_EFFECT_DB=1` |
| Server | `JI_EFFECT_SERVER=1` |
| Worker | `JI_EFFECT_WORKER=1` |
| Performance | `PERF_EFFECT_SPANS=1` |

`seed.ts` en `check.ts` vormen de helpergrens. De seed weigert een niet-
disposable database, een verkeerde database-identiteit of fixturemodus. De
checker gebruikt de echte API en browserflow voor readiness, release identity,
authenticatie, exacte canary readback, de recruiter-zoekroute, de negatieve
recruiter-rolgrens en de inhoud van de operator-`/bronnen`-monitor. Auth
credentials en browser storage state staan alleen
tijdelijk buiten de repository en komen niet in evidence.

Bewijs komt onder `.artifacts/effect-e2e/<run-id>/`. De runner bewaart alleen
gesaniteerde failure-output. Bij een fout worden uitsluitend het eigen Compose-
project, de eigen containers en de eigen volumes opgeruimd. Een exitcode `2`
betekent dat de primaire lane niet volledig bewezen is, bijvoorbeeld wanneer
geen performance record is geschreven. Exitcode `0` vereist primaire helper-
checks, een bounded worker task-body probe en ten minste één performance record.

De worker-probe bewijst alleen de Effect task-body boundary met Postgres en
Manticore. Zij bewijst geen Trigger.dev durability of retrygedrag. De
performance-artifacten bewijzen dat de critical-path sink aan een echte
applicatieroute hing. De huidige JSON-records exporteren geen afzonderlijk
Effect-span-event, dus dat deel blijft expliciet
`not-observable-from-record-file`.

De lane claimt geen productie-, Trigger- of native/Effect-pariteit buiten deze
synthetische disposable setup. De bestaande live-jobs guards blijven
ongewijzigd.
