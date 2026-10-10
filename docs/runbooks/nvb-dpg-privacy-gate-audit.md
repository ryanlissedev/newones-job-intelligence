# NVB / DPG Media privacy gate — safe bron-URL audit path (CTP-530)

Nationale Vacaturebank vacancy pages sit behind a **DPG Media privacy /
consent wall**. Unauthenticated `curl` from the box or Hetzner typically
returns **403**; a human browser session that clicks **Akkoord** can load the
live HTML (including `JobPosting` JSON-LD). Field-gap audits need that live
page for bron comparison; Motian raw alone is not the live bron.

## Out of scope

- **Product auto-bypass** of the privacy gate (silent scrape, headless
  click-through, forged consent, ToS workarounds). Not implemented and not
  planned under CTP-530.
- Changing Motian Coolify or inventing consent cookies in CI/production.
- Committing a consent jar or any cookie values to git.

## In scope — ops consent jar

Auditors unlock bron comparison by supplying an **explicit consented**
Playwright `storageState` JSON that they created after accepting the gate
themselves. The ops tool refuses to fetch without that jar.

| Item | Value |
| --- | --- |
| Env | `DPG_CONSENT_STORAGE_STATE` |
| Format | Playwright `storageState` JSON (`{ "cookies": [ … ] }`) |
| Path rules | **Absolute** path **outside** the git worktree (same posture as `E2E_STORAGE_STATE`) |
| Tool | `bun scripts/audit/dpg-consent-fetch.ts --url <nvb-https-url> [--out <dir>]` |

### 1. Capture consent (human)

1. Open a headed browser on an NVB vacancy URL (Herkomst link from Catapulze).
2. Complete the DPG Media privacy UI (**Akkoord** / equivalent). Do not automate
   this click in product code.
3. Persist cookies as Playwright storage state **outside the repo**, e.g.:

```bash
# Example only — run from a machine with a display; path must stay outside git.
bunx playwright open https://www.nationalevacaturebank.nl/
# After Akkoord in the opened browser, from a small capture snippet:
#   await context.storageState({ path: "/var/lib/catapulze/dpg-consent-storage-state.json" })
```

A minimal capture loop (ops laptop / crabbox with display):

```bash
bun -e '
import { chromium } from "playwright";
const out = process.env.DPG_CONSENT_STORAGE_STATE;
if (!out) throw new Error("set DPG_CONSENT_STORAGE_STATE to an abs path outside the repo");
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(process.argv[2] ?? "https://www.nationalevacaturebank.nl/");
console.log("Complete Akkoord in the browser, then press Enter here…");
await new Promise((resolve) => process.stdin.once("data", resolve));
await context.storageState({ path: out });
await browser.close();
console.log("wrote", out);
'
```

Rotate the jar when cookies expire or the gate returns again (`disposition:
"gated"`).

### 2. Audit fetch

```bash
export DPG_CONSENT_STORAGE_STATE=/var/lib/catapulze/dpg-consent-storage-state.json

bun scripts/audit/dpg-consent-fetch.ts \
  --url 'https://www.nationalevacaturebank.nl/vacature/<id>/<slug>' \
  --out /tmp/nvb-bron-audit
```

Stdout is a **disposition-only** JSON report (no cookie values):

- `ok` — HTTP success and not classified as the privacy wall (prefer
  `hasJobPosting: true` for commercial-field compare).
- `gated` — still the consent wall or HTTP 403/451; re-capture the jar.
- `missing_jar` / `invalid_jar` / `invalid_url` — fix ops inputs; tool fails
  closed.

Exit code `0` only for `ok`.

### 3. Bron comparison workflow

1. Take Herkomst URLs from the field-gap sample / UI (n≥5 when repeating CTP-514).
2. Fetch each URL with the consent jar as above.
3. Compare live HTML / JSON-LD to curated + Motian raw using the existing
   field-gap matrix rules (no inventing absences while the live bron shows the
   chip).
4. Attach disposition reports + screenshots to Linear; do not paste jar
   contents.

## Evidence already known

From the CTP-514 gepubliceerd replay packet: curl/WAF **403** without consent;
browser after **Akkoord** yielded live HTML with `JobPosting.datePosted`. That
is the same consent path this runbook formalises for repeatable audit fetches.

## Related

- Linear: [CTP-530](https://linear.app/rcjt-studio/issue/CTP-530/nationale-vacaturebank-unblock-dpg-media-privacy-gate-for-bron-url)
- Parent: CTP-514 field-gap matrix
- Connector config: `packages/connectors/src/json-ld/configs/nationalevacaturebank.ts`
- Source note: `docs/sources/nationalevacaturebank.md`
