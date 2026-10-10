import { describe, expect, it } from "bun:test";

import onefellowFixture from "../../../../fixtures/connectors/onefellow/listing-page-0.json";
import {
  classifyContractAndWork,
  matchFreelanceExclusion,
} from "./classify-contract-work";
import type { ClassifiedContractType } from "./classify-contract-work";
import { parseOnefellowPayload } from "./onefellow";

describe("classifyContractAndWork", () => {
  it("uses an explicit detachering alternative after ZZP negation", () => {
    expect(
      classifyContractAndWork(
        "Senior developer",
        "ZZP is NIET toegestaan. Alleen detachering."
      ).contracttype
    ).toBe("detachering");
  });

  it("leaves an excluded ZZP contract unknown without an alternative", () => {
    expect(
      classifyContractAndWork("Adviseur A", "Geen ZZP mogelijk.").contracttype
    ).toBeNull();
    expect(
      classifyContractAndWork("Opdracht", "ZZP is niet mogelijk.").contracttype
    ).toBeNull();
  });

  it("recognizes labelled ZZP exclusions", () => {
    expect(
      classifyContractAndWork("Opdracht", "ZZP mogelijkheid: Nee.").contracttype
    ).toBeNull();
    expect(
      classifyContractAndWork("Opdracht", "ZZP: Nee.").contracttype
    ).toBeNull();
    expect(
      classifyContractAndWork(
        "Opdracht",
        "ZZP mogelijkheid: Nee, alleen op basis van detachering."
      ).contracttype
    ).toBe("detachering");
  });

  it("replays excluded contracts from the recorded Onefellow listing", () => {
    for (const id of [944, 1006]) {
      const job = onefellowFixture.payload.jobs.find(
        (item) => item.joborder_id === id
      );
      if (!job) {
        throw new Error(`Missing recorded Onefellow job ${id}`);
      }
      const draft = parseOnefellowPayload({ job }, "fixture-hash");
      expect(
        classifyContractAndWork(job.title, draft.beschrijving.value)
          .contracttype
      ).toBeNull();
    }
  });

  it("recognizes exclusions recorded in Onefellow source prose", () => {
    for (const description of [
      "Deze functie is niet geschikt voor een zzp'er",
      "Inzet als zzp’er: niet toegestaan",
      "ZZP toegestaan: Nee",
    ]) {
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("does not let an excluded ZZP mention become freelance", () => {
    expect(
      classifyContractAndWork(
        "Adviseur A",
        "Geen ZZP mogelijk. Freelance inzet is niet toegestaan."
      ).contracttype
    ).toBeNull();
  });

  it("does not use a negated alternative as positive evidence", () => {
    expect(
      classifyContractAndWork(
        "Opdracht",
        "ZZP: Nee. Vast dienstverband niet mogelijk."
      ).contracttype
    ).toBeNull();
    expect(
      classifyContractAndWork("Opdracht", "ZZP: Nee. Interim niet toegestaan.")
        .contracttype
    ).toBeNull();
    expect(
      classifyContractAndWork("Opdracht", "ZZP: Nee. Detachering uitgesloten.")
        .contracttype
    ).toBeNull();
  });

  it("keeps positive ZZP evidence when another term is negated", () => {
    expect(
      classifyContractAndWork(
        "Opdracht",
        "Niet geschikt voor interim, maar ZZP mogelijk."
      ).contracttype
    ).toBe("freelance");
  });

  it("does not mistake another labelled answer for ZZP exclusion", () => {
    expect(
      classifyContractAndWork(
        "Opdracht",
        "ZZP ervaring: Nee. Freelance mogelijk."
      ).contracttype
    ).toBe("freelance");
    expect(
      classifyContractAndWork("Opdracht", "ZZP : Nee.").contracttype
    ).toBeNull();
  });

  it("does not treat unrelated ZZP context as an exclusion", () => {
    expect(
      classifyContractAndWork(
        "Freelance adviseur",
        "Geen ervaring met ZZP vereist; freelance inzet is mogelijk."
      ).contracttype
    ).toBe("freelance");
  });

  it("classifies freelance when zzp is allowed", () => {
    expect(
      classifyContractAndWork("Opdracht", "Geschikt voor zzp'ers.").contracttype
    ).toBe("freelance");
  });

  it("classifies bare interim as interim, not detachering", () => {
    expect(
      classifyContractAndWork("Rol", "Interim professional gezocht.")
        .contracttype
    ).toBe("interim");
  });

  it("does not treat generic inhuur prose as detachering", () => {
    expect(
      classifyContractAndWork(
        "Analyst",
        "Wij zoeken versterking via inhuur voor dit project."
      ).contracttype
    ).toBeNull();
  });

  it("still classifies explicit detachering", () => {
    expect(
      classifyContractAndWork("Rol", "Via detachering beschikbaar.")
        .contracttype
    ).toBe("detachering");
  });

  it("classifies hybride and remote werkvormen", () => {
    expect(
      classifyContractAndWork("Rol", "Hybride: Ja met een vaste dag.").werkvorm
    ).toBe("Hybride");
    expect(
      classifyContractAndWork("Rol", "Remote werken is ook mogelijk.").werkvorm
    ).toBe("Remote");
  });
});

describe("CTP-491 freelance exclusions", () => {
  const excluded = [
    "Geen ZZP mogelijk.",
    "Geen ZZP.",
    "Geen ZZP'ers.",
    "Geen zzp\u2019ers gezocht.",
    "ZZP niet mogelijk.",
    "ZZP is niet mogelijk.",
    "ZZP niet toegestaan.",
    "Geen freelance.",
    "Geen freelancers.",
    "Freelance niet mogelijk.",
    "Freelance is niet toegestaan.",
    "Niet voor ZZP.",
    "Niet voor zzp'ers.",
    "Niet bedoeld voor freelancers.",
  ];

  it("never labels an excluded vacancy freelance", () => {
    for (const description of excluded) {
      expect(
        classifyContractAndWork("Adviseur A", description).contracttype
      ).toBeNull();
    }
  });

  it("names the phrase behind every exclusion", () => {
    for (const description of excluded) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
    }
  });

  it("keeps the proven alternative after an exclusion", () => {
    expect(
      classifyContractAndWork(
        "Adviseur A",
        "Geen ZZP mogelijk. Uitsluitend detachering."
      ).contracttype
    ).toBe("detachering");
    expect(
      classifyContractAndWork("Adviseur A", "Niet voor ZZP, wel detachering.")
        .contracttype
    ).toBe("detachering");
  });

  it("invents no contract form for a bare exclusion", () => {
    expect(matchFreelanceExclusion("Uitsluitend detachering.")).toBeNull();
    expect(
      classifyContractAndWork("Adviseur A", "Uitsluitend detachering.")
        .contracttype
    ).toBe("detachering");
  });

  it("keeps the positive controls classifying as before", () => {
    expect(
      classifyContractAndWork("Adviseur A", "ZZP mogelijk.").contracttype
    ).toBe("freelance");
    expect(
      classifyContractAndWork("Adviseur A", "Freelance of detachering.")
        .contracttype
    ).toBe("detachering");
    expect(
      classifyContractAndWork("Adviseur A", "Geschikt voor zzp'ers.")
        .contracttype
    ).toBe("freelance");
    for (const description of ["ZZP mogelijk.", "Geschikt voor zzp'ers."]) {
      expect(matchFreelanceExclusion(description)).toBeNull();
    }
  });

  it("replays the exclusions recorded in the connector fixtures", () => {
    const recorded: readonly [string, ClassifiedContractType | null][] = [
      ["Inzet als zzp\u2019er: niet toegestaan", null],
      ["Deze functie is niet geschikt voor een zzp'er", null],
      ["ZZP mogelijk:  Nee alleen op basis van detachering", "detachering"],
      ["Uren: 36 per week ZZP: Nee  Locatie: Arnhem", null],
      ["ZZP mogelijkheid: Nee Tarief: tussen 95,00 en 109,00", null],
      ["FIN (Belastingdienst) / ZZP is NIET toegestaan", null],
    ];
    for (const [description, expected] of recorded) {
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBe(expected);
    }
  });

  it("keeps a benefit qualification classified as freelance", () => {
    // "niet voor zzp" mid-clause withholds an allowance; it does not close
    // the vacancy. Only a clause-initial refusal is an exclusion.
    for (const description of [
      "Reiskostenvergoeding geldt niet voor zzp'ers",
      "De reiskostenvergoeding is niet voor zzp'ers",
      "Het bonusbudget is niet voor zzp'ers",
    ]) {
      expect(matchFreelanceExclusion(description)).toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBe("freelance");
    }
  });

  it("keeps a qualified exclusion classified as freelance", () => {
    // A subset is excluded, so the contract form itself stays open.
    for (const description of [
      "niet voor zzp'ers zonder KvK",
      "Niet voor zzp'ers met een BV",
    ]) {
      expect(matchFreelanceExclusion(description)).toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBe("freelance");
    }
  });

  it("still excludes when the vacancy itself is the subject", () => {
    for (const description of [
      "Deze opdracht is niet voor zzp'ers",
      "Deze functie is niet voor freelancers",
    ]) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("covers every denial in the shared vocabulary", () => {
    for (const description of [
      "ZZP'ers worden niet geaccepteerd",
      "ZZP niet gewenst",
      "ZZP niet welkom",
      "ZZP niet geaccepteerd",
    ]) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("excludes every term in a coordinated list", () => {
    for (const description of [
      "Geen zzp'ers of freelancers",
      "Geen zzp of freelance",
      "Geen zzp en freelance",
      "Geen freelance of zzp",
    ]) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("excludes every term in a mixed coordinated list", () => {
    // The second term is another contract form, so the list must not hand it
    // back as the answer.
    expect(matchFreelanceExclusion("Geen zzp of detachering")).toBe(
      "Geen zzp of detachering"
    );
    expect(
      classifyContractAndWork("Opdracht", "Geen zzp of detachering")
        .contracttype
    ).toBeNull();
  });

  it("keeps a form stated outside the excluded list", () => {
    expect(
      classifyContractAndWork(
        "Opdracht",
        "Geen ZZP of detachering, alleen vast dienstverband"
      ).contracttype
    ).toBe("vast");
  });

  it("excludes when the vacancy does not stand open", () => {
    const description = "Deze opdracht staat niet open voor zzp'ers";
    expect(matchFreelanceExclusion(description)).not.toBeNull();
    expect(
      classifyContractAndWork("Opdracht", description).contracttype
    ).toBeNull();
  });

  it("excludes through a softening lead-in", () => {
    for (const description of [
      "Helaas niet voor zzp'ers.",
      "Deze opdracht is helaas niet voor zzp'ers.",
      "Let op: niet voor zzp'ers.",
      "Jammer genoeg niet voor freelancers.",
    ]) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("reads a comma fragment as a contrast, not a refusal", () => {
    const description =
      "Reiskostenvergoeding geldt voor werknemers, niet voor zzp'ers. Freelance inzet is mogelijk.";
    expect(matchFreelanceExclusion(description)).toBeNull();
    expect(classifyContractAndWork("Opdracht", description).contracttype).toBe(
      "freelance"
    );
  });

  it("still refuses when the sentence opens with the vacancy subject", () => {
    const description =
      "Deze opdracht is niet voor zzp'ers, wel voor detachering.";
    expect(matchFreelanceExclusion(description)).not.toBeNull();
    expect(classifyContractAndWork("Opdracht", description).contracttype).toBe(
      "detachering"
    );
  });

  it("keeps a subset denial classified as freelance", () => {
    const description =
      "ZZP'ers zijn niet toegestaan zonder KvK; ZZP'ers met KvK zijn welkom.";
    expect(matchFreelanceExclusion(description)).toBeNull();
    expect(classifyContractAndWork("Opdracht", description).contracttype).toBe(
      "freelance"
    );
  });

  it("excludes every term in a comma-separated list", () => {
    const description = "Geen zzp, detachering of interim toegestaan.";
    expect(matchFreelanceExclusion(description)).toBe(
      "Geen zzp, detachering of interim toegestaan"
    );
    expect(
      classifyContractAndWork("Opdracht", description).contracttype
    ).toBeNull();
  });

  it("does not carry geen across an unrelated coordination", () => {
    expect(
      classifyContractAndWork(
        "Opdracht",
        "Geen ervaring en freelance inzet is mogelijk."
      ).contracttype
    ).toBe("freelance");
    expect(
      classifyContractAndWork(
        "Opdracht",
        "geen budget en detachering is mogelijk"
      ).contracttype
    ).toBe("detachering");
  });

  it("stays stable across repeated calls", () => {
    // The list pattern is global, so a leaked lastIndex would make the second
    // call disagree with the first. The report tool calls this per row.
    const description = "Geen zzp, detachering of interim toegestaan.";
    const first = matchFreelanceExclusion(description);
    for (const _attempt of Array.from({ length: 3 })) {
      expect(matchFreelanceExclusion(description)).toBe(first);
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("excludes through a lead-in that carries its own comma", () => {
    for (const description of [
      "Let op, niet voor zzp'ers.",
      "Let op: niet voor zzp'ers.",
      "Helaas, niet voor freelancers.",
    ]) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("excludes with the adverb set off by commas", () => {
    const description = "Deze rol is, helaas, niet voor zzp'ers";
    expect(matchFreelanceExclusion(description)).not.toBeNull();
    expect(
      classifyContractAndWork("Opdracht", description).contracttype
    ).toBeNull();
  });

  it("reads a comma-only tail as a contrast, not a list", () => {
    // A Dutch list closes with of or en. Without one the second term is being
    // offered, not excluded.
    for (const description of [
      "Geen zzp, detachering mogelijk",
      "Geen zzp, wel detachering mogelijk",
    ]) {
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBe("detachering");
    }
  });

  it("still excludes a list that closes with a conjunction", () => {
    expect(
      classifyContractAndWork(
        "Opdracht",
        "Geen zzp, detachering of interim toegestaan."
      ).contracttype
    ).toBeNull();
    expect(
      classifyContractAndWork(
        "Opdracht",
        "Geen zzp of freelance; detachering wel"
      ).contracttype
    ).toBe("detachering");
  });

  it("excludes a list whichever contract form heads it", () => {
    for (const description of [
      "Geen detachering of zzp toegestaan",
      "Geen vast dienstverband of zzp",
    ]) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("leaves the form the list does not name", () => {
    // The list masks detachering and interim, so ZZP is free to answer.
    const description = "Geen detachering of interim, wel zzp";
    expect(matchFreelanceExclusion(description)).toBeNull();
    expect(classifyContractAndWork("Opdracht", description).contracttype).toBe(
      "freelance"
    );
  });

  it("covers every alias the positive matchers accept", () => {
    for (const description of [
      "Geen zzp of vaste aanstelling",
      "Geen zzp of deta-vast",
      "Geen zzp of detavast",
      "Geen zzp of permanent",
      "Geen zzp of vast contract",
      "Geen zzp of detacheren",
      "Geen zzp of interim",
    ]) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("still requires a contract form behind geen", () => {
    // An arbitrary word must never open a list, or the sentence loses its
    // answer to a mask it should not have produced.
    expect(
      classifyContractAndWork(
        "Opdracht",
        "Geen ervaring en freelance inzet is mogelijk."
      ).contracttype
    ).toBe("freelance");
    expect(
      classifyContractAndWork(
        "Opdracht",
        "geen budget en detachering is mogelijk"
      ).contracttype
    ).toBe("detachering");
  });

  it("classifies the vast aliases the coordinated group shares", () => {
    // Deriving the list from the positive matchers widened these two.
    expect(
      classifyContractAndWork("Opdracht", "Vast contract aangeboden.")
        .contracttype
    ).toBe("vast");
    expect(
      classifyContractAndWork("Opdracht", "Vast  dienstverband met doorgroei.")
        .contracttype
    ).toBe("vast");
  });

  it("excludes in either subject order", () => {
    for (const description of [
      "Deze opdracht is niet voor zzp'ers",
      "Helaas is deze opdracht niet voor zzp'ers",
      "Let op, is deze functie niet voor freelancers",
    ]) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("reads a repeated determiner as one list", () => {
    const description = "Geen zzp, geen detachering of interim toegestaan";
    expect(matchFreelanceExclusion(description)).toBe(description);
    expect(
      classifyContractAndWork("Opdracht", description).contracttype
    ).toBeNull();
  });

  it("ends the list at the last contract term", () => {
    // "ervaring" is not a contract form, so it closes the list rather than
    // extending it, and only the zzp ahead of it is excluded.
    const description = "Geen zzp, geen ervaring vereist";
    expect(matchFreelanceExclusion(description)).toBe("Geen zzp");
    expect(
      classifyContractAndWork("Opdracht", description).contracttype
    ).toBeNull();
  });

  it("excludes a list whose tail carries a copula", () => {
    for (const description of [
      "Geen zzp of detachering is mogelijk",
      "Geen zzp of detachering zijn mogelijk",
    ]) {
      expect(matchFreelanceExclusion(description)).toBe(description);
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });

  it("keeps the form stated after a copula-free list", () => {
    const description = "Geen zzp of detachering, wel interim";
    expect(matchFreelanceExclusion(description)).toBe(
      "Geen zzp of detachering"
    );
    expect(classifyContractAndWork("Opdracht", description).contracttype).toBe(
      "interim"
    );
  });

  it("names the phrase when the clause ends in whitespace", () => {
    expect(matchFreelanceExclusion("Geen ZZP \n")).toBe("Geen ZZP");
    expect(matchFreelanceExclusion("Geen ZZP   ")).toBe("Geen ZZP");
  });

  it("suppresses a negated alternative through the shared vocabulary", () => {
    expect(
      classifyContractAndWork(
        "Opdracht",
        "Detachering niet gewenst, ZZP mogelijk."
      ).contracttype
    ).toBe("freelance");
  });

  it("does not read a requirement as an exclusion", () => {
    expect(
      matchFreelanceExclusion("Geen zzp ervaring vereist, freelance mogelijk.")
    ).toBeNull();
    expect(
      classifyContractAndWork(
        "Opdracht",
        "Geen zzp ervaring vereist, freelance mogelijk."
      ).contracttype
    ).toBe("freelance");
  });

  it("leaves a soft warning classified as freelance", () => {
    // Striive prose: a discouragement, not an exclusion, so it stays freelance.
    expect(
      matchFreelanceExclusion(
        "Opdracht is minder geschikt voor ZZP\u2019ers ivm wet DBA"
      )
    ).toBeNull();
    expect(
      classifyContractAndWork(
        "Opdracht",
        "Opdracht is minder geschikt voor ZZP\u2019ers ivm wet DBA"
      ).contracttype
    ).toBe("freelance");
  });
});

describe("CTP-502 plural freelance forms", () => {
  it("reads a plural or possessive as positive evidence", () => {
    // The positive matcher shares FREELANCE_TERM with the exclusion table, so
    // "freelancers" is no longer a spelling only a negation can see.
    for (const description of ["Freelancers welkom.", "Zzp'ers gezocht."]) {
      expect(matchFreelanceExclusion(description)).toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBe("freelance");
    }
  });

  it("still lets an exclusion of the plural win", () => {
    for (const description of [
      "Niet geschikt voor freelancers.",
      "Geen zzp'ers.",
    ]) {
      expect(matchFreelanceExclusion(description)).not.toBeNull();
      expect(
        classifyContractAndWork("Opdracht", description).contracttype
      ).toBeNull();
    }
  });
});
