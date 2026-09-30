# Application-image CI smoke

`bun run docker:smoke` runs the deployable server, web, migrator, and projector
Docker paths against disposable synthetic services. GitHub Actions runs the
same command in the `application-image-smoke` job with a 30-minute job timeout.

The smoke builds `apps/server/Dockerfile`, `apps/web/Dockerfile`,
`apps/server/Dockerfile.migrate`, and `apps/server/Dockerfile.projector`. It
then:

1. starts isolated PostgreSQL, Redis, Manticore, and MinIO fixtures;
2. requires the one-shot migrator image to exit successfully;
3. requires server readiness and the web homepage plus logged-out dashboard
   redirect to work from inside the Compose network;
4. writes one synthetic request and outbox event, provisions a synthetic
   recruiter, and requires authenticated REST search to return that exact
   request after the projector processes it;
5. runs the existing live Manticore document-ID integration test; and
6. requires the projector heartbeat check to pass.

The script uses a unique `catapulze-smoke-*` Compose project for every process.
`docker-compose.smoke.yml` removes host ports and application env files, and
uses project-scoped volumes. The Compose subprocess receives a clean
environment plus the committed synthetic fixture file, so shell database,
search, volume, and Compose variables cannot redirect the default smoke.
`COMPOSE_PARALLEL_LIMIT=2`, the root type-check command, the timed build, and
the Next.js build configuration cap their work at two. The smoke always reads
the committed synthetic fixture; it never
accepts a local or production dotenv override. Crabbox runs the same isolated
fixture after its non-paid preflight.

An exit trap captures `.artifacts/docker-smoke/containers.txt` and
`.artifacts/docker-smoke/compose.log`, then runs `down --volumes
--remove-orphans`. A cleanup failure fails an otherwise successful smoke. The
CI job uploads those files on success and failure with seven-day retention.

The first successful remote evidence is [PR #157](https://github.com/ryanlissedev/rsp-job-intelligence/pull/157)
at exact head `6bc25541743781fcb93442f30191ddb6847fc107`. In [CI run
33927344487](https://github.com/ryanlissedev/rsp-job-intelligence/actions/runs/33927344487),
the `application-image-smoke` job completed successfully in 2m56s; its `Build
and smoke application images` step took 2m50s.

Required-check configuration remains a separate repository-administration
task. The administration API returned HTTP 403 because the current GitHub plan
does not provide required-check enforcement for this private repository. This
runbook does not claim automatic enforcement and does not authorize a billing
plan or repository-visibility change.

Until repository administration can enforce the checks, use this manual merge
gate. When the `changes` job reports `code == true`, the exact current PR head
must have successful `verify`, `build`, `postgres-restore-drill`, and
`application-image-smoke` checks before merge. For a documentation-only PR with
`code == false`, `verify` must succeed and the other three checks must show their
expected code-filter skips. Re-check the applicable success/skip set after every
head change. Independent agent reviews are separate evidence; they are not
formal GitHub approvals.

This check proves the images start and complete a synthetic application path at
the tested commit. It is not deployment, production-data, backup, or live
hosting proof.
