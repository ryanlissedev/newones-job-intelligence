import { createHash } from "node:crypto";

import { UNKNOWN } from "@ji/domain";
import { Effect, Schema } from "effect";

import type { InvocationContext, InvocationPrincipal } from "./capability";
import type { SliceAHandlerDeps } from "./handlers/deps";
import type { SchemaEncoded, SchemaType } from "./schema-helpers";
import {
  IsoDateTimeString,
  NonNegativeInteger,
  optionalField,
  PositiveInteger,
  toCapabilitySchema,
  UuidString,
} from "./schema-helpers";

export const SOURCING_PROMPT_ID = "catapulze.sourcing-assessment" as const;
export const SOURCING_PROMPT_VERSION = "1.0.0" as const;
export const sourcingFields = [
  "deadline",
  "rate",
  "location",
  "contract_type",
] as const;
/**
 * Keep one assessment within one search hydration window. Four conclusions
 * are possible per selected vacancy, so the claim cap follows the selection
 * cap instead of becoming an unrelated second limit.
 */
export const SOURCING_ASSESSMENT_MAX_SELECTED_IDS = 100;
export const SOURCING_ASSESSMENT_MAX_CLAIMS =
  SOURCING_ASSESSMENT_MAX_SELECTED_IDS * sourcingFields.length;
export const SOURCING_ASSESSMENT_MAX_CLAIM_VALUE_LENGTH = 512;
export const SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCE_IDS_PER_CLAIM = 8;
export const SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCES =
  SOURCING_ASSESSMENT_MAX_CLAIMS *
  SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCE_IDS_PER_CLAIM;
const evidenceCapabilityIds = [
  "search_aanvragen",
  "batch_get_aanvragen",
  "get_aanvraag",
  "list_versies",
  "read_raw",
  "list_bronnen",
  "get_bron",
] as const;
const secretLikeReferenceIdPatterns = [
  /(?:^|[._:/-])(?:api[_-]?key|access[_-]?key|bearer|credential|password|passwd|private[_-]?key|secret|sk_(?:live|test)|token)(?:$|[._:/-])/iu,
  /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/u,
  /^github_pat_[A-Za-z0-9_]{20,}$/u,
  /^AKIA[0-9A-Z]{16}$/u,
  /^sk[-_](?:live|test)[-_][A-Za-z0-9_-]{16,}$/iu,
  /^bearer[-_][A-Za-z0-9._~-]{16,}$/iu,
  /^(?:-----)?BEGIN[-_ ](?:[A-Z]+[-_ ])?PRIVATE[-_ ]KEY/iu,
] as const;
const OPAQUE_SOURCE_REFERENCE_ID_MAX_LENGTH = 256;
const opaqueSourceReferenceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(OPAQUE_SOURCE_REFERENCE_ID_MAX_LENGTH),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
  Schema.makeFilter((reference) =>
    reference.includes("://") ? "Expected an opaque reference" : undefined
  ),
  Schema.makeFilter((reference) =>
    secretLikeReferenceIdPatterns.some((pattern) => pattern.test(reference))
      ? "Expected a reference without secret-like material"
      : undefined
  )
);
const sha256Value = Schema.String.check(
  Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)
);
const sourceReference = Schema.Struct({
  capabilityId: Schema.Literals(evidenceCapabilityIds),
  id: opaqueSourceReferenceId,
  maxAgeSeconds: optionalField(PositiveInteger),
  observedAt: Schema.NullOr(IsoDateTimeString),
  reference: opaqueSourceReferenceId,
});
const claimBaseFields = {
  field: Schema.Literals(sourcingFields),
  vacancyId: UuidString,
} as const;
const claimValue = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_CLAIM_VALUE_LENGTH)
);
const emptyReferenceIds = Schema.Array(opaqueSourceReferenceId)
  .check(
    Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCE_IDS_PER_CLAIM)
  )
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed<readonly string[]>([])));
const sourcingClaim = Schema.Union([
  Schema.Struct({
    ...claimBaseFields,
    sourceReferenceIds: Schema.Array(opaqueSourceReferenceId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCE_IDS_PER_CLAIM)
    ),
    status: Schema.Literal("known"),
    value: claimValue.check(
      Schema.makeFilter((value) =>
        value === UNKNOWN ? "Expected a known value" : undefined
      )
    ),
  }),
  Schema.Struct({
    ...claimBaseFields,
    sourceReferenceIds: emptyReferenceIds,
    status: Schema.Literal("unknown"),
    value: Schema.Literal(UNKNOWN),
  }),
  Schema.Struct({
    ...claimBaseFields,
    sourceReferenceIds: emptyReferenceIds,
    status: Schema.Literal("uncertain"),
    value: optionalField(claimValue),
  }),
]);
const trustedAttestation = Schema.Struct({
  claims: Schema.Array(sourcingClaim).check(
    Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_CLAIMS)
  ),
  queryDigest: sha256Value,
  searchStatus: Schema.Literals(["complete", "incomplete", "unknown"]),
  selectedIds: Schema.Array(UuidString).check(
    Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_SELECTED_IDS)
  ),
  sourceReferences: Schema.Array(sourceReference).check(
    Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCES)
  ),
  usedCapabilities: Schema.Array(Schema.Literals(evidenceCapabilityIds)).check(
    Schema.isMaxLength(evidenceCapabilityIds.length)
  ),
});
const trustedAttestationSchema = toCapabilitySchema(trustedAttestation);
export type TrustedSourcingAttestation = SchemaType<
  typeof trustedAttestationSchema
>;
export const sourcingAssessmentInputSchema = toCapabilitySchema(
  Schema.Struct({
    claims: Schema.Array(sourcingClaim).check(
      Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_CLAIMS)
    ),
    queryDigest: sha256Value,
    selectedIds: Schema.Array(UuidString).check(
      Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_SELECTED_IDS)
    ),
    selectionDigest: sha256Value,
  })
);
const findingCodes = [
  "UPSTREAM_ATTESTATION_UNAVAILABLE",
  "CLAIM_ATTESTATION_MISMATCH",
  "QUERY_DIGEST_MISMATCH",
  "DUPLICATE_SELECTION_ID",
  "SELECTION_DIGEST_MISMATCH",
  "CLAIM_OUTSIDE_SELECTION",
  "DANGLING_SOURCE_REFERENCE",
  "DUPLICATE_SOURCE_REFERENCE",
  "REFERENCE_CAPABILITY_NOT_USED",
  "USED_CAPABILITY_WITHOUT_REFERENCE",
  "CONTRADICTORY_EVIDENCE",
  "MISSING_FIELD_CONCLUSION",
  "FUTURE_SOURCE_REFERENCE",
  "STALE_SOURCE_REFERENCE",
  "UNKNOWN_SOURCE_FRESHNESS",
  "UPSTREAM_SEARCH_INCOMPLETE",
] as const;
const evaluatorFinding = Schema.Struct({
  code: Schema.Literals(findingCodes),
  field: optionalField(Schema.Literals(sourcingFields)),
  message: Schema.String,
  vacancyId: optionalField(UuidString),
});
const freshnessReadback = Schema.Struct({
  ...sourceReference.fields,
  ageSeconds: Schema.NullOr(NonNegativeInteger),
  status: Schema.Literals(["fresh", "stale", "unknown"]),
});
const dependencyGuard = Schema.Struct({
  issue: Schema.Literals(["RJC-427", "RJC-429", "RJC-430", "RJC-431"]),
  requirement: Schema.String,
  status: Schema.Literals(["satisfied", "upstream-required"]),
});
export const sourcingAssessmentOutputSchema = toCapabilitySchema(
  Schema.Struct({
    binding: Schema.Struct({
      actor: Schema.Struct({
        kind: Schema.Literals(["user", "agent", "service"]),
        subjectId: Schema.String,
      }),
      queryDigest: Schema.NullOr(sha256Value),
      scopeId: Schema.String,
      searchStatus: Schema.Literals(["complete", "incomplete", "unknown"]),
      selectedIds: Schema.Array(UuidString).check(
        Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_SELECTED_IDS)
      ),
      selectionDigest: Schema.NullOr(sha256Value),
      trust: Schema.Literals(["attested", "unavailable"]),
    }),
    claims: Schema.Array(sourcingClaim).check(
      Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_CLAIMS)
    ),
    dependencyGuards: Schema.Array(dependencyGuard),
    evaluation: Schema.Struct({
      asOf: IsoDateTimeString,
      findings: Schema.Array(evaluatorFinding),
      inputDigest: sha256Value,
      status: Schema.Literals([
        "passed",
        "needs-review",
        "insufficient-evidence",
        "blocked-upstream",
      ]),
    }),
    prompt: Schema.Struct({
      id: Schema.Literal(SOURCING_PROMPT_ID),
      instructions: Schema.Array(Schema.String),
      readOnly: Schema.Literal(true),
      version: Schema.Literal(SOURCING_PROMPT_VERSION),
    }),
    sourceReferences: Schema.Array(freshnessReadback).check(
      Schema.isMaxLength(SOURCING_ASSESSMENT_MAX_SOURCE_REFERENCES)
    ),
    usedCapabilities: Schema.Array(
      Schema.Literals(evidenceCapabilityIds)
    ).check(Schema.isMaxLength(evidenceCapabilityIds.length)),
  })
);
export type SourcingAssessmentInput = SchemaType<
  typeof sourcingAssessmentInputSchema
>;
interface CanonicalClaim {
  readonly field: (typeof sourcingFields)[number];
  readonly sourceReferenceIds: readonly string[];
  readonly status: "known" | "unknown" | "uncertain";
  readonly vacancyId: string;
  readonly value?: string;
}
interface CanonicalSourceReference {
  readonly capabilityId: (typeof evidenceCapabilityIds)[number];
  readonly id: string;
  readonly maxAgeSeconds?: number;
  readonly observedAt: string | null;
  readonly reference: string;
}
interface CanonicalInput {
  readonly claims: readonly CanonicalClaim[];
  readonly queryDigest: string;
  readonly selectedIds: readonly string[];
  readonly selectionDigest: string;
}
interface CanonicalAttestation {
  readonly claims: readonly CanonicalClaim[];
  readonly queryDigest: string;
  readonly searchStatus: "complete" | "incomplete" | "unknown";
  readonly selectedIds: readonly string[];
  readonly sourceReferences: readonly CanonicalSourceReference[];
  readonly usedCapabilities: readonly (typeof evidenceCapabilityIds)[number][];
}
type DigestValue =
  | { readonly queryDigest: string; readonly selectedIds: readonly string[] }
  | {
      readonly attestation: CanonicalAttestation | null;
      readonly input: CanonicalInput;
    };
const digestJson = (value: DigestValue): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
export const digestSourcingSelection = (input: {
  readonly queryDigest: string;
  readonly selectedIds: readonly string[];
}): `sha256:${string}` =>
  digestJson({
    queryDigest: input.queryDigest,
    selectedIds: input.selectedIds.toSorted(),
  });
const promptInstructions = [
  "Use only trusted read capabilities and source references; never write, approve, export, or mutate data.",
  "For deadline, rate, location, and contract type, return a cited known value or explicitly mark the conclusion unknown or uncertain.",
  "Never infer a missing value from a neighbouring field or from general knowledge.",
  "Treat contradictory cited values as unresolved and surface them for evaluator review.",
  "Bind the answer to the authenticated actor, deployment scope, canonical query, and authorized selection in the readback.",
] as const;
const dependencyRequirements = [
  ["RJC-427", "Provide the canonical structural query identity."],
  ["RJC-429", "Preserve unknown facts and authoritative field provenance."],
  ["RJC-430", "Attest the current authorized selection."],
  ["RJC-431", "Attest complete versus partial or timed-out search results."],
] as const;
type Finding = typeof evaluatorFinding.Type;
const finding = (
  code: Finding["code"],
  message: string,
  detail: Pick<Finding, "field" | "vacancyId"> = {}
): Finding => ({ code, message, ...detail });
const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.toSorted().join("\0") === right.toSorted().join("\0");
const canonicalClaim = (
  claim: SourcingAssessmentInput["claims"][number]
): CanonicalClaim =>
  ({
    field: claim.field,
    sourceReferenceIds: claim.sourceReferenceIds.toSorted(),
    status: claim.status,
    vacancyId: claim.vacancyId,
    value: claim.value,
  }) satisfies CanonicalClaim;
const canonicalClaims = (
  claims: readonly SourcingAssessmentInput["claims"][number][]
) =>
  claims
    .map(canonicalClaim)
    .toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
const sameClaims = (
  left: readonly SourcingAssessmentInput["claims"][number][],
  right: readonly SourcingAssessmentInput["claims"][number][]
) => {
  const leftCanonical = canonicalClaims(left).map((claim) =>
    JSON.stringify(claim)
  );
  const rightCanonical = canonicalClaims(right).map((claim) =>
    JSON.stringify(claim)
  );
  return (
    leftCanonical.length === rightCanonical.length &&
    leftCanonical.every((claim, index) => claim === rightCanonical[index])
  );
};
const canonicalSourceReferences = (
  references: readonly TrustedSourcingAttestation["sourceReferences"][number][]
) =>
  references
    .map(
      (reference) =>
        ({
          capabilityId: reference.capabilityId,
          id: reference.id,
          maxAgeSeconds: reference.maxAgeSeconds,
          observedAt: reference.observedAt,
          reference: reference.reference,
        }) satisfies CanonicalSourceReference
    )
    .toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
const canonicalInput = (input: SourcingAssessmentInput): CanonicalInput =>
  ({
    claims: canonicalClaims(input.claims),
    queryDigest: input.queryDigest,
    selectedIds: input.selectedIds.toSorted(),
    selectionDigest: input.selectionDigest,
  }) satisfies CanonicalInput;
const canonicalAttestation = (
  attestation: TrustedSourcingAttestation | null
): CanonicalAttestation | null =>
  attestation === null
    ? null
    : ({
        claims: canonicalClaims(attestation.claims),
        queryDigest: attestation.queryDigest,
        searchStatus: attestation.searchStatus,
        selectedIds: attestation.selectedIds.toSorted(),
        sourceReferences: canonicalSourceReferences(
          attestation.sourceReferences
        ),
        usedCapabilities: attestation.usedCapabilities.toSorted(),
      } satisfies CanonicalAttestation);

const readFreshness = (
  reference: typeof sourceReference.Type,
  asOf: Date
): typeof freshnessReadback.Type => {
  if (reference.observedAt === null) {
    return { ...reference, ageSeconds: null, status: "unknown" };
  }
  const observedAt = new Date(reference.observedAt);
  const ageSeconds = Math.max(
    0,
    Math.floor((asOf.getTime() - observedAt.getTime()) / 1000)
  );
  if (observedAt > asOf || reference.maxAgeSeconds === undefined) {
    return { ...reference, ageSeconds, status: "unknown" };
  }
  return {
    ...reference,
    ageSeconds,
    status: ageSeconds <= reference.maxAgeSeconds ? "fresh" : "stale",
  };
};

const evaluateReferenceFindings = (
  attestation: TrustedSourcingAttestation,
  asOf: Date
) => {
  const findings: Finding[] = [];
  const referenceIds = new Set<string>();
  const referencedCapabilities = new Set<string>();
  const usedCapabilities = new Set(attestation.usedCapabilities);
  for (const reference of attestation.sourceReferences) {
    if (referenceIds.has(reference.id)) {
      findings.push(
        finding(
          "DUPLICATE_SOURCE_REFERENCE",
          `Duplicate reference ${reference.id}`
        )
      );
    }
    referenceIds.add(reference.id);
    referencedCapabilities.add(reference.capabilityId);
    if (!usedCapabilities.has(reference.capabilityId)) {
      findings.push(
        finding(
          "REFERENCE_CAPABILITY_NOT_USED",
          `Reference ${reference.id} names an unused capability`
        )
      );
    }
    if (
      reference.observedAt !== null &&
      new Date(reference.observedAt) > asOf
    ) {
      findings.push(
        finding(
          "FUTURE_SOURCE_REFERENCE",
          `Reference ${reference.id} is later than server evaluation time`
        )
      );
    }
    const freshness = readFreshness(reference, asOf);
    if (freshness.status === "stale") {
      findings.push(
        finding(
          "STALE_SOURCE_REFERENCE",
          `Reference ${reference.id} exceeds its trusted freshness limit`
        )
      );
    }
    if (freshness.status === "unknown") {
      findings.push(
        finding(
          "UNKNOWN_SOURCE_FRESHNESS",
          `Reference ${reference.id} has no trusted freshness conclusion`
        )
      );
    }
  }
  for (const capabilityId of usedCapabilities) {
    if (!referencedCapabilities.has(capabilityId)) {
      findings.push(
        finding(
          "USED_CAPABILITY_WITHOUT_REFERENCE",
          `Capability ${capabilityId} has no trusted reference`
        )
      );
    }
  }
  return { findings, referenceIds };
};

const evaluateFindings = (
  input: SourcingAssessmentInput,
  attestation: TrustedSourcingAttestation,
  asOf: Date
): Finding[] => {
  const findings: Finding[] = [];
  const selectedIds = new Set(attestation.selectedIds);
  if (attestation.queryDigest !== input.queryDigest) {
    findings.push(
      finding("QUERY_DIGEST_MISMATCH", "Canonical query attestation mismatch")
    );
  }
  if (!sameClaims(attestation.claims, input.claims)) {
    findings.push(
      finding(
        "CLAIM_ATTESTATION_MISMATCH",
        "Proposed claims differ from authoritative upstream conclusions"
      )
    );
  }
  if (selectedIds.size !== attestation.selectedIds.length) {
    findings.push(
      finding("DUPLICATE_SELECTION_ID", "Attested selection has duplicate ids")
    );
  }
  if (
    digestSourcingSelection(attestation) !== input.selectionDigest ||
    !sameIds(input.selectedIds, attestation.selectedIds)
  ) {
    findings.push(
      finding(
        "SELECTION_DIGEST_MISMATCH",
        "Requested selection differs from the authorized selection"
      )
    );
  }
  if (attestation.searchStatus !== "complete") {
    findings.push(
      finding(
        "UPSTREAM_SEARCH_INCOMPLETE",
        "Trusted search did not attest a complete result set"
      )
    );
  }
  const referenceEvaluation = evaluateReferenceFindings(attestation, asOf);
  findings.push(...referenceEvaluation.findings);
  const claimsByKey = new Map<string, TrustedSourcingAttestation["claims"]>();
  for (const claim of attestation.claims) {
    if (!selectedIds.has(claim.vacancyId)) {
      findings.push(
        finding("CLAIM_OUTSIDE_SELECTION", "Claim is outside the selection", {
          field: claim.field,
          vacancyId: claim.vacancyId,
        })
      );
    }
    for (const referenceId of claim.sourceReferenceIds) {
      if (!referenceEvaluation.referenceIds.has(referenceId)) {
        findings.push(
          finding(
            "DANGLING_SOURCE_REFERENCE",
            `Claim cites missing trusted reference ${referenceId}`,
            { field: claim.field, vacancyId: claim.vacancyId }
          )
        );
      }
    }
    const key = `${claim.vacancyId}:${claim.field}`;
    claimsByKey.set(key, [...(claimsByKey.get(key) ?? []), claim]);
  }
  for (const vacancyId of selectedIds) {
    for (const field of sourcingFields) {
      const claims = claimsByKey.get(`${vacancyId}:${field}`) ?? [];
      if (claims.length === 0) {
        findings.push(
          finding("MISSING_FIELD_CONCLUSION", "Missing field conclusion", {
            field,
            vacancyId,
          })
        );
        continue;
      }
      const knownValues = new Set(
        claims
          .filter((claim) => claim.status === "known")
          .map(({ value }) => value)
      );
      if (knownValues.size > 1) {
        findings.push(
          finding("CONTRADICTORY_EVIDENCE", "Conflicting known values", {
            field,
            vacancyId,
          })
        );
      }
    }
  }
  return findings;
};
const determineEvaluationStatus = (
  input: SourcingAssessmentInput,
  attestation: TrustedSourcingAttestation | null,
  findings: readonly Finding[]
) => {
  if (!attestation) {
    return "blocked-upstream" as const;
  }
  if (input.selectedIds.length === 0 || input.claims.length === 0) {
    return "insufficient-evidence" as const;
  }
  return findings.length === 0
    ? ("passed" as const)
    : ("needs-review" as const);
};
export const evaluateSourcingAssessment = (
  input: SourcingAssessmentInput,
  actor: {
    readonly kind: "user" | "agent" | "service";
    readonly subjectId: string;
  },
  scopeId: string,
  asOf: Date,
  attestation: TrustedSourcingAttestation | null
): SchemaEncoded<typeof sourcingAssessmentOutputSchema> => {
  const parsedAttestation = attestation
    ? trustedAttestationSchema.safeParse(attestation)
    : null;
  const attested = parsedAttestation?.success ? parsedAttestation.data : null;
  const findings = attested
    ? evaluateFindings(input, attested, asOf)
    : [
        finding(
          "UPSTREAM_ATTESTATION_UNAVAILABLE",
          "Trusted query, selection, search, and provenance attestations are unavailable"
        ),
      ];
  const status = determineEvaluationStatus(input, attested, findings);
  const sourceReferences = attested?.sourceReferences ?? [];
  return {
    binding: {
      actor,
      queryDigest: attested?.queryDigest ?? null,
      scopeId,
      searchStatus: attested?.searchStatus ?? "unknown",
      selectedIds: attested ? [...attested.selectedIds] : [],
      selectionDigest: attested ? digestSourcingSelection(attested) : null,
      trust: attested ? "attested" : "unavailable",
    },
    claims: attested ? [...attested.claims] : [],
    dependencyGuards: dependencyRequirements.map(([issue, requirement]) => ({
      issue,
      requirement,
      status: attested ? "satisfied" : "upstream-required",
    })),
    evaluation: {
      asOf: asOf.toISOString(),
      findings,
      inputDigest: digestJson({
        attestation: canonicalAttestation(attested),
        input: canonicalInput(input),
      }),
      status,
    },
    prompt: {
      id: SOURCING_PROMPT_ID,
      instructions: [...promptInstructions],
      readOnly: true,
      version: SOURCING_PROMPT_VERSION,
    },
    sourceReferences: sourceReferences.map((reference) =>
      readFreshness(reference, asOf)
    ),
    usedCapabilities: attested
      ? [...new Set(attested.usedCapabilities)].toSorted()
      : [],
  };
};
export const createSourcingAssessmentHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SourcingAssessmentInput,
    context: InvocationContext & { readonly principal: InvocationPrincipal }
  ) => {
    const actor = {
      kind: context.principal.kind,
      subjectId: context.principal.subjectId,
    };
    let attestation: TrustedSourcingAttestation | null = null;
    if (deps.sourcingAssessmentAuthority) {
      try {
        const raw = await deps.sourcingAssessmentAuthority.attest(
          { queryDigest: input.queryDigest, selectedIds: input.selectedIds },
          actor
        );
        const parsed = trustedAttestationSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            "Sourcing assessment authority returned an invalid attestation"
          );
        }
        attestation = parsed.data;
      } catch (error) {
        // The registry converts this into a request-correlated, sanitized
        // INTERNAL_ERROR and reports the handler phase for metrics. Do not
        // downgrade a configured authority failure to blocked-upstream.
        throw new Error("Sourcing assessment authority failed", {
          cause: error,
        });
      }
    }
    return {
      ok: true as const,
      value: evaluateSourcingAssessment(
        input,
        actor,
        deps.scopeId,
        deps.now?.() ?? new Date(),
        attestation
      ),
    };
  };
