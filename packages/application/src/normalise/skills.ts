/**
 * Canonical shaping for `bronSpecifiek.skills` (CTP-514, F15).
 *
 * Normalisers emit skills as a plain `string[]` taken from structured source
 * data (tag lists, "eisen"/"competenties" arrays). This helper is the single
 * place that shapes that list, so the write side and the read side can never
 * disagree about what a skill list looks like. It only ever removes or trims —
 * it never invents a skill the source did not publish.
 */

const MAX_SKILL_LENGTH = 80;
const MAX_SKILLS = 40;

/**
 * Shapes an unknown `skills` value into the contract list: trimmed, non-empty,
 * at most {@link MAX_SKILL_LENGTH} characters, deduped case-insensitively with
 * source order preserved, capped at {@link MAX_SKILLS} entries. Anything that
 * is not an array of strings yields an empty list.
 */
export const normaliseSkills = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON I/O boundary: bronSpecifiek is untyped until this guard runs
  input?: unknown
): string[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const entry of input) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON array entries are unknown; string is the only shape we accept
    if (typeof entry !== "string") {
      continue;
    }
    const skill = entry.trim();
    if (skill === "" || skill.length > MAX_SKILL_LENGTH) {
      continue;
    }
    const key = skill.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    skills.push(skill);
    if (skills.length === MAX_SKILLS) {
      break;
    }
  }
  return skills;
};
