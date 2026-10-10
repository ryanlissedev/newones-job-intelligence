# ZZP negation labels (CTP-491)

An explicit exclusion of the freelance contract form must never produce a
`freelance` label. The classifier in
`packages/application/src/normalise/classify-contract-work.ts` now checks a
table of exclusion patterns before any positive freelance match; when the text
excludes ZZP and proves no other form, the contracttype stays unknown.

Rows curated before that fix can still carry the wrong label. This runbook
covers the report-only diagnostic that finds them, and how to correct them.

## What counts as an exclusion

The table has five rows, all matched case-insensitively against the title and
description joined together. `zzp`, `zzp'er`, `zzp'ers`, `freelance`,
`freelancer` and `freelancers` are interchangeable in every row.

Scope differs by row, and the difference matters. The text is cut into
sentences (on `.`, `!`, `?`, `;` and line breaks) and each sentence into clauses
(on commas). The three denial rows match inside one clause. The `geen` row and
the refusal row both match across a whole sentence, the first because a list
runs straight through its commas, the second because it is anchored at the
start of the sentence. That anchor is the point: a refusal that merely follows
a comma contrasts with what came before rather than refusing the vacancy.

| Shape | Matches |
| --- | --- |
| term then denial | `zzp niet mogelijk`, `zzp is niet toegestaan`, `freelance uitgesloten` |
| denial then term | `niet toegestaan voor zzp`, `niet geschikt voor een zzp'er` |
| `geen` then term or list (whole sentence) | `geen zzp`, `geen zzp mogelijk`, `geen zzp'ers gezocht`, `geen freelancers.`, `geen zzp of freelance`, `geen detachering of zzp toegestaan`, `geen zzp, geen detachering of interim toegestaan` |
| labelled answer | `zzp: nee`, `zzp mogelijkheid: nee`, `zzp toegestaan: nee` |
| not intended for (anchored at sentence start) | `niet voor zzp`, `niet bedoeld voor freelancers`, `deze opdracht staat niet open voor zzp'ers`, `helaas niet voor zzp'ers`, `let op, niet voor zzp'ers`, `deze rol is, helaas, niet voor zzp'ers`, `helaas is deze opdracht niet voor zzp'ers` |

Several shapes are deliberately left out, and three are known misses.

The `geen` row accepts a coordinated list. Any position may be any contract
form, so `geen detachering of zzp toegestaan` excludes both whichever comes
first, and the forms are exactly the aliases the classifier itself answers with
(`detachering`, `detacheren`, `deta-vast`, `interim`, `vast dienstverband`,
`vaste aanstelling`, `vast contract`, `permanent`, and the ZZP and freelance
spellings). The list may span commas and may repeat its determiner, as in
`geen zzp, geen detachering of interim toegestaan`.

Every position must BE a contract form, never an arbitrary word. That is why
`geen ervaring en freelance inzet is mogelijk` keeps its freelance label, and
why the list in `geen zzp, geen ervaring vereist` ends at the zzp.

The list must close with `of` or `en`, the way a Dutch list does. A comma-only
tail is a contrast that offers the second form rather than excluding it, so
`geen zzp, detachering mogelijk` reports `detachering`.

Everything the list matched is struck out of the evidence for that sentence, so
`geen ZZP of detachering, alleen vast dienstverband` reports `vast`, taking the
form stated outside the excluded list.

A match always strikes out the terms it names, but it only counts as a
freelance exclusion, and so only reaches this report, when a ZZP or freelance
spelling is among them. `geen detachering of interim, wel zzp` rules out those
two and leaves ZZP free to be the answer, so that row is genuinely freelance
and the report leaves it alone.

`geen zzp ervaring vereist` is a requirement, not an exclusion, so the `geen`
row only fires when the next word confirms exclusion (`mogelijk`, `toegestaan`,
`beschikbaar`, `gezocht`, `gewenst`, `welkom`, `geaccepteerd`) or the clause
ends there.

A refusal after a comma is a contrast, not an exclusion:
`reiskostenvergoeding geldt voor werknemers, niet voor zzp'ers` withholds an
allowance and keeps the freelance label. Name the vacancy as the subject to
refuse it across a comma, as in `deze opdracht is niet voor zzp'ers, wel voor
detachering`.

A denial that names a subset leaves the form open, in the denial rows as well as
the refusal row: `zzp'ers zijn niet toegestaan zonder KvK` excludes ZZP'ers
without a KvK registration, not ZZP'ers.

An abbreviation ends a sentence, because the split is punctuation-only. In
`alleen voor werknemers, d.w.z. niet voor zzp'ers` the fragment after `d.w.z.`
reads as sentence-initial and so as an exclusion, although the prose only
restates the restriction above it. Fixing that needs an abbreviation list or a
real segmenter, not a wider pattern.

`minder geschikt voor zzp'ers` (seen in Striive prose) is a warning about risk,
not a refusal, so it still classifies as freelance. Promote it only with a
product decision, not as a pattern tweak.

Two phrasings are known misses rather than decisions. `niet voor zzp'ers met
ingang van 1 januari` names a date and `niet voor zzp'ers zonder uitzondering`
strengthens the refusal, but both open with a word that usually narrows an
exclusion to a subset, so both still report freelance. Telling them apart needs
the words after that qualifier, not just its presence.

Exclusivity phrasing such as `uitsluitend detachering` needs no exclusion rule:
the named alternative already wins on its own evidence. The table never invents
a contract form that the text does not state.

## Report the mislabelled rows

Read-only. The tool issues only `SELECT`s, inside a read-only transaction on a
read-only connection; there is no write path in it.

```bash
DATABASE_URL=postgres://... bun tools/backfill/report-zzp-negation-labels.ts
DATABASE_URL=postgres://... bun tools/backfill/report-zzp-negation-labels.ts --bron=Inhuurdesk
```

`--bron` filters on `curated.bron.naam` and is case-insensitive, so
`--bron=Inhuurdesk` and `--bron=inhuurdesk` both work. The examples use the
stored spelling: `Inhuurdesk`, `Striive`, `TenderNed`, `Harvey Nash`,
`BlueTrail`, `Flinter`, `CTM`.

There is no limit flag. The scan walks the whole corpus by keyset pagination on
the primary key, 1000 rows per page, so the numbers always describe every
freelance-labelled row rather than a window.

Every page runs inside one `REPEATABLE READ` transaction, so the whole scan
sees a single snapshot. That matters because the pages are taken by cursor: on
a moving table a row inserted or relabelled by ingestion between two pages
could be counted twice or skipped entirely, depending on where its id fell
relative to the cursor. The numbers would still look plausible, which is what
makes it worth preventing rather than detecting.

Each page is folded as it arrives and then dropped, so memory holds the matched
rows and the counters, never every description in the corpus.

On failure the tool prints the error name and message alongside
`"reason": "command_failed"` and exits 1.

## Reading the numbers

```json
{
  "byBron": { "inhuurdesk": 4 },
  "candidates": [
    {
      "bron": "inhuurdesk",
      "id": "curated-aanvraag-uuid",
      "matchedPhrase": "Geen ZZP mogelijk",
      "titel": "Adviseur A",
      "versie": 3
    }
  ],
  "mislabelled": 4,
  "scanned": 120
}
```

- `scanned` is how many `contracttype = 'freelance'` rows exist, across every
  page. It is the whole labelled population, not a window.
- `mislabelled` is how many of those state an exclusion. Every one is a row the
  current classifier would leave unknown or reclassify.
- `matchedPhrase` is the exact substring that proved the exclusion. Read it
  before acting: a phrase that looks wrong means the table needs a fix, not the
  row.
- `byBron` shows which connector produced the bad labels, which is usually the
  faster lead than the row list.

The report measures; it does not shrink on its own. `mislabelled` falls only
once a write path has corrected the stored values, so a number that holds
steady across runs means the correction has not been applied yet, not that the
classifier is failing.

## Applying the correction

`tools/backfill/apply-zzp-negation-labels.ts` corrects the rows the report
finds. It is bounded the same way the RJC-394 repair lane is: an explicit
reviewed manifest, a quiescence acknowledgement, a re-read under a row lock,
one audit event and one `aanvraag.gewijzigd` outbox event per changed row, and
a rollback keyed on the audit event it wrote.

Re-ingestion is not an alternative. It cannot clear a stored `freelance`, on
either curation path. When the content hash is unchanged,
`buildUnchangedContentPatch` writes `contracttype` only behind
`if (existing.contracttype === null)`, so a stored value is left alone. When the
content has changed, the new value goes through
`coalesceNullable(incoming, existing)`, which is `incoming ?? existing`: the
classifier returning null for an excluded vacancy is exactly the case where the
old `freelance` coalesces straight back. Both are in
`packages/application/src/identity/curate.ts`.

### Approve a manifest

The tool reads the report tool's own output. Run the report, delete the
candidates that should not be corrected, and pass the rest back in. The summary
keys are ignored, so the file needs no reshaping.

Every candidate is a binding, not an instruction: the row must still be
labelled `freelance`, still be at the `versie` the manifest records, and its
CURRENT text must still refuse freelance work. A row that fails any of those is
rejected with a reason code and never patched. At most 100 candidates per run.

### Dry run

Default mode. One `REPEATABLE READ` read-only snapshot, no locks, no writes.

```bash
DATABASE_URL=postgres://... bun tools/backfill/apply-zzp-negation-labels.ts \
  --manifest approved.json --limit 34
```

`--limit` is required and must be at least the manifest size. It exists so an
oversized manifest fails before any database work rather than after it.

### Apply

```bash
DATABASE_URL=postgres://... bun tools/backfill/apply-zzp-negation-labels.ts \
  --manifest approved.json --limit 34 --apply --ingest-quiesced
```

`--ingest-quiesced` is your acknowledgement that ingestion is stopped. The tool
does not verify it; it refuses to write without it. Quiesce ingestion first,
because a concurrent recurate and this correction both write `contracttype`.

Each row is corrected in its own short transaction, under `FOR UPDATE`, with
statement, lock and idle-in-transaction timeouts set locally. The whole decision
is retaken inside that transaction: the manifest is an approval, not evidence.

The same transaction also clears the fallback. `readAanvraagBronFacts` lets
`bron_specifiek.contracttype` and `bron_specifiek.contract_type` stand in for
the promoted column whenever it is null, in both the API record and the search
document (`packages/db/src/aanvraag-stores.ts`). Clearing only the column would
therefore leave those rows reading as freelance to users the moment the outbox
event reprojects them, while the report no longer finds them. Confirmed live: 4
of the 34 rows carry `bron_specifiek->>'contracttype' = 'freelance'`.

Only an alias that would still read as freelance is removed. An alias naming a
different contract form is left alone, because this lane has evidence against
freelance and none against detachering. The audit event records every removed
key with the value it held, so the rollback puts back exactly what was there.

Re-running the same manifest is a no-op. The audit event is looked up before the
row is judged, so a row this run already corrected reports `unchanged` with the
original audit id rather than being rejected for no longer being `freelance`.

### Rollback

Keyed on the audit event, one event at a time, the same shape the RJC-394 lane
uses.

```bash
DATABASE_URL=postgres://... bun tools/backfill/apply-zzp-negation-labels.ts \
  --rollback --audit-id <audit-event-uuid> --ingest-quiesced
```

The audit event carries the previous value, so the rollback restores it exactly:
the promoted column and every `bron_specifiek` alias key the apply removed, with
the values they held. Other keys in `bron_specifiek` are never touched, in
either direction.

It refuses if the row is gone, if its content hash has changed, if the label is
no longer what this tool left there, if an alias key removed by the apply has
reappeared in `bron_specifiek` (including with a null or non-string value), or
if the audit event belongs to another scope, because in each case the row is
not this lane's to restore. Unrelated `bron_specifiek` keys remain untouched
when a rollback is safe. Rolling back twice is a no-op.

After a rollback the row is mislabelled again, and re-running the same manifest
corrects it once more rather than reporting `unchanged`. The idempotency lookup
ignores an apply audit that a later rollback reversed.

### Reading the output

Counts, row ids, reason codes and the audit and outbox ids. No vacancy text, no
opdrachtgever, no URL, and any connection string in an error message is redacted
before printing, so the output is safe to paste into a ticket.

Reason codes:

| Code | Meaning |
| --- | --- |
| `current_row_missing` | the row is gone, or its id is not the approved one |
| `contracttype_not_freelance` | the label is no longer the one this lane corrects |
| `versie_mismatch` | the row moved on after the report was taken |
| `text_no_longer_excludes` | the current text no longer refuses freelance work |
| `classifier_still_freelance` | the classifier still answers freelance, so there is nothing to correct |
| `transaction_failed` | the row was not changed; safe to re-run |

The audit event stores the matched phrase capped at 200 characters, with
`matchedPhraseTruncated` recording when it had to cut. The manifest itself
accepts whatever the report emitted: a coordinated list can legitimately run
past that cap, and the manifest must never reject the report that produced it.

A rejected row is a row left alone. Re-run the report to get a fresh manifest
rather than editing the old one.

### On the box

The tool builds to a single file, so it can be shipped without the repository:

```bash
bun build --target=bun tools/backfill/apply-zzp-negation-labels.ts \
  --outfile=apply-zzp-negation-labels.js
```

Do not hand-edit `curated.aanvraag` rows. The search projection and the audit
trail both derive from the curated write path, and a direct update leaves them
inconsistent.
