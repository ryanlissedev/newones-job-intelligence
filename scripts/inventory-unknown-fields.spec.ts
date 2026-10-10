import { describe, expect, it } from "bun:test";

import {
  formatUnknownFieldInventory,
  UNKNOWN_FIELD_INVENTORY_SQL,
} from "./inventory-unknown-fields";

describe("inventory-unknown-fields", () => {
  it("documents the curated unknown-field SQL", () => {
    expect(UNKNOWN_FIELD_INVENTORY_SQL).toContain("curated.aanvraag");
    expect(UNKNOWN_FIELD_INVENTORY_SQL).toContain("locatie_unknown");
    expect(UNKNOWN_FIELD_INVENTORY_SQL).toContain("contract_unknown");
  });

  it("formats inventory counts for operator logs", () => {
    expect(
      formatUnknownFieldInventory({
        contractUnknown: 12,
        locatieUnknown: 34,
        remoteUnknown: 56,
        tariefUnknown: 78,
        total: 100,
      })
    ).toBe(
      "total=100 locatie_unknown=34 tarief_unknown=78 contract_unknown=12 remote_unknown=56"
    );
  });
});
