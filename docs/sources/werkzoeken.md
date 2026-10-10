# Werkzoeken — ingest + bron-URL audit (CTP-528)

Status (2026-09-16): **Motian Neon-v1 historical import only** for production
corpus. Live HTTP (`WERKZOEKEN_LIVE=1`) is gated and currently blocked by a
Cloudflare **managed JS challenge** on every public URL (home, sitemap,
robots.txt, vacancy detail). Browser-like headers alone do **not** clear it.
Provincie-from-title mapping landed in PR #284; this doc is the honest
Cloudflare unblock path.

## Endpoints

| Doel | URL | Status 2026-09-16 |
|---|---|---|
| Home | `https://www.werkzoeken.nl/` | HTTP 403, `cf-mitigated: challenge`, body "Just a moment…" |
| Sitemap | `https://www.werkzoeken.nl/sitemap.xml` | same challenge |
| robots.txt | `https://www.werkzoeken.nl/robots.txt` | same challenge (contents unverifiable until unblocked) |
| Detail | vacancy URLs stored as curated `bron_url` / Motian source URL | same challenge for Herkomst / field-gap audit |

Json-ld connector config: `packages/connectors/src/json-ld/configs/werkzoeken.ts`
(`parserVersion: werkzoeken/v1`, discovery via sitemap). No
`SourceDefinition` in the live registry yet — corpus is Motian-only
(`docs/runbooks/motian-neon-backfill.md`).

## Cloudflare disposition (verified)

Probe from the build VM (curl with and without Chrome-like `User-Agent` /
`Accept` / `Accept-Language`):

- Response: **403**
- Header: **`cf-mitigated: challenge`**
- Body: Cloudflare managed challenge page (`Just a moment...`,
  `cdn-cgi/challenge-platform`)

Conclusion: this is not a soft bot score that headers can fix. Solving the
challenge requires a real browser (or equivalent) that completes Cloudflare's
JS challenge and receives `cf_clearance` (and related) cookies. Product code
**must not** embed CAPTCHA solvers, residential-proxy CAPTCHA farms, or other
ToS-violating bypasses.

## Honest unblock path (ops cookie / consent jar)

For **bron-URL audit** (CTP-514 field-gap Herkomst compare) and any future
`WERKZOEKEN_LIVE=1` poll:

1. Open the target vacancy URL in a normal browser where an operator may
   accept Cloudflare / site consent as a human visitor.
2. After the page loads, export the Cookie header for `www.werkzoeken.nl`
   (at minimum `cf_clearance`; include `__cf_bm` / consent cookies if present).
3. Put the value in the **protected** worker/server env only — never commit it,
   never paste it into Linear/chat/handoffs:

   ```bash
   WERKZOEKEN_LIVE=1
   WERKZOEKEN_COOKIE='cf_clearance=…; __cf_bm=…'
   ```

4. Re-run the audit fetch or live json-ld client. The shared client
   (`packages/connectors/src/json-ld/live-fetch.ts`) sends browser-like
   headers and, when set, the ops `Cookie` header. On a still-challenged
   response it fails closed with an error that points back here.
5. Cookies expire; refresh from a new consented browser session when fetches
   start returning the challenge again.

Optional code override (tests / one-shot scripts): pass `cookieHeader` into
`createJsonLdClient` / `createJsonLdEffectClient` — same rule, no secrets in
git.

The same `*_LIVE` → `*_COOKIE` pairing is available for other json-ld boards
that later hit a consent or CF gate (see CTP-530 DPG privacy gate for NVB).

## What product will not do

- CAPTCHA / Turnstile solvers
- Undocumented scrape hacks that defeat Cloudflare
- Treating a challenge HTML page as vacancy content
- Inferring commercial fields the Motian/raw projection does not publish

## Provincie (F04) — mapping status

**Closed in code by PR #284** (tip lineage includes `ceca168`):

- Motian `province` column → `bron_specifiek.provincie` via
  `toCanonicalProvincie` for every Motian platform.
- **Werkzoeken only:** when the column is absent, `findProvincieInText(title)`
  (e.g. `Projectleider Vastgoed (Zuid-Holland)` → `Zuid-Holland`).
- City-only locations are never consulted. Names that are both city and
  province (Utrecht, Groningen) stay ambiguous by design.
- Existing curated rows need HIST_MIG repair v3 (**CTP-535**); they do not
  self-heal.

Unit coverage: `packages/application/src/backfill/neon-v1.spec.ts`
("reads provincie from a Werkzoeken title…").

## Field-gap audit notes

CTP-514 Werkzoeken n=5: Herkomst bron-URLs were **5/5 HTTP 403 Cloudflare**,
so live source-page compare was blocked; scoring used curated + Motian raw
only. After an ops cookie jar is in place, re-fetch the same `bron_url`
sample set and attach evidence under the field-gap packet. Evidence path from
the audit: `field-gap/samples-werkzoeken.json`.

## Related

- Linear: [CTP-528](https://linear.app/rcjt-studio/issue/CTP-528)
- Parent audit: CTP-514
- Motian repair: CTP-535 / `docs/runbooks/motian-v1-derived-field-repair.md`
- Sibling access gate: CTP-530 (NVB DPG privacy gate — consent jar, not CF)
