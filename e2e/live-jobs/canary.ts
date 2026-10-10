import { z } from "zod";

export type CanaryJsonValue =
  | string
  | number
  | boolean
  | null
  | CanaryJsonValue[]
  | { readonly [key: string]: CanaryJsonValue };

export const canaryJsonValueSchema: z.ZodType<CanaryJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(canaryJsonValueSchema),
    z.record(z.string(), canaryJsonValueSchema),
  ])
);

const canaryIdSchema = z.string();
const canarySearchResponseSchema = z.object({ ids: z.array(z.string()) });
const canaryBatchResponseSchema = z.object({
  items: z.array(
    z.object({
      aanvraag: z.object({ id: z.string() }),
      id: z.string(),
    })
  ),
});
const canaryDetailResponseSchema = z.object({
  aanvraag: z.record(z.string(), canaryJsonValueSchema),
});
const finiteNumberSchema = z.number().finite();
const jsonArraySchema = z.array(canaryJsonValueSchema);
const jsonBooleanSchema = z.boolean();
const jsonNullSchema = z.null();
const jsonRecordSchema = z.record(z.string(), canaryJsonValueSchema);
const jsonStringSchema = z.string();
const screenshotAttestations = new WeakSet<object>();
const visualAttestations = new WeakMap<object, CanaryScreenshotAttestation>();

export interface CanaryScreenshotAttestation {
  readonly canaryId: string;
  readonly digest: string;
  readonly rawPayloadRef: string;
}

export interface CanaryVisualAttestation {
  readonly exactCanaryDetail: true;
  readonly provenanceVisible: true;
  readonly rawPreviewVisible: true;
  readonly releaseMatched: true;
  readonly searchRendered: true;
}

const compareJsonKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const hasExactlyOne = <Value>(
  values: readonly Value[],
  canaryId: string,
  readId: (value: Value) => string
): boolean => {
  const [onlyValue] = values;
  return (
    values.length === 1 &&
    onlyValue !== undefined &&
    readId(onlyValue) === canaryId
  );
};

/**
 * Search and batch payloads can contain business fields. This module reads
 * only opaque ids, rejects every non-canary result, and never returns payload
 * data to callers or evidence attachments.
 */
export const assertCanarySearchResponse = (
  payload: CanaryJsonValue,
  canaryId: string
): void => {
  const parsed = canarySearchResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    !hasExactlyOne(parsed.data.ids, canaryId, (id) => id)
  ) {
    throw new Error(
      "Canary search response did not contain exactly the configured canary record; no artifact was written."
    );
  }
};

export const assertCanaryBatchResponse = (
  payload: CanaryJsonValue,
  canaryId: string
): void => {
  const parsed = canaryBatchResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    !hasExactlyOne(parsed.data.items, canaryId, (item) => item.id) ||
    parsed.data.items[0]?.aanvraag.id !== canaryId
  ) {
    throw new Error(
      "Canary batch response did not contain exactly the configured record; no artifact was written."
    );
  }
};

const stableJson = (value: CanaryJsonValue): string => {
  const parsedNull = jsonNullSchema.safeParse(value);
  if (parsedNull.success) {
    return JSON.stringify(parsedNull.data);
  }

  const parsedBoolean = jsonBooleanSchema.safeParse(value);
  if (parsedBoolean.success) {
    return JSON.stringify(parsedBoolean.data);
  }

  const parsedString = jsonStringSchema.safeParse(value);
  if (parsedString.success) {
    return JSON.stringify(parsedString.data);
  }

  const parsedNumber = finiteNumberSchema.safeParse(value);
  if (parsedNumber.success) {
    return JSON.stringify(parsedNumber.data);
  }

  const parsedArray = jsonArraySchema.safeParse(value);
  if (parsedArray.success) {
    return `[${parsedArray.data.map(stableJson).join(",")}]`;
  }

  const parsedRecord = jsonRecordSchema.safeParse(value);
  if (parsedRecord.success) {
    const entries = Object.entries(parsedRecord.data)
      .toSorted(([left], [right]) => compareJsonKeys(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(",")}}`;
  }

  throw new TypeError("Canary digest cannot be calculated from this payload.");
};

const sha256 = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * The required pinned digest covers the canonical JSON `aanvraag` object
 * returned by the direct detail endpoint, never its raw-preview body. The
 * returned runtime attestation can only be created after that server response
 * has passed both the exact-id and digest checks.
 */
export const assertCanaryDetailResponse = async (
  payload: CanaryJsonValue,
  canaryId: string,
  expectedDigest: string
): Promise<CanaryScreenshotAttestation> => {
  const parsed = canaryDetailResponseSchema.safeParse(payload);
  const parsedId = parsed.success
    ? canaryIdSchema.safeParse(parsed.data.aanvraag.id)
    : undefined;
  if (!parsed.success || !parsedId?.success || parsedId.data !== canaryId) {
    throw new Error(
      "Canary detail response does not belong to the configured record; no artifact was written."
    );
  }
  if ((await sha256(stableJson(parsed.data.aanvraag))) !== expectedDigest) {
    throw new Error(
      "Canary detail digest does not match E2E_CANARY_DIGEST; no artifact was written."
    );
  }
  const parsedRawPayloadRef = jsonStringSchema.safeParse(
    parsed.data.aanvraag.rawPayloadRef
  );
  if (!parsedRawPayloadRef.success || parsedRawPayloadRef.data.length === 0) {
    throw new Error(
      "Canary detail response has no immutable raw payload reference; no artifact was written."
    );
  }
  const attestation = Object.freeze({
    canaryId,
    digest: expectedDigest,
    rawPayloadRef: parsedRawPayloadRef.data,
  });
  screenshotAttestations.add(attestation);
  return attestation;
};

export const isCanaryScreenshotAttestation = (
  value: CanaryScreenshotAttestation
): boolean => screenshotAttestations.has(value);

/**
 * Minted only after job-flow has completed its real DOM assertions. The
 * attestation carries fixed booleans and is linked by object identity to the
 * already validated response attestation, so no business data is copied into
 * the later visual artifact.
 */
export const issueCanaryVisualAttestation = (
  screenshotAttestation: CanaryScreenshotAttestation
): CanaryVisualAttestation => {
  if (!isCanaryScreenshotAttestation(screenshotAttestation)) {
    throw new Error(
      "Live jobs E2E cannot attest visual state without a validated canary response."
    );
  }
  const attestation = Object.freeze({
    exactCanaryDetail: true as const,
    provenanceVisible: true as const,
    rawPreviewVisible: true as const,
    releaseMatched: true as const,
    searchRendered: true as const,
  });
  visualAttestations.set(attestation, screenshotAttestation);
  return attestation;
};

export const isLinkedCanaryVisualAttestation = (
  value: CanaryVisualAttestation,
  screenshotAttestation: CanaryScreenshotAttestation
): boolean => visualAttestations.get(value) === screenshotAttestation;

export const canonicalCanaryDigest = (
  value: CanaryJsonValue
): Promise<string> => sha256(stableJson(value));
