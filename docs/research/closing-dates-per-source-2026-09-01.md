# Closing-date coverage per source (RJC-377, 2026-09-01)

Six sources set `sluitingsdatumPassed` hard `false` prior to this fix. Per source: does it publish a real closing moment, and what closes an aanvraag today.

| Source | Publishes a closing moment? | Field + sample value | Decision | What closes it (if not computed) |
|---|---|---|---|---|
| Need Staffing | Yes | `detail.deadline` (epoch-ms, has time-of-day) — `"1788778800000"` = 2026-09-07T11:00:00Z, from the detail page's "Deadline voor reageren" block | **computed** — was parsed into `bronSpecifiek.deadline` but never used; now feeds `sluitingsdatumPassed` at full instant precision | n/a |
| Harvey Nash | Yes (two candidates) | `detail.facts.deadline` (Dutch free text, supplier/candidate-submission deadline, e.g. "04-09 om 09:00") vs. `detail.jsonLd.validThrough` (ISO instant, listing-validity date, e.g. "2026-09-07T23:59:59.999Z" — matches the search endpoint's `expires_at`) | **computed** from `validThrough` (client-/listing-facing, same precedent as Striive's closingDateClient/closingDateInvoice split); `facts.deadline` stays display-only in bronSpecifiek | n/a |
| TenderNed | No absolute date | `numberOfDaysBeforeAanmeldenInschrijven` (relative day-count, not a date) + `aankondigingCode` (`AGO`/`VBE` = closed) | **honest-false** — no date field exists in the modelled API fields | Already closes via `bronSaysClosed` (`isTenderNedListingOpen`), independent of `sluitingsdatumPassed` — not actually stuck open |
| json-ld / BlueTrail | Yes | `labelBlock.sluitingsDatum` (Dutch text, "2 september 2026") and `jobPosting.validThrough` (RFC 2822, "Wed, 02 Sep 2026...") — confirmed to agree exactly | **computed** — label-block field preferred (via `parseDutchDate`), `validThrough` normalised as fallback | n/a |
| json-ld / Hero.eu | No | Neither `labelBlock.sluitingsDatum` (no label-block config exists for Hero) nor `jobPosting.validThrough` (confirmed absent in both live captures) | **honest-false** | Listing removal only — not wired to any status transition today |
| json-ld / Pro-Act IT | Yes | No label-block `sluitingsDatum`, but `jobPosting.validThrough` is a real per-listing bare ISO date ("2026-09-01"/"2026-10-01" across the two live captures, not a fixed placeholder) | **computed** via the `validThrough` fallback | n/a |
| Flinter | No | Confirmed absent across all 18 live-captured listings (listing and detail pages); `looptijdTekst` is a free-text contract-duration description, not a deadline | **honest-false** (pre-existing docblock, reconfirmed) | Listing removal only |
| Inhuurdesk | No | `InhuurdeskAssignment` is the complete typed shape of the raw response (confirmed against the fixture); only `startDate`/`endDate` (contract dates) exist, no deadline field of any kind | **honest-false** | Listing removal only — and that isn't wired to a status transition either (see judgment calls) |

## Judgment calls

- **Harvey Nash: two candidate deadlines (revised after Fable review).** `facts.deadline` ("Deadline voor het voorstellen van kandidaten") is the recruiter's candidate-submission cutoff; `jsonLd.validThrough` is the JobPosting's own listing-validity date (equal to the search API's `expires_at`). Initial framing treated `facts.deadline` as purely "recruiter-internal" and used `validThrough` as the Striive-`closingDateClient` analogue — that framing was wrong: for this product the recruiter's submission deadline IS effectively the client-facing signal (it's exactly when the aanvraag stops being actionable for a Catapulze user), making `facts.deadline` the closer analogue of `closingDateClient`, not `validThrough`. The code still interim-uses `validThrough` — the conservative LATER bound, since `facts.deadline` depends on year-inference from loose free text (`resolveHarveyNashDeadline`) and can itself resolve to UNKNOWN, and an unknown deadline must never read as closed. **Flagged for Ryan**: the likely correct fix is `deadline === UNKNOWN ? validThrough : deadline` (one-line change, `packages/application/src/normalise/harveynash.ts` ~line 216) — not applied in this pass, pending confirmation. The two dates can diverge (fixture: "04-09" vs. "2026-09-07").

## Checks

- **Is the computed closing moment persisted anywhere, beyond feeding the boolean?** No. `NormalisedAanvraagDraft` (`packages/application/src/normalise/types.ts`) has no `sluitingsdatum`/closing-moment field at all — every normaliser (including the three RJC-376 sources already fixed: striive, ctm, opdrachtoverheid) only ever produces the derived `lifecycle`/`status` enum from `resolveLifecycleStatus`; the actual date value is discarded once the boolean is computed (though the *raw* source text is separately kept in `bronSpecifiek` for all four newly-computed sources here — `needstaffing.deadline`, `harveynash.deadline_raw`/`json_ld_valid_through`, `bluetrail/pro-act.sluitings_datum`/`valid_through`). Adding a canonical persisted field is out of scope here — tracked as RJC-394.
- **json-ld: label-block vs validThrough disagreement.** When BlueTrail's `labelBlock.sluitingsDatum` and `jobPosting.validThrough` both exist and disagree, the label-block value silently wins (see `parseJsonLdPayload`'s `sluitingsDatum` derivation) with no signal surfaced. The normaliser layer has no warnings/observations channel to emit into — not invented here. Documented in the docblock at the call site and in `docs/sources/bluetrail.md`.

## Gaps / out of scope

- **TenderNed's RSS feed reportedly carries the closing date as text** (per `docs/sources/tenderned.md`'s own note), which the current JSON-based connector/discovery path doesn't fetch. Not touched here — that's a connector/discovery change, outside this normaliser-only fix's ownership, and TenderNed already has a working (non-date) closing signal.
- **`missedPolls` is hard-coded to `0` in every normaliser** (all eleven sources, not just these six) — the stale/missed-poll branch of `resolveLifecycleStatus` is never actually exercised today. This means "listing disappeared from the source" is not a wired closing signal for Flinter, Hero.eu, or Inhuurdesk (the three genuinely-absent sources) beyond "eventually gets re-observed as closed if the source itself starts saying so." This is a pre-existing, cross-source gap, not something introduced or fixed by RJC-377 — flagged for awareness, not fixed here.
- **No canonical persisted closing-moment field** (see Checks above) — RJC-394.

## Verification

- `bun test packages/application packages/connectors`: see amendment commit for pass/fail counts (base pass was 417/0, 19 new tests; amendment adds further edge-case tests for the codex-review fixes below).
- `bun run check-types`: 11/11 packages pass.
- `bunx ultracite check` on the changed files: clean.
- `bun run check-secrets`: exit 0.
- `bun run relevance`: OVERALL (macro) recall@20 0.457 / ndcg@10 0.465 — byte-identical to the required baseline.
- Content-hash inputs (`packages/connectors/src/*/hash.ts` for all six sources) were read and are untouched — none of them hash the derived `sluitingsdatumPassed` boolean, and the raw fields they already hash (or the full raw body, for the two sources with body-only hashing) are unchanged by this fix. No re-hash/dedup churn.

## Amendment (codex + Fable re-review, RJC-377)

Two independent reviews (Fable: ship after a docblock fix; codex: 5 P0 findings, 3 confirmed real bugs) landed on this same commit before it was pushed. Fixed:

1. **`needstaffing.ts`** — `epochToIsoInstant` used `Number(raw)` directly: `Number("")`/`Number(" ")` is `0` in JS, which resolved to epoch 1970 and read as "already closed" (a false positive), and an absurd value (`1e20`) or a negative string could reach `new Date()` unguarded. Now requires a strict `/^\d{10,13}$/u` digit-only match plus a sane calendar range (`2000-01-01`..`2100-01-01`) before ever calling `new Date()`.
2. **`json-ld.ts`** — the `validThrough` fallback truncated every value to a bare date via `.toISOString().slice(0, 10)`, so a full instant (e.g. `…T11:00:00Z`) read as "open until end-of-day Amsterdam" instead of closing at its actual time, and slicing a parsed UTC instant back to a date string could land on the wrong day for a `+02:00`-style offset near local midnight. Fixed by classifying the raw value first: a bare `YYYY-MM-DD` passes through verbatim (still end-of-day Amsterdam, per RJC-376); anything with a time component is parsed (never sliced) and re-emitted as a full ISO instant for exact comparison.
3. **Both `json-ld.ts` and `harveynash.ts`** — an impossible calendar date (`2026-02-30`, a `13`-month) does not throw when run through `new Date`; it silently rolls over into a real neighbouring date. `json-ld.ts`'s `parseDutchDate` (BlueTrail's hand-typed sidebar text is the actual risk surface) and `harveynash.ts`'s `validThrough` guard (defensive, since it's machine-generated JSON-LD) now round-trip year/month/day through `Date.UTC` and compare the fields back out before trusting the value; a mismatch is treated as "no closing information" (`false`), not silently redated.

Rationale docblock in `harveynash.ts` rewritten per Fable's note above (was: "recruiter-internal, not when the assignment closes" — now names `facts.deadline` as the closer `closingDateClient` analogue, with `validThrough` kept as the interim conservative choice).
