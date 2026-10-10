# Nationale Vacaturebank

| | |
| --- | --- |
| Site | https://www.nationalevacaturebank.nl |
| Slug | `nationalevacaturebank` |
| Discovery today | Motian-backed import / json-ld enrich path |
| Connector config | `packages/connectors/src/json-ld/configs/nationalevacaturebank.ts` |
| Live env flag | `NVB_LIVE` |

## Privacy gate (audit)

Live vacancy HTML is behind a **DPG Media** privacy / consent wall. Product
auto-bypass is **out of scope**. For bron-URL audit fetches, ops supplies an
explicit consented Playwright storage-state jar and uses:

`docs/runbooks/nvb-dpg-privacy-gate-audit.md`

(`bun scripts/audit/dpg-consent-fetch.ts`).

## Notes

- JobPosting JSON-LD on the live page is the trusted source for absolute
  `datePosted` and other commercial chips when Motian raw lacks them.
- Do not commit consent cookies or storage-state files.
