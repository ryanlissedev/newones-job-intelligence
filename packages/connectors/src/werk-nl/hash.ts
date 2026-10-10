import { hashContent } from "../object-store";
import type { WerkNlSearchItem } from "./types";

export const hashWerkNlListingItem = (
  item: WerkNlSearchItem
): Promise<string> => {
  const canonical = JSON.stringify({
    contractType: item.contractType,
    key: item.key,
    leerbaan: item.leerbaan,
    maxHours: item.maxHours,
    minHours: item.minHours,
    modified: item.modified,
    organisation: item.organisation,
    profession: item.profession,
    referenceNumber: item.referenceNumber,
    stageplaats: item.stageplaats,
    studyLevel: item.studyLevel,
    vacatureTitle: item.vacatureTitle,
    workLocationCity: item.workLocationCity,
    workLocationForeignCity: item.workLocationForeignCity,
    workLocationForeignCountry: item.workLocationForeignCountry,
    workLocationType: item.workLocationType,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashWerkNlDetailPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
