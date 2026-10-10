# Sources

Every ingestable bron is one entry in the source registry: `packages/application/src/sources/index.ts` (`SOURCES`). The worker's connector routing, the poll-bron payload schema, the smoke seed, `replay:run`, and `processObservation`'s normaliser dispatch all derive from it — nothing else enumerates sources.

## Adding a source

1. Connector: `packages/connectors/src/<slug>/index.ts` plus fixtures under `fixtures/connectors/<slug>/` (at least `listing-page-0.json`, which is what `replay:run` and the fixture smoke read). It is importable as `@ji/connectors/<slug>` via the wildcard export; no `package.json` edit.
2. Normaliser: `packages/application/src/normalise/<slug>.ts` exporting `normalise<Name>Observation(body: Uint8Array, contentHash: string): NormalisedAanvraagDraft`.
3. Definition: `packages/application/src/sources/<slug>.ts` exporting a `SourceDefinition` (`slug`, `naam`, `bronId`, `liveEnv`, `seed`, `createConnector`, `normalise`). Copy `inhuurdesk.ts` as the template. `naam` is free-form display text ("Need Staffing IT" is fine); the bron row has no slug column, so `resolveSourceByNaam` matches a row's `naam` case-insensitively against this field — keep it unique across sources.
4. Registry: add `<slug>,` to `SOURCES` in `packages/application/src/sources/index.ts`. Keys are sorted at runtime, so order does not matter.
5. Env: add the `liveEnv` name (e.g. `NEEDSTAFFING_LIVE=`) to `apps/worker/.env.example` next to `TENDER_NED_LIVE` / `INHUURDESK_LIVE`. The smoke script loads `apps/server/.env` then `apps/worker/.env` (see `docs/runbooks/slice-a-live-smoke.md`); leaving the flag unset keeps the connector on fixtures.
6. Voorwaarden: `docs/sources/<slug>.md` must carry a `## Voorwaarden` section (robots.txt probe, ToS, `Besluit`, besluitnemer) — `voorwaarden.spec.ts` asserts the `- Besluit:` value equals `seed.voorwaardenStatus`, so the doc and the seed can never drift.

The smoke seed writes `mappingRef = fixtures/connectors/<slug>/mapping.json` on the bron row. That path is a reference only — nothing reads it today, and no source ships one yet.

`apps/web` must not import `@ji/application/sources` (enforced by `bun run check-layering`); the UI's source list comes from the API's bron catalog.

## Sources without JobPosting JSON-LD

Some werkenbij-sites publish no `ld+json` JobPosting but do carry the vacancy as
structured data elsewhere. For those the json-ld connector has two config
fields instead of a separate HTML-adapter (added for Alliander/Essent/TenneT,
2026-09-30):

- `detailSynthesizer(body, url)` — a per-source function that rebuilds the
  JobPosting (+ label block) from whatever the detail body carries: framework
  state (ASML `__NEXT_DATA__`, Techniekwerkt `vike_pageContext`), an embedded
  payload (Essent's base64 Vue `DataItems`), narrative markup (TenneT's Avature
  `article--details` + `og:` metas), or a JSON API record (Alliander). It runs
  only when no explicit JobPosting node exists, and returns `null` when the
  expected structure is absent — fail closed, never guess.
- `detailUrlRewrite` — maps the discovered public URL onto the endpoint that
  actually serves the record (Alliander's client-rendered
  `/vacatures/<slug>/jr<id>` page vs. its `/api/vacancy/<id>` JSON). The
  observation keeps the public URL as its identity.

Fields the source does not publish stay UNKNOWN — synthesis must not infer
location, dates, hours or tarief from prose.

## Field coverage

`bun run check:field-coverage` replays every source's committed fixtures
through its connector + normaliser (the same replay as
`bun scripts/field-coverage.ts`) and fails when a source's per-field count
drops below `fixtures/field-coverage/baseline.json`. The gate runs it, so a
normaliser or connector change that silently drops a field blocks the push.

When a change intentionally moves coverage — a trimmed fixture, a normaliser
that stops filling a field — regenerate the baseline in the same commit:
`bun run check:field-coverage -- --write-baseline`. Sources absent from the
baseline warn but do not fail, so a new source merged on a parallel branch
needs no baseline refresh to stay green; run `--write-baseline` on the next
coverage-touching change to record it.
