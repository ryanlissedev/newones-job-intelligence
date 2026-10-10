/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This is the TenderNed JSON I/O boundary: live responses carry numeric `kenmerk` / `publicatieId` despite the declared string types, so the string contract is established here. */
import type { TenderNedListingItem } from "./types";

export const asIdString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  return "";
};

export const coerceTenderNedIds = <Item extends TenderNedListingItem>(
  item: Item
): Item => ({
  ...item,
  kenmerk: asIdString(item.kenmerk),
  publicatieId: asIdString(item.publicatieId),
});
