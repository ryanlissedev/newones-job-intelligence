/**
 * Shared contracttype / werkvorm classifier for Dutch inhuur prose.
 * Negation-aware: an explicit ZZP or freelance exclusion wins over a bare
 * zzp/freelance match. If no other contract form is stated, an exclusion
 * remains unknown.
 * Emits only literals accepted by the web mapContractType allowlist.
 */

export type ClassifiedContractType =
  | "detachering"
  | "freelance"
  | "interim"
  | "vast";

export type ClassifiedWorkArrangement = "Hybride" | "Op locatie" | "Remote";

export interface ClassifiedContractWork {
  readonly contracttype: ClassifiedContractType | null;
  readonly werkvorm: ClassifiedWorkArrangement | null;
}

/**
 * Every wording the source prose uses for the freelance contract form,
 * including the plural and possessive spellings ("freelancers", "zzp'ers").
 * Shared by the positive matcher and the exclusion table, so a phrasing added
 * here is recognised as evidence and in every negation shape at once, and a
 * plural can never be excluded on one side yet missed on the other (CTP-502).
 */
const FREELANCE_TERM = String.raw`(?:zzp(?:['’]ers?)?|freelance(?:rs?)?)`;
const DENIAL = String.raw`(?:niet\s+(?:toegestaan|mogelijk|geschikt|gewenst|welkom|geaccepteerd)|uitgesloten)`;
/** The copula that may sit between a contract term and what is said about it. */
const COPULA = String.raw`(?:is|zijn|wordt|worden)`;
/**
 * Subjects that make "... is niet voor zzp" an exclusion of the contract form
 * rather than of some benefit. "Reiskostenvergoeding is niet voor zzp'ers"
 * withholds an allowance; it does not close the vacancy to freelancers.
 */
const VACANCY_NOUN = String.raw`(?:(?:deze|dit|de|het)\s+)?(?:opdracht|functie|rol|vacature|aanvraag|positie|inzet)`;
const VACANCY_VERB = String.raw`(?:is|zijn|staat|staan)`;
// Both orders: "deze opdracht is niet ..." and, after a lead-in, the inversion
// Dutch uses there, "helaas is deze opdracht niet ...".
const VACANCY_SUBJECT = String.raw`(?:${VACANCY_NOUN}\s+${VACANCY_VERB}|${VACANCY_VERB}\s+${VACANCY_NOUN})\s*,?\s*`;
/**
 * Qualifiers that narrow an exclusion to a subset, so it is not a refusal.
 * The guard scans past any remaining term suffix, because FREELANCE_TERM can
 * backtrack to a shorter spelling ("zzp" out of "zzp'ers") and step over it.
 *
 * Known ceiling: the guard is word-level, so two idioms that begin with a
 * qualifier but do not narrow anything read as freelance today --
 * "niet voor zzp'ers met ingang van 1 januari" (a date, not a subset) and
 * "niet voor zzp'ers zonder uitzondering" (which strengthens the refusal).
 * Separating those from a real subset needs the words after the qualifier,
 * not just its presence. Left as is until the prose justifies the rule.
 */
const EXCLUSION_QUALIFIER = String.raw`(?:zonder|met|die|welke)`;
/**
 * Adverbs that soften a refusal without changing it. They sit either in front
 * of the whole sentence ("Helaas niet voor zzp'ers") or between the vacancy
 * subject and the refusal ("Deze opdracht is helaas niet voor zzp'ers").
 */
const REFUSAL_LEAD_IN = String.raw`(?:helaas|jammer\s+genoeg|let\s+op[:,]?)`;
/**
 * The wordings each positive matcher accepts. Declared here as sources rather
 * than inside the matchers, so the coordinated group below is built from the
 * same strings the classifier answers with and the two cannot drift apart.
 */
const DETACHERING_TERM = String.raw`detachering|detacheren|deta-?vast`;
const FREELANCE_MATCH_TERM = String.raw`${FREELANCE_TERM}|marktplaats\s*\(freelance\)`;
const VAST_TERM = String.raw`vast\s+dienstverband|vaste\s+aanstelling|vast\s+contract|permanent`;
const INTERIM_TERM = String.raw`interim`;

/**
 * Any contract form that can appear in a "geen ..." list, in any position.
 * FREELANCE_TERM is used directly rather than FREELANCE_MATCH_TERM because the
 * "marktplaats (freelance)" alias never appears inside a "geen ..." list.
 */
const COORDINATED_TERM = String.raw`(?:${FREELANCE_TERM}|${DETACHERING_TERM}|${VAST_TERM}|${INTERIM_TERM})`;
/** Words that confirm "geen <freelance term>" is an exclusion of the form. */
const EXCLUSION_TAIL = String.raw`(?:mogelijk|toegestaan|beschikbaar|gezocht|gewenst|welkom|geaccepteerd)`;

/**
 * Explicit exclusions of the freelance contract form, one row per sentence
 * shape. Order does not matter: a hit in any row means the text excludes
 * freelance work, so a positive freelance match must never win.
 */
const FREELANCE_EXCLUSIONS: readonly RegExp[] = [
  // "zzp niet mogelijk", "zzp is niet toegestaan", "zzp: uitgesloten".
  // The qualifier guard is the same one row 5 carries: "zzp'ers zijn niet
  // toegestaan zonder KvK" excludes a subset, so the form stays open.
  new RegExp(
    String.raw`\b${FREELANCE_TERM}\b\s*(?::\s*)?(?:${COPULA}\s+)?${DENIAL}\b(?!['’\w]*\s+${EXCLUSION_QUALIFIER}\b)`,
    "iu"
  ),
  // "niet toegestaan voor zzp", "uitgesloten: freelance"
  new RegExp(
    String.raw`\b${DENIAL}\b(?:\s*:)?\s*(?:(?:voor|als)\s+)?(?:een\s+)?\b${FREELANCE_TERM}\b(?!['’\w]*\s+${EXCLUSION_QUALIFIER}\b)`,
    "iu"
  ),
  // "zzp mogelijkheid: nee", "freelance: nee"
  new RegExp(
    String.raw`\b${FREELANCE_TERM}\b\s*(?:(?:mogelijk(?:heid)?|toegestaan)\s*)?:\s*nee(?:n)?\b`,
    "iu"
  ),
];

/**
 * "geen zzp", "geen zzp mogelijk", "geen zzp'ers gezocht", "geen freelancers.",
 * and coordinated lists that may name other contract forms and may span commas
 * ("geen zzp, detachering of interim toegestaan"). Matched against the whole
 * sentence rather than a clause, because a list runs straight through its
 * commas, and every term inside the match is excluded by it.
 *
 * Every position is any contract form, so "geen detachering of zzp" excludes
 * both whichever comes first. Every term must be a contract form though, never
 * an arbitrary word, or "geen ervaring en freelance inzet is mogelijk" would
 * lose its answer.
 *
 * A match always masks the terms it covers, but it only counts as a FREELANCE
 * exclusion when a freelance term is among them: "geen detachering of interim"
 * rules out those two and leaves ZZP free to be the answer.
 *
 * A list must close with "of" or "en", the way Dutch lists do. A comma-only
 * tail is a contrast rather than a continuation: "geen zzp, detachering
 * mogelijk" offers detachering, it does not exclude it.
 *
 * The determiner may be repeated per item ("geen zzp, geen detachering of
 * interim"), which keeps such a sentence one match, so the report names the
 * whole list rather than only its first item.
 *
 * The trailing word may carry a copula ("geen zzp of detachering is mogelijk"),
 * but is otherwise constrained so "geen zzp ervaring vereist" -- a requirement,
 * not an exclusion -- stays out.
 */
const EXCLUDED_TERM_LIST = new RegExp(
  String.raw`\bgeen\s+${COORDINATED_TERM}(?:(?:\s*,\s*(?:geen\s+)?${COORDINATED_TERM})*\s+(?:of|en)\s+(?:geen\s+)?${COORDINATED_TERM})?\b(?:\s+(?:${COPULA}\s+)?${EXCLUSION_TAIL}|(?=\s*(?:[,:]|$)))`,
  "giu"
);

/**
 * "niet voor zzp", "niet bedoeld voor freelancers", "deze opdracht is helaas
 * niet voor zzp'ers". Matched against the whole sentence and anchored at its
 * start, so a lead-in may carry its own comma ("Let op, niet voor zzp'ers")
 * while a refusal that only follows one is still excluded: in
 * "Reiskostenvergoeding geldt voor werknemers, niet voor zzp'ers" the sentence
 * opens with the allowance, so the anchor never reaches the refusal and the
 * freelance label stands.
 *
 * A trailing qualifier ("niet voor zzp'ers zonder KvK") narrows the exclusion
 * to a subset, so it is not a refusal either.
 */
const SENTENCE_INITIAL_REFUSAL = new RegExp(
  String.raw`^\s*(?:${REFUSAL_LEAD_IN},?\s+)?(?:${VACANCY_SUBJECT})?(?:${REFUSAL_LEAD_IN},?\s+)?niet\s+(?:bedoeld\s+|bestemd\s+|beschikbaar\s+|open\s+)?(?:voor|als)\s+(?:een\s+)?${FREELANCE_TERM}\b(?!['’\w]*\s+${EXCLUSION_QUALIFIER}\b)`,
  "iu"
);

// "inhuur" is the domain umbrella for every commercial form — never map it
// alone to detachering. "interim" has its own branch below.
const DETACHERING = new RegExp(
  String.raw`\b(?<kind>${DETACHERING_TERM})\b`,
  "iu"
);
const FREELANCE = new RegExp(
  String.raw`\b(?<kind>${FREELANCE_MATCH_TERM})\b`,
  "iu"
);
const VAST = new RegExp(String.raw`\b(?<kind>${VAST_TERM})\b`, "iu");
const INTERIM = new RegExp(String.raw`\b(?<kind>${INTERIM_TERM})\b`, "iu");

const REMOTE = /\b(?<kind>remote|thuiswerk(?:en)?|telecommute|vanuit huis)\b/iu;
const HYBRID = /\b(?<kind>hybride|hybrid)\b/iu;
const ONSITE = /\b(?<kind>op locatie|op kantoor|fysiek op kantoor|onsite)\b/iu;

// Sentences bound a refusal; clauses bound a denial inside one. Splitting in
// two steps keeps the distinction the old single split threw away: a refusal
// anchored at the start of a sentence can close the vacancy, one that merely
// follows a comma cannot.
//
// Known ceiling: the split is punctuation-only, so an abbreviation ends a
// sentence. In "alleen voor werknemers, d.w.z. niet voor zzp'ers" the "d.w.z."
// starts a new sentence whose first words are the refusal, which reads as an
// exclusion although the prose only restates the restriction above it.
// Fixing it needs an abbreviation list or a real segmenter, not a wider regex.
const CONTRACT_SENTENCE_SEPARATOR = /[.!?;\n]+/u;
const CONTRACT_CLAUSE_SEPARATOR = /,/u;
// These two suppress a positive match for ANY contract term, not just the
// freelance ones, so they cannot be folded into FREELANCE_EXCLUSIONS. They do
// share the denial vocabulary, so both are built from DENIAL: extending that
// one constant now reaches the exclusion table and the generic suppressor
// together, which is what let "niet gewenst" slip through before.
const CONTRACT_NEGATION_BEFORE = new RegExp(
  // No "geen X of" alternative here: carrying "geen" across a coordination by
  // word shape suppressed unrelated prose ("geen budget en detachering is
  // mogelijk"). EXCLUDED_TERM_LIST does that job precisely instead, by masking
  // the terms it actually matched.
  String.raw`\b(?:geen|${DENIAL})\b(?:\s+(?:voor|als))?\s*$`,
  "iu"
);
const CONTRACT_NEGATION_AFTER = new RegExp(
  String.raw`^\s*(?::\s*|(?:mogelijk(?:heid)?)\s*:\s*)?(?:${COPULA}\s+)?(?:nee(?:n)?|${DENIAL})\b`,
  "iu"
);

const splitContractSentences = (text: string): string[] =>
  text.split(CONTRACT_SENTENCE_SEPARATOR);

const splitContractClauses = (sentence: string): string[] =>
  sentence.split(CONTRACT_CLAUSE_SEPARATOR);

/**
 * Blanks out every "geen ..." list in a sentence, preserving offsets so the
 * surrounding context still reads correctly. A term inside such a list is
 * excluded by it and must not count as positive evidence anywhere in the
 * sentence, however many commas the list crosses.
 */
const maskExcludedTermLists = (sentence: string): string =>
  sentence.replace(EXCLUDED_TERM_LIST, (match) => " ".repeat(match.length));

const hasPositiveContractTerm = (
  clauses: string[],
  pattern: RegExp
): boolean => {
  const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const clause of clauses) {
    for (const match of clause.matchAll(globalPattern)) {
      const index = match.index ?? 0;
      const before = clause.slice(Math.max(0, index - 40), index);
      const after = clause.slice(index + match[0].length);
      if (
        !CONTRACT_NEGATION_BEFORE.test(before) &&
        !CONTRACT_NEGATION_AFTER.test(after)
      ) {
        return true;
      }
    }
  }
  return false;
};

const NAMES_FREELANCE_TERM = new RegExp(
  String.raw`\b${FREELANCE_TERM}\b`,
  "iu"
);

const matchSentenceExclusion = (sentence: string): string | null => {
  EXCLUDED_TERM_LIST.lastIndex = 0;
  for (const listMatch of sentence.matchAll(EXCLUDED_TERM_LIST)) {
    if (NAMES_FREELANCE_TERM.test(listMatch[0])) {
      return listMatch[0].trim();
    }
  }
  const refusal = SENTENCE_INITIAL_REFUSAL.exec(sentence);
  if (refusal) {
    return refusal[0].trim();
  }
  for (const clause of splitContractClauses(sentence)) {
    for (const pattern of FREELANCE_EXCLUSIONS) {
      const match = pattern.exec(clause);
      if (match) {
        return match[0].trim();
      }
    }
  }
  return null;
};

/**
 * The phrase that excludes freelance work, or null when the text states no
 * such exclusion. A denial is matched inside one clause and a refusal only at
 * the start of a sentence, so neither reaches across a boundary it does not
 * own. The report-only backfill tool reuses this to name the phrase behind
 * every mislabelled row.
 */
export const matchFreelanceExclusion = (text: string): string | null => {
  for (const sentence of splitContractSentences(text)) {
    const match = matchSentenceExclusion(sentence);
    if (match !== null) {
      return match;
    }
  }
  return null;
};

const classifyContracttype = (text: string): ClassifiedContractType | null => {
  const clauses = splitContractSentences(text).flatMap((sentence) =>
    splitContractClauses(maskExcludedTermLists(sentence))
  );
  const zzpIsNegated = matchFreelanceExclusion(text) !== null;
  const hasPositiveDetachering = hasPositiveContractTerm(clauses, DETACHERING);
  const hasPositiveVast = hasPositiveContractTerm(clauses, VAST);
  const hasPositiveInterim = hasPositiveContractTerm(clauses, INTERIM);
  const hasPositiveFreelance = hasPositiveContractTerm(clauses, FREELANCE);
  if (zzpIsNegated) {
    if (hasPositiveDetachering) {
      return "detachering";
    }
    if (hasPositiveVast) {
      return "vast";
    }
    if (hasPositiveInterim) {
      return "interim";
    }
    return null;
  }
  if (hasPositiveVast && !hasPositiveDetachering && !hasPositiveFreelance) {
    return "vast";
  }
  if (hasPositiveFreelance && !hasPositiveDetachering && !hasPositiveInterim) {
    return "freelance";
  }
  if (hasPositiveInterim && !hasPositiveDetachering) {
    return "interim";
  }
  if (hasPositiveDetachering) {
    return "detachering";
  }
  return null;
};

const classifyWerkvorm = (text: string): ClassifiedWorkArrangement | null => {
  if (HYBRID.test(text)) {
    return "Hybride";
  }
  if (REMOTE.test(text)) {
    return "Remote";
  }
  if (ONSITE.test(text)) {
    return "Op locatie";
  }
  return null;
};

export const classifyContractAndWork = (
  title: string,
  description: string
): ClassifiedContractWork => {
  const text = `${title}\n${description}`;
  return {
    contracttype: classifyContracttype(text),
    werkvorm: classifyWerkvorm(text),
  };
};
