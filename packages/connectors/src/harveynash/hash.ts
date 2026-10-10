import { hashContent } from "../object-store";
import type { HarveyNashSearchItem } from "./types";

export const hashHarveyNashListingItem = (
  item: HarveyNashSearchItem
): Promise<string> => {
  const canonical = JSON.stringify({
    external_reference: item.external_reference ?? null,
    id: item.id,
    salary_package: item.salary_package ?? null,
    title: item.title,
    updated_at: item.updated_at ?? null,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashHarveyNashPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
