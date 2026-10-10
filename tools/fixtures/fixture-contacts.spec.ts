import { describe, expect, it } from "bun:test";
import path from "node:path";

import { CONTACT_REDACTIONS, isRedactedContact } from "./record";

/**
 * AGENTS.md, "Adding a source": "Remove PII rather than replacing it with
 * plausible fake names." The repository is public, so a recruiter's work
 * address committed in a fixture is published a second time, in a context
 * the person never chose.
 *
 * `check-secrets` scans for credentials and says nothing about personal data,
 * and `fixtures-provenance.spec.ts` only vouches for capture time, so before
 * this guard nothing enforced the rule. It had already been missed twice.
 *
 * Both the patterns and the rule for what counts as already redacted come
 * from the recorder itself, so a fixture recorded by `tools/fixtures/record.ts`
 * passes here by construction and the two can never drift apart.
 */

const FIXTURES_ROOT = path.resolve(import.meta.dir, "../../fixtures");

const findContacts = (
  text: string
): { readonly label: string; readonly match: string }[] => {
  const found: { label: string; match: string }[] = [];
  for (const { label, pattern } of CONTACT_REDACTIONS) {
    for (const [match] of text.matchAll(pattern)) {
      if (!isRedactedContact(label, match)) {
        found.push({ label, match });
      }
    }
  }
  return found;
};

/**
 * The unredacted samples below are synthetic, and must stay synthetic. A spec
 * in a public repository that carried a real address would publish that person
 * a second time, which is the thing this guard exists to prevent. `.internal`
 * is reserved by ICANN for private use and can never be delegated in the
 * public DNS, and `0999` is not an area code in the Dutch numbering plan, so
 * neither can reach anyone. Neither is in the allow list either, so they are
 * flagged through exactly the same branch a real address and number take.
 */
const UNREDACTED_EMAIL = "v.voorbeeld@geen-echt-domein.internal";
const UNREDACTED_PHONE = "0999-000000";

describe("fixture contact redaction", () => {
  it("flags an unredacted address and Dutch number, and passes the redacted forms", () => {
    expect(
      findContacts(
        `Bel de vacaturelijn via ${UNREDACTED_PHONE} of ${UNREDACTED_EMAIL}.`
      )
    ).toEqual([
      { label: "email", match: UNREDACTED_EMAIL },
      { label: "phone", match: UNREDACTED_PHONE },
    ]);
    expect(
      findContacts("Bel via +31000000000 of redacted@example.invalid.")
    ).toEqual([]);
  });

  it("leaves decimals alone", () => {
    // A dot is not a Dutch phone separator. Admitting one matched 253
    // Striive listing scores such as `05.185353`.
    expect(findContacts("score 05.185353 en 01.430431")).toEqual([]);
  });

  it("has no unredacted contact detail in any committed fixture", async () => {
    const filePaths: string[] = [];
    for await (const filePath of new Bun.Glob("**/*.json").scan({
      absolute: true,
      cwd: FIXTURES_ROOT,
    })) {
      filePaths.push(filePath);
    }
    const scanned = await Promise.all(
      filePaths.map(async (filePath) => {
        const found = findContacts(await Bun.file(filePath).text());
        if (found.length === 0) {
          return null;
        }
        const relative = path.relative(FIXTURES_ROOT, filePath);
        return `${relative}: ${found.map(({ label, match }) => `${label} ${match}`).join(", ")}`;
      })
    );
    const offenders = scanned.filter((offender) => offender !== null);

    expect(offenders, offenders.join("\n")).toEqual([]);
  }, 30_000);
});
