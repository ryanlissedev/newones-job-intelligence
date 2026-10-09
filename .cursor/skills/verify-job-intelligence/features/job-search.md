# Job search

The `/jobs` route exposes Boolean job search with filters, sort, pagination, and a desktop results table. Browser tab title is `Opdrachten zoeken · Catapulze Job Intelligence`. Job detail opens as URL state on the same route (`?job=<id>` alongside query params), not a separate `/jobs/[id]` page. With `NEXT_PUBLIC_USE_FIXTURES=1` in `apps/web/.env`, the UI uses in-repo fixture data and does not require Manticore or a live REST index.

## Sub-features

- `jobs-open` loads `/jobs` with search label `Zoek opdrachten met Boolean-logica`.
- `jobs-results` results region has `aria-label="Zoekresultaten"`.
- `jobs-query` the query input accepts Boolean syntax (placeholder e.g. `(Azure OR "Power BI") NOT junior`).
- `jobs-detail` selecting a result adds `job=<id>` to the URL while staying on `/jobs`; closing detail removes `job` and preserves other params (e.g. `q=Azure`).
- `jobs-detail-opdracht` the detail `Opdracht` section renders via `JobBodyContent` (allowlist HTML sanitize); HTML bron bodies show `data-body-format="html"` with rendered markup (fixture `job-html-nvb`: `TypeScript Engineer (HTML body fixture)`).
- `jobs-detail-raw-preview` the `Raw preview` section exposes a scroll container `data-testid="job-raw-preview-scroll"` (`max-h-72 overflow-y-auto`) over the immutable bron payload preview.
- `jobs-detail-aangevuld` when `enrichedFields` includes a field with confidence ≥ 0.8, Locatie/Tarief/Contract/Werkvorm show an `aangevuld` badge with `title` from `aangevuldLabel` — detail panel only, not results rows.
- `jobs-nav` header nav link `Zoeken` routes to `/jobs`.
- `jobs-chips` every active filter and the query render as a removable chip above the results; `Alles wissen` clears query and filters together.
- `jobs-facets` the sidebar facet groups (`Bron`, `Contract`, `Locatie`, `Gepubliceerd`, `Minimum uurtarief`) collapse on their heading and show live counts; groups past six entries expose `Toon alle N …`.
- `jobs-archive` the `Ook in archief zoeken` checkbox sets internal state `scope=all`; the shareable URL query is `archief=1` (not `scope=`), per `search-state.ts` (RJC-383).
- `jobs-auth-gate` without `NEXT_PUBLIC_USE_FIXTURES` and without a session, `/jobs` shows H1 `Opdrachten zoeken` (server-rendered, with a skeleton while the session check runs), then H2 `Log in om opdrachten te bekijken` and button `Inloggen` instead of search UI.

## How to get to it (user POV)

- Choose header nav `Zoeken`.
- From home, choose `Open job search` or `Bekijk een zoekvoorbeeld` (`/jobs?q=Azure&freshness=30d`).
- Open `http://localhost:3001/jobs` directly (optional query string).

## Driving it with control.mjs

Preconditions:

- Doctor reports `ok: true`.
- `NEXT_PUBLIC_USE_FIXTURES=1` (or `true`) in `apps/web/.env` for verification without Manticore. Without fixtures, `/jobs` needs a reachable REST/search stack (U7).

- **HTTP shell.** Run `bun .cursor/skills/verify-job-intelligence/scripts/control.mjs http http://localhost:3001/jobs`. Status `200`; body contains `Zoek opdrachten met Boolean-logica`, `Zoekresultaten`, and `Opdrachten zoeken`.
- **Example query.** Load `/jobs?q=Azure&freshness=30d` in a browser; URL keeps `q=Azure` and results filter accordingly.
- **Browser results.** Wait for `[aria-label="Zoekresultaten"]` to contain at least one result row (`table tbody button`) when fixtures are enabled.
- **Detail panel.** Activate a result; URL gains `job=<id>` without leaving `/jobs`. Dismiss detail; `job` param clears. Scroll the detail pane to assert `Opdracht` (`JobBodyContent`), `Raw preview` (`data-testid="job-raw-preview-scroll"`), and (when data present) `aangevuld` badges on metadata fields.
- **HTML body fixture.** Open `/jobs?job=job-html-nvb` to prove sanitized HTML Opdracht rendering and raw preview scroll without Manticore.
- **Proof.** Save HTML or a screenshot under `artifacts/job-search/` with `meta.json` recording `NEXT_PUBLIC_USE_FIXTURES` and the query/detail URL exercised.

## Gotchas

- Fixture mode is the default verification precondition; record it in `meta.json` when fixtures were required.
- Without fixtures, an empty or loading shell may mean Manticore/REST is down — that is an environment gap, not a passing search proof.
- Search UI copy is Dutch; auth pages remain English (`Welcome Back`, `Sign In`, etc.). Public sign-up is disabled — do not expect `Create Account` on `/login`.
- Archive toggle: assert `archief=1` in the URL when archive search is on; `scope=` is internal state only.
- Without fixtures and without a session, `/jobs` is an auth gate — that is expected, not a search regression.
- Pagination controls read `Vorige` / `Volgende` on screen with accessible names `Vorige pagina` / `Volgende pagina`.
- Boolean search and the facet sidebar are the capability the reference design does not have; a port that drops either is a regression, not a simplification.
- Do not invent separate feature files for approvals or Spott export — they have no `:3001` UI yet.
- Fixture jobs omit `enrichedFields`; `jobs-detail-aangevuld` is **verified-unreachable** under `NEXT_PUBLIC_USE_FIXTURES=1` unless you seed enriched data or drive against live REST with enrichment. Do not infer badges from plain fixture metadata.
- Detail panel may exist twice in the DOM (mobile + desktop); scope Playwright assertions to the visible `complementary` region or `:visible` locators.
