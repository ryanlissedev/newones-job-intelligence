/**
 * Applies the recorder's contact redaction to fixtures that are already
 * committed, for recordings made before redaction was a default.
 *
 * Re-recording is the better fix when it is available, because it produces a
 * fresh capture with honest provenance. It is not always available: the raw
 * response lives in a temp dir that is long gone, and a new capture returns
 * different vacancies, which moves every count a spec asserts. This tool is
 * the alternative that keeps `capturedAt`, the vacancies and the assertions
 * intact while removing the contact details.
 *
 * It reuses `redactContactsInJson` rather than restating the patterns, and
 * that function walks the parsed tree, so an HTML payload here goes through
 * the same `redactContactText` call the recorder makes and the repaired
 * payload is byte-identical to the one a fresh recording would produce.
 *
 * Running it twice is a no-op. The redactor skips what the corpus guard
 * already accepts as redacted, so a second pass counts nothing and writes
 * nothing, and the provenance sentence is appended exactly once.
 *
 * Usage:
 *   bun tools/fixtures/redact-committed.ts <fixture.json>...
 */
import { redactContactsInJson } from "./record";

const formatCounts = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}×${count}`)
    .join(", ");

const redactFixture = async (file: string): Promise<string> => {
  const fixture = JSON.parse(await Bun.file(file).text());
  // fixtures/backfill holds database rows rather than captures, and the glob
  // that reaches this tool is usually broader than its subject.
  if (!Object.hasOwn(fixture, "payload")) {
    return `${file}: skipped, no payload key`;
  }
  const { counts, value } = redactContactsInJson(fixture.payload);
  const summary = formatCounts(counts);
  if (!summary) {
    return `${file}: nothing to redact`;
  }

  const note = `Contact details redacted mechanically by tools/fixtures/redact-committed.ts using the tools/fixtures/record.ts patterns (${summary}).`;
  await Bun.write(
    file,
    `${JSON.stringify(
      {
        ...fixture,
        captureNote: fixture.captureNote
          ? `${fixture.captureNote} ${note}`
          : note,
        payload: value,
      },
      null,
      2
    )}\n`
  );
  return `${file}: ${summary}`;
};

const reportFixture = async (
  file: string
): Promise<{ readonly line: string; readonly ok: boolean }> => {
  try {
    return { line: await redactFixture(file), ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { line: `${file}: failed, ${reason}`, ok: false };
  }
};

if (import.meta.main) {
  const files = Bun.argv.slice(2);
  if (files.length === 0) {
    throw new Error("pass one or more fixture JSON paths");
  }
  // Every file reports its own outcome. A bare `Promise.all` over the batch
  // rejects on the first bad file, after other writes have already landed, and
  // prints nothing at all about which files were touched.
  const reports = await Promise.all(files.map(reportFixture));
  for (const { line } of reports) {
    console.log(line);
  }
  if (reports.some(({ ok }) => !ok)) {
    process.exitCode = 1;
  }
}

export { redactFixture };
