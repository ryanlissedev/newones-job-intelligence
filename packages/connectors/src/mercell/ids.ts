/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This is the Mercell s2c JSON I/O boundary: live responses may carry string `TenderId` despite the declared numeric type, so the string contract is established here. */

export const asMercellIdString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
};
