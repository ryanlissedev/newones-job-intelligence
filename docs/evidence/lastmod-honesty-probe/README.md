# Evidence: lastmod honesty probe (PR2, stacked on #468)

Branch `perf/lastmod-revalidation-backstop`, base `perf/json-ld-lastmod-skip` (#468).
Ran 2026-10-09 on the box. There was no prod access.

## Why

#468 skips a sitemap detail page while its `<lastmod>` has not moved, with a weekly per-URL revalidation day as the backstop.
lastmod is a claim by the publisher, not a proof (invariant C2). A source that edits pages without bumping lastmod
freezes those edits for up to 7 days, and nothing notices.

## What

- A daily, deterministic 2% sample of would-be-skipped pages is fetched anyway (the **honesty probe**).
- The probe's payload hash is compared with the one persisted at the last fetch (`source_record.content_hash`,
  read through the new `KnownHashStore.getPayloadHash`). A different payload with an unchanged lastmod means lastmod lied.
- Once lies exceed 1% of judged probes, the run **stops trusting lastmod**: nothing more is skipped. This is fail-safe.
- Distrust is per run. Each new run starts trusting again, so an honest source keeps its savings.

## Result: 2,000-page corpus, real runner and json-ld connector ([harness](./evidence-harness.ts))

```
honest source, probe 2% (default)            edits=   0 fetched= 322/2000 changed-observed=   0 distrust=no
frozen lastmod, all edited, probe off (#468) edits=2000 fetched= 295/2000 changed-observed= 295 distrust=no
frozen lastmod, all edited, probe 2%         edits=2000 fetched=1979/2000 changed-observed=1979 distrust=yes (after 1 probes)
frozen lastmod, 10% edited, probe off (#468) edits= 200 fetched= 295/2000 changed-observed=  25 distrust=no
frozen lastmod, 10% edited, probe 2%         edits= 200 fetched=1375/2000 changed-observed= 132 distrust=yes (after 7 probes)
```

- **Honest source:** 322 fetches vs 295 without the probe. That is +27, about 1.4% of the corpus. No distrust.
- **Frozen lastmod, every page edited:**
  - #468 alone sees 295/2000 edits (the revalidation-day share);
  - with the probe, the first probe catches the lie and the run sees 1,979/2,000 edits.
- **Frozen lastmod, 10% edited:** 25 → 132 of 200 edits observed in the same run. It is distrusted after 7 probes.

## Tests (`packages/connectors/src/json-ld/lastmod-skip.spec.ts`)

```
(pass) shouldSkipUnchangedLastmod > skips when the stored listing hash matches an unchanged lastmod [1.29ms]
(pass) shouldSkipUnchangedLastmod > fetches when lastmod moved since the last fetch [0.38ms]
(pass) shouldSkipUnchangedLastmod > always fetches an entry without lastmod, even with a matching hash [0.21ms]
(pass) shouldSkipUnchangedLastmod > fetches when nothing was persisted for the page yet [0.15ms]
(pass) shouldSkipUnchangedLastmod > re-fetches a page after a parser version bump [0.23ms]
(pass) shouldSkipUnchangedLastmod > keeps fetching a date-only lastmod until it has settled [0.37ms]
(pass) shouldSkipUnchangedLastmod > re-fetches every URL exactly once per revalidation window [17.25ms]
(pass) json-ld connector with lastmodSkip across two poll runs > fetches every page once, then only changed, lastmod-less and revalidation-day pages [14.35ms]
(pass) json-ld connector with lastmodSkip across two poll runs > without lastmodSkip keeps fetching every page on every run [7.18ms]
(pass) json-ld connector with lastmodSkip across two poll runs > honesty probe: a frozen lastmod over a changed page is caught, and the run stops trusting lastmod [7.82ms]
(pass) json-ld connector with lastmodSkip across two poll runs > without the probe (base #468 behaviour) a frozen lastmod hides most edits until each page's revalidation day [9.06ms]
(pass) json-ld connector with lastmodSkip across two poll runs > honest lastmod: probes match the stored payload and pages keep being skipped [5.61ms]
(pass) createLastmodSkipGuard > probes about 2% of would-be-skipped pages and distrusts lastmod for the rest of the run after a lie [12.11ms]
(pass) createLastmodSkipGuard > cannot judge a probe without a stored payload hash, and does not distrust on it [0.27ms]
 14 pass
 0 fail
```

Also `packages/db/src/bron-runtime.spec.ts` (RJC-357 test): `PostgresKnownHashStore.getPayloadHash` returns the payload tier
(`content_hash`), and `get` still returns the listing tier.
