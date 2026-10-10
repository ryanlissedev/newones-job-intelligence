# Home command center

The public home page (`/`) is a recruiter landing page. Anonymous visitors see the login path without fabricated counts. Authenticated recruiters see a live overview backed by the search capability, including its true total and returned facets; `NEXT_PUBLIC_USE_FIXTURES=1` is an explicit demo mode. API reachability is verified by doctor via tRPC `healthCheck`; home does not show an on-page API status section.

## Sub-features

- `home-open` loads `/` with heading `Vind de juiste opdracht vóór de rest.`
- `home-brand` header lockup contains `Job Intelligence` as brand text only (not a page heading on `/`).
- `home-cta-search` primary link `Open job search` routes to `/jobs`.
- `home-cta-example` secondary link `Bekijk een zoekvoorbeeld` routes to `/jobs?q=Azure&freshness=30d`.
- `home-health-ok` tRPC `healthCheck` returns `OK` (doctor-only; not rendered on home).
- `home-authenticated-overview` a signed-in recruiter sees `Beschikbare opdrachten`, an optional API-provided archive total, and source, location, contract, and status facets.
- `home-filter-links` each returned facet links into `/jobs` with the corresponding server filter.
- `home-states` loading, live API error, and empty-index states are explicit and contain no replacement numbers.

## How to get to it (user POV)

- Open `http://localhost:3001/` in the browser.
- Choose header nav `Overzicht` while on another route.
- Choose the brand link `Catapulze Job Intelligence — overzicht` in the header.

## Driving it with control.mjs

Preconditions:

- Doctor reports `ok: true`.
- Anonymous checks require no session. The authenticated overview requires a provisioned recruiter-capable account.

- **Open home anonymously.** Load `/`. Run `bun .cursor/skills/verify-job-intelligence/scripts/control.mjs http http://localhost:3001/`. Status `200`; body contains `Vind de juiste opdracht`, `Inloggen`, and `Job Intelligence`. Body contains no preview KPI numbers.
- **API health (doctor).** Run `bun .cursor/skills/verify-job-intelligence/scripts/control.mjs doctor`. `healthBody` contains `OK`.
- **CTAs.** In a browser, choose `Open job search` and land on `/jobs`.
- **Authenticated overview.** Sign in with a provisioned recruiter account. The overview must show live totals/facets or a truthful loading/error/empty state; choose a source, location, contract, or status facet and land on `/jobs` with that filter in the URL.
- **Proof.** Run `bun .cursor/skills/verify-job-intelligence/scripts/control.mjs snapshot home-command-center`. `artifacts/home-command-center/home.html` contains the recruiter H1; `trpc-healthCheck.txt` contains `OK`. Capture the authenticated overview separately when credentials are available.

## Gotchas

- Do not expect `API status` or a browser `Connected` label on home — those belonged to the old skeleton and were removed in U9.
- Opening the app at `127.0.0.1:3001` while env uses `localhost` can block Next.js dev chunks. Drive at `localhost:3001`.
- Anonymous home is intentionally a landing page; it does not show fixture or live metrics.
- Fixture overview data is synthetic and appears only when `NEXT_PUBLIC_USE_FIXTURES=1` is explicitly enabled. It is labeled as demo data.
- A returned search `total` is authoritative even when the adapter hydrates only one result for the overview request. Never count the page items as a global metric.
- The operator-only `/v1/dashboard` capability is not used by the recruiter overview.
