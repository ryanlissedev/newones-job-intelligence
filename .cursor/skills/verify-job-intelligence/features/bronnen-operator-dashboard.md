# Bronnen operator dashboard

Shipped operator monitor at `/bronnen` (RJC-410–416) for ingest health, KPIs, and scrape-run navigation. Role gate: `operator` or `admin` via `canAccessBronnen` in `apps/web/src/app/bronnen/bronnen-window.ts`. Anonymous users and `recruiter` (and other non-operator roles) redirect to `/?toast=forbidden`; the home page shows toast `Je hebt geen toegang tot de bronmonitor.` Header nav link `Bronnen` is role-gated and hidden while signed out or without operator/admin role. Routes: `/bronnen`, `/bronnen/runs`, `/bronnen/runs/[id]`. Runbook: `docs/runbooks/bron-dashboard.md`. Vacancy ingest workers, approvals, and Spott export are out of scope for this map.

## Sub-features

- `bronnen-guard-anonymous` signed-out `GET /bronnen` redirects to `/?toast=forbidden` (not a 200 on `/bronnen`).
- `bronnen-nav-visible` header nav shows link `Bronnen` → `/bronnen` only for signed-in `operator` or `admin`.
- `bronnen-overview-open` operator/admin loads `/bronnen` with H1 `Bronnen`, eyebrow `Operator monitor`, and intro link `Bekijk scrape-runs` → `/bronnen/runs`.
- `bronnen-kpis` seven KPI tiles: `Runs`, `Succes%`, `Nieuw`, `Gewijzigd`, `Ongewijzigd`, `Rejected`, `Bronnen met aandacht` (test ids `bronnen-kpi-*`).
- `bronnen-window-links` period nav `24 uur` / `7 dagen` / `30 dagen` updates `?window=24h|7d|30d` (default `7d` when absent or invalid).
- `bronnen-runs-link` intro link `Bekijk scrape-runs` routes to `/bronnen/runs`.

## How to get to it (user POV)

- Signed in as `operator` or `admin`: choose header nav `Bronnen`.
- Direct URL: `http://localhost:3001/bronnen` (same role gate applies).
- From overview: choose `Bekijk scrape-runs` for `/bronnen/runs`.
- Switch period with nav `24 uur`, `7 dagen`, or `30 dagen`.

## Driving it with control.mjs

Preconditions:

- Doctor reports `ok: true`.
- **For guard and nav-hidden checks:** no Better Auth session (anonymous or recruiter without operator role).
- **For overview/KPI/window/runs sub-features:** a provisioned `operator` or `admin` account (`auth:provision` with role, or `AUTH_BOOTSTRAP` with operator/admin). Without one, mark those sub-features `verified-unreachable` in `meta.json` with prerequisite `provisioned operator or admin account`.

- **Anonymous guard.** Clear cookies, load `/bronnen`. Final URL is `/` with query `toast=forbidden` (server redirect). Header must not show nav link `Bronnen`. Toast copy `Je hebt geen toegang tot de bronmonitor.` appears after client hydration on `/`.
- **Nav hidden (anonymous).** On `/` signed out, header nav contains `Overzicht` and `Zoeken` only — no `Bronnen`.
- **Operator overview (when provisioned).** Sign in, choose `Bronnen`. H1 `Bronnen`, KPI labels above visible, section heading `Bronkaarten`. Choose `7 dagen` / `30 dagen` and confirm URL query updates.
- **Runs link (when provisioned).** From `/bronnen`, choose `Bekijk scrape-runs`; land on `/bronnen/runs`.
- **Proof.** `drive.mjs` writes under `artifacts/bronnen-operator-dashboard/` (`meta.json`, screenshots, redirect trace). Record unreachable operator paths with prerequisite in `meta.json`.

## Gotchas

- Product URL window `24h` maps to capability API window `24u` via `toDashboardApiWindow()` — do not expect `24h` in `/v1/dashboard` query strings.
- Invalid or unknown `window` query values fall back to default `7d` (`parseBronnenWindow`).
- `/bronnen/runs` and `/bronnen/runs/[id]` use the same role gate and forbidden redirect as the overview.
- Header hides `Bronnen` while session is pending (`isPending`) — wait for session resolution before asserting nav visibility for signed-in operators.
- KPI and bron-card data come from capability `GET /v1/dashboard`; empty DB may show `Nog geen bronnen geregistreerd.` — that is valid, not a map failure.
- Do not map vacancy ingest workers, approvals, or Spott export here; they remain planning-only.
