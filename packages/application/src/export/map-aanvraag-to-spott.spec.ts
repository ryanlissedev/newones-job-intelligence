import { describe, expect, it } from "bun:test";

import type { AanvraagRecord } from "../registry/stores/types";
import { mapAanvraagToSpottCreateRequest } from "./map-aanvraag-to-spott";

const baseAanvraag: AanvraagRecord = {
  beschrijving: "Spec beschrijving",
  bronId: "00000000-0000-4000-8000-000000000001",
  bronReferentie: "SPEC-1",
  id: "00000000-0000-4000-8000-0000000000aa",
  rawPayloadRef: "raw/spec.json",
  scrapeRunId: "00000000-0000-4000-8000-000000000020",
  status: "active",
  titel: "Spec titel",
  versies: [],
};

describe("mapAanvraagToSpottCreateRequest -- contactpersonen (CTP-610)", () => {
  it("appends the source-published contactpersonen to the vacancy description", () => {
    const request = mapAanvraagToSpottCreateRequest({
      ...baseAanvraag,
      contactpersonen: [
        {
          email: "redacted@example.invalid",
          geinformeerdOp: null,
          naam: "A. de Vries",
          notificatieKanaal: null,
          rol: "recruiter",
          telefoon: "+31000000000",
        },
        {
          email: null,
          geinformeerdOp: null,
          naam: "B. Jansen",
          notificatieKanaal: null,
          rol: null,
          telefoon: null,
        },
      ],
    });

    expect(request.description).toBe(
      "Spec beschrijving\n\nContactpersonen bij bron:\n" +
        "- A. de Vries — (recruiter) — redacted@example.invalid — +31000000000\n" +
        "- B. Jansen"
    );
  });

  it("leaves the description untouched without contactpersonen", () => {
    const request = mapAanvraagToSpottCreateRequest(baseAanvraag);
    expect(request.description).toBe("Spec beschrijving");
  });
});
