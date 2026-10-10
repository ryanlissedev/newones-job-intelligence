import { describe, expect, it } from "bun:test";

import { createSliceARegistry } from "./catalog";
import { permissionsForRole } from "./roles";
import {
  digestSourcingSelection,
  createSourcingAssessmentHandler,
  evaluateSourcingAssessment,
  sourcingAssessmentInputSchema,
  SOURCING_ASSESSMENT_MAX_CLAIMS,
  SOURCING_ASSESSMENT_MAX_CLAIM_VALUE_LENGTH,
  SOURCING_ASSESSMENT_MAX_SELECTED_IDS,
  SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCES,
  SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCE_IDS_PER_CLAIM,
  SOURCING_PROMPT_VERSION,
} from "./sourcing-assessment";
import {
  completeSourcingFixture,
  completeSearchReference,
  completeTrustedAttestation,
  contradictorySourcingFixture,
  contradictoryTrustedAttestation,
  emptySourcingFixture,
  emptyTrustedAttestation,
  partialSourcingFixture,
} from "./sourcing-assessment.fixtures";
import {
  createTestSliceADeps,
  createTestSliceARegistry,
  TEST_DEPLOYMENT_SCOPE_ID,
} from "./test-fixtures";

const principal = {
  kind: "user" as const,
  permissions: permissionsForRole("recruiter"),
  subjectId: "recruiter-1",
};
const actor = { kind: principal.kind, subjectId: principal.subjectId };
const serverTime = new Date("2026-09-05T10:00:00.000Z");
const evaluate = (
  input = completeSourcingFixture,
  attestation = completeTrustedAttestation
) =>
  evaluateSourcingAssessment(
    input,
    actor,
    TEST_DEPLOYMENT_SCOPE_ID,
    serverTime,
    attestation
  );

describe("evaluate_sourcing_assessment (RJC-447)", () => {
  it("blocks caller-complete evidence when trusted upstream contracts are absent", async () => {
    const bundle = createTestSliceARegistry();
    const invoke = bundle.registry.createInvoker({
      capabilityId: "evaluate_sourcing_assessment",
      operation: "evaluate_sourcing_assessment",
      transport: "mcp",
    });
    const result = await invoke(completeSourcingFixture, {
      principal,
      requestId: "blocked",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        binding: {
          queryDigest: null,
          searchStatus: "unknown",
          selectedIds: [],
          trust: "unavailable",
        },
        claims: [],
        evaluation: {
          findings: [
            expect.objectContaining({
              code: "UPSTREAM_ATTESTATION_UNAVAILABLE",
            }),
          ],
          status: "blocked-upstream",
        },
        sourceReferences: [],
        usedCapabilities: [],
      },
    });
  });

  it("returns a sanitized correlated failure when configured authority throws", async () => {
    const secret = "DO_NOT_EXPOSE_AUTHORITY_FAILURE";
    const deps = createTestSliceADeps();
    const bundle = createSliceARegistry({
      ...deps,
      sourcingAssessmentAuthority: {
        attest: () => {
          throw new Error(secret);
        },
      },
    });
    const invoke = bundle.registry.createInvoker({
      capabilityId: "evaluate_sourcing_assessment",
      operation: "evaluate_sourcing_assessment",
      transport: "mcp",
    });

    const result = await invoke(completeSourcingFixture, {
      principal,
      requestId: "authority-throw",
    });

    expect(result).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The capability could not be completed",
        requestId: "authority-throw",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("preserves the configured authority failure as the handler error cause", async () => {
    const authorityError = new Error("authority unavailable");
    const deps = createTestSliceADeps();
    const handler = createSourcingAssessmentHandler({
      ...deps,
      sourcingAssessmentAuthority: {
        attest: () => {
          throw authorityError;
        },
      },
    });

    await expect(
      handler(completeSourcingFixture, {
        operation: "evaluate_sourcing_assessment",
        principal,
        requestId: "authority-cause",
        transport: "mcp",
      })
    ).rejects.toMatchObject({ cause: authorityError });
  });

  it("returns a sanitized correlated failure when configured authority is malformed", async () => {
    const secret = "https://user:DO_NOT_EXPOSE@source.example/record";
    const deps = createTestSliceADeps();
    const bundle = createSliceARegistry({
      ...deps,
      sourcingAssessmentAuthority: {
        attest: () =>
          // SAFETY: this synthetic invalid runtime value intentionally bypasses
          // the trusted attestation type to exercise the schema guard.
          ({
            ...completeTrustedAttestation,
            sourceReferences: [
              { ...completeSearchReference, reference: secret },
            ],
          }) as never,
      },
    });
    const invoke = bundle.registry.createInvoker({
      capabilityId: "evaluate_sourcing_assessment",
      operation: "evaluate_sourcing_assessment",
      transport: "mcp",
    });

    const result = await invoke(completeSourcingFixture, {
      principal,
      requestId: "authority-malformed",
    });

    expect(result).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The capability could not be completed",
        requestId: "authority-malformed",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects an authority attestation with too many source references", async () => {
    const deps = createTestSliceADeps();
    const bundle = createSliceARegistry({
      ...deps,
      sourcingAssessmentAuthority: {
        attest: () => ({
          ...completeTrustedAttestation,
          sourceReferences: Array.from(
            { length: SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCES + 1 },
            (_, index) => ({
              ...completeSearchReference,
              id: `reference-${index}`,
              reference: `record-${index}`,
            })
          ),
        }),
      },
    });
    const invoke = bundle.registry.createInvoker({
      capabilityId: "evaluate_sourcing_assessment",
      operation: "evaluate_sourcing_assessment",
      transport: "mcp",
    });

    const result = await invoke(completeSourcingFixture, {
      principal,
      requestId: "authority-reference-limit",
    });

    expect(result).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The capability could not be completed",
        requestId: "authority-reference-limit",
      },
      ok: false,
    });
  });

  it("bounds authenticated assessment claims, values, citations and selection", () => {
    const [claim] = completeSourcingFixture.claims;
    if (!claim) {
      throw new Error("Expected a sourcing fixture claim");
    }

    expect(
      sourcingAssessmentInputSchema.safeParse({
        ...completeSourcingFixture,
        claims: Array.from(
          { length: SOURCING_ASSESSMENT_MAX_CLAIMS + 1 },
          () => claim
        ),
      }).success
    ).toBe(false);
    expect(
      sourcingAssessmentInputSchema.safeParse({
        ...completeSourcingFixture,
        claims: [
          {
            ...claim,
            value: "x".repeat(SOURCING_ASSESSMENT_MAX_CLAIM_VALUE_LENGTH + 1),
          },
        ],
      }).success
    ).toBe(false);
    expect(
      sourcingAssessmentInputSchema.safeParse({
        ...completeSourcingFixture,
        claims: [
          {
            ...claim,
            sourceReferenceIds: Array.from(
              {
                length:
                  SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCE_IDS_PER_CLAIM + 1,
              },
              (_, index) => `reference-${index}`
            ),
          },
        ],
      }).success
    ).toBe(false);
    expect(
      sourcingAssessmentInputSchema.safeParse({
        ...completeSourcingFixture,
        selectedIds: Array.from(
          { length: SOURCING_ASSESSMENT_MAX_SELECTED_IDS + 1 },
          () => completeSourcingFixture.selectedIds[0]
        ),
      }).success
    ).toBe(false);
  });

  it("uses server-owned time for freshness and produces deterministic trusted output", () => {
    const first = evaluate();
    const second = evaluate();

    expect(first).toEqual(second);
    expect(first.evaluation).toMatchObject({
      asOf: serverTime.toISOString(),
      status: "passed",
    });
    expect(first.sourceReferences).toContainEqual(
      expect.objectContaining({
        ageSeconds: 1800,
        id: "detail-1",
        status: "fresh",
      })
    );
    expect(first.prompt).toMatchObject({
      readOnly: true,
      version: SOURCING_PROMPT_VERSION,
    });
    expect(
      first.dependencyGuards.every(({ status }) => status === "satisfied")
    ).toBe(true);
  });

  it("treats equivalent claims in a different client order as the same answer", () => {
    const reorderedInput = {
      ...completeSourcingFixture,
      claims: completeSourcingFixture.claims
        .map((claim) => ({
          ...claim,
          sourceReferenceIds: claim.sourceReferenceIds.toReversed(),
        }))
        .toReversed(),
    };

    const result = evaluate(reorderedInput);

    expect(result.evaluation.status).toBe("passed");
    expect(result.evaluation.findings).not.toContainEqual(
      expect.objectContaining({ code: "CLAIM_ATTESTATION_MISMATCH" })
    );
  });

  it("keeps the evaluation digest stable for equivalent attestation and input ordering", () => {
    const reorderedInput = {
      ...completeSourcingFixture,
      claims: completeSourcingFixture.claims
        .map((claim) => ({
          ...claim,
          sourceReferenceIds: claim.sourceReferenceIds.toReversed(),
        }))
        .toReversed(),
      selectedIds: completeSourcingFixture.selectedIds.toReversed(),
    };
    const reorderedAttestation = {
      ...completeTrustedAttestation,
      claims: completeTrustedAttestation.claims
        .map((claim) => ({
          ...claim,
          sourceReferenceIds: claim.sourceReferenceIds.toReversed(),
        }))
        .toReversed(),
      selectedIds: completeTrustedAttestation.selectedIds.toReversed(),
      sourceReferences:
        completeTrustedAttestation.sourceReferences.toReversed(),
      usedCapabilities:
        completeTrustedAttestation.usedCapabilities.toReversed(),
    };

    const original = evaluate();
    const reordered = evaluate(reorderedInput, reorderedAttestation);

    expect(reordered.evaluation.status).toBe("passed");
    expect(reordered.evaluation.findings).toEqual([]);
    expect(reordered.evaluation.inputDigest).toBe(
      original.evaluation.inputDigest
    );
  });

  it("reports a trusted complete empty result as insufficient evidence", () => {
    const result = evaluate(emptySourcingFixture, emptyTrustedAttestation);

    expect(result.evaluation).toMatchObject({
      findings: [],
      status: "insufficient-evidence",
    });
    expect(result.binding).toMatchObject({
      searchStatus: "complete",
      selectedIds: [],
      trust: "attested",
    });
    expect(result.claims).toEqual([]);
  });

  it("keeps incomplete and missing conclusions in review", () => {
    const result = evaluate(partialSourcingFixture, {
      ...completeTrustedAttestation,
      claims: partialSourcingFixture.claims,
      searchStatus: "incomplete",
    });

    expect(result.evaluation.status).toBe("needs-review");
    expect(result.evaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UPSTREAM_SEARCH_INCOMPLETE" }),
        expect.objectContaining({
          code: "MISSING_FIELD_CONCLUSION",
          field: "location",
        }),
      ])
    );
  });

  it("keeps stale trusted evidence from passing", () => {
    const result = evaluate(completeSourcingFixture, {
      ...completeTrustedAttestation,
      sourceReferences: completeTrustedAttestation.sourceReferences.map(
        (reference) =>
          reference.id === "detail-1"
            ? { ...reference, observedAt: "2026-09-05T08:00:00.000Z" }
            : reference
      ),
    });

    expect(result.evaluation.status).toBe("needs-review");
    expect(result.evaluation.findings).toContainEqual(
      expect.objectContaining({ code: "STALE_SOURCE_REFERENCE" })
    );
    expect(result.sourceReferences).toContainEqual(
      expect.objectContaining({ id: "detail-1", status: "stale" })
    );
  });

  it("keeps unknown trusted freshness from passing", () => {
    const result = evaluate(completeSourcingFixture, {
      ...completeTrustedAttestation,
      sourceReferences: completeTrustedAttestation.sourceReferences.map(
        (reference) =>
          reference.id === "detail-1"
            ? { ...reference, maxAgeSeconds: undefined }
            : reference
      ),
    });

    expect(result.evaluation.status).toBe("needs-review");
    expect(result.evaluation.findings).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_SOURCE_FRESHNESS" })
    );
    expect(result.sourceReferences).toContainEqual(
      expect.objectContaining({ id: "detail-1", status: "unknown" })
    );
  });

  it("surfaces contradictory cited conclusions", () => {
    const result = evaluate(
      contradictorySourcingFixture,
      contradictoryTrustedAttestation
    );
    expect(result.evaluation.findings).toContainEqual(
      expect.objectContaining({
        code: "CONTRADICTORY_EVIDENCE",
        field: "deadline",
      })
    );
  });

  it("evaluates trusted conclusions when caller claims are complete", () => {
    const result = evaluate(
      completeSourcingFixture,
      contradictoryTrustedAttestation
    );

    expect(result.evaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CLAIM_ATTESTATION_MISMATCH" }),
        expect.objectContaining({
          code: "CONTRADICTORY_EVIDENCE",
          field: "deadline",
        }),
      ])
    );
  });

  it("rejects query and selection replay against a different attestation", () => {
    const changedAttestation = {
      ...completeTrustedAttestation,
      queryDigest: `sha256:${"2".repeat(64)}`,
      selectedIds: [
        ...completeTrustedAttestation.selectedIds,
        "00000000-0000-4000-8000-000000000102",
      ],
    };
    const result = evaluate(completeSourcingFixture, changedAttestation);

    expect(result.evaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "QUERY_DIGEST_MISMATCH" }),
        expect.objectContaining({ code: "SELECTION_DIGEST_MISMATCH" }),
      ])
    );
    expect(completeSourcingFixture.selectionDigest).not.toBe(
      digestSourcingSelection(changedAttestation)
    );
  });

  it("does not publish proposed claims that differ from trusted conclusions", () => {
    const result = evaluate(partialSourcingFixture, completeTrustedAttestation);

    expect(result.evaluation.findings).toContainEqual(
      expect.objectContaining({ code: "CLAIM_ATTESTATION_MISMATCH" })
    );
    expect(result.claims).toEqual(completeTrustedAttestation.claims);
  });

  it("requires exact capability and trusted-reference parity", () => {
    const missingUsage = evaluate(completeSourcingFixture, {
      ...completeTrustedAttestation,
      usedCapabilities: ["search_aanvragen"],
    });
    const missingReference = evaluate(completeSourcingFixture, {
      ...completeTrustedAttestation,
      sourceReferences: completeTrustedAttestation.sourceReferences.filter(
        ({ capabilityId }) => capabilityId !== "search_aanvragen"
      ),
    });

    expect(missingUsage.evaluation.findings).toContainEqual(
      expect.objectContaining({ code: "REFERENCE_CAPABILITY_NOT_USED" })
    );
    expect(missingReference.evaluation.findings).toContainEqual(
      expect.objectContaining({ code: "USED_CAPABILITY_WITHOUT_REFERENCE" })
    );
  });

  it("accepts trusted data only from server composition", async () => {
    const deps = createTestSliceADeps();
    const bundle = createSliceARegistry({
      ...deps,
      now: () => serverTime,
      sourcingAssessmentAuthority: {
        attest: () => completeTrustedAttestation,
      },
    });
    const invoke = bundle.registry.createInvoker({
      capabilityId: "evaluate_sourcing_assessment",
      operation: "POST /v1/sourcing/assessment",
      transport: "rest",
    });
    const result = await invoke(completeSourcingFixture, {
      principal,
      requestId: "trusted",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        binding: {
          actor,
          scopeId: TEST_DEPLOYMENT_SCOPE_ID,
          trust: "attested",
        },
        evaluation: { asOf: serverTime.toISOString(), status: "passed" },
      },
    });
  });

  it("rejects unsafe or unbounded trusted source references without echoing them", async () => {
    const unsafeReferences = [
      "https://user:DO_NOT_EXPOSE@source.example/record",
      `raw/${"x".repeat(253)}`,
    ];

    await Promise.all(
      unsafeReferences.map(async (reference) => {
        const deps = createTestSliceADeps();
        const bundle = createSliceARegistry({
          ...deps,
          now: () => serverTime,
          sourcingAssessmentAuthority: {
            attest: () => ({
              ...completeTrustedAttestation,
              sourceReferences: [{ ...completeSearchReference, reference }],
              usedCapabilities: ["search_aanvragen"],
            }),
          },
        });
        const invoke = bundle.registry.createInvoker({
          capabilityId: "evaluate_sourcing_assessment",
          operation: "POST /v1/sourcing/assessment",
          transport: "rest",
        });
        const result = await invoke(completeSourcingFixture, {
          principal,
          requestId: "unsafe-reference",
        });

        expect(result).toMatchObject({
          error: {
            code: "INTERNAL_ERROR",
            message: "The capability could not be completed",
            requestId: "unsafe-reference",
          },
          ok: false,
        });
        expect(JSON.stringify(result)).not.toContain(reference);
      })
    );
  });

  it("rejects unsafe trusted reference ids and claim citations without echoing them", async () => {
    const unsafeIds = [
      "https://user:DO_NOT_EXPOSE@source.example/record",
      `reference-${"x".repeat(247)}`,
      `ghp_${"A".repeat(36)}`,
      "sk_live_TOPSECRET_123",
      "secret",
      "token-DO_NOT_EXPOSE",
    ];
    const unsafeAttestations = unsafeIds.flatMap((unsafeId) => [
      {
        secret: unsafeId,
        value: {
          ...completeTrustedAttestation,
          sourceReferences: completeTrustedAttestation.sourceReferences.map(
            (reference) =>
              reference.id === "detail-1"
                ? { ...reference, id: unsafeId }
                : reference
          ),
        },
      },
      {
        secret: unsafeId,
        value: {
          ...completeTrustedAttestation,
          claims: completeTrustedAttestation.claims.map((claim) =>
            claim.status === "known"
              ? { ...claim, sourceReferenceIds: [unsafeId] }
              : claim
          ),
        },
      },
    ]);

    await Promise.all(
      unsafeAttestations.map(async ({ secret, value }) => {
        const deps = createTestSliceADeps();
        const bundle = createSliceARegistry({
          ...deps,
          now: () => serverTime,
          sourcingAssessmentAuthority: { attest: () => value },
        });
        const invoke = bundle.registry.createInvoker({
          capabilityId: "evaluate_sourcing_assessment",
          operation: "POST /v1/sourcing/assessment",
          transport: "rest",
        });
        const result = await invoke(completeSourcingFixture, {
          principal,
          requestId: "unsafe-reference-id",
        });

        expect(result).toMatchObject({
          error: {
            code: "INTERNAL_ERROR",
            message: "The capability could not be completed",
            requestId: "unsafe-reference-id",
          },
          ok: false,
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      })
    );
  });

  it("fails closed when direct evaluation receives an invalid attestation", () => {
    const unsafeReference = `ghp_${"A".repeat(36)}`;
    // SAFETY: this synthetic invalid runtime value intentionally bypasses static typing to exercise the schema guard.
    const result = evaluateSourcingAssessment(
      completeSourcingFixture,
      actor,
      TEST_DEPLOYMENT_SCOPE_ID,
      serverTime,
      {
        ...completeTrustedAttestation,
        sourceReferences: [
          { ...completeSearchReference, reference: unsafeReference },
        ],
      } as never
    );

    expect(result).toMatchObject({
      binding: { trust: "unavailable" },
      claims: [],
      evaluation: { status: "blocked-upstream" },
      sourceReferences: [],
    });
    expect(JSON.stringify(result)).not.toContain(unsafeReference);
  });

  it("registers as read-only MCP and REST", () => {
    const bundle = createTestSliceARegistry();
    const descriptor = bundle.registry.catalog.find(
      ({ id }) => id === "evaluate_sourcing_assessment"
    );
    expect(descriptor).toMatchObject({
      bindings: expect.arrayContaining([
        { operation: "evaluate_sourcing_assessment", transport: "mcp" },
        { operation: "POST /v1/sourcing/assessment", transport: "rest" },
      ]),
      effect: "read",
      grounding: true,
    });
  });
});
