import { Effect } from "effect";

import { runUseCasePromise, UseCaseValidationFault } from "../effect";
import type { RunUseCaseOptions, UseCaseFault } from "../effect";
import { normaliseCtmObservation } from "./ctm";
import { normaliseFlinterObservation } from "./flinter";
import { normaliseFreelancerNlObservation } from "./freelancer-nl";
import { normaliseHarveyNashObservation } from "./harveynash";
import { normaliseInhuurdeskObservation } from "./inhuurdesk";
import { normaliseJsonLdObservation } from "./json-ld";
import { normaliseNeedstaffingObservation } from "./needstaffing";
import { normaliseOnefellowObservation } from "./onefellow";
import { normaliseOpdrachtoverheidObservation } from "./opdrachtoverheid";
import { normaliseStriiveObservation } from "./striive";
import { normaliseTenderNedObservation } from "./tenderned";
import { validateNormalisedDraft } from "./types";
import type {
  NormalisedAanvraagDraft,
  NormaliseValidationIssue,
} from "./types";

type NormaliseFn = (
  body: Uint8Array,
  contentHash: string
) => NormalisedAanvraagDraft;

const wrapNormalise =
  (name: string, native: NormaliseFn) =>
  (
    body: Uint8Array,
    contentHash: string
  ): Effect.Effect<NormalisedAanvraagDraft, UseCaseFault> =>
    Effect.try({
      catch: (cause) =>
        new UseCaseValidationFault({
          cause,
          message: `${name} failed`,
        }),
      try: () => native(body, contentHash),
    });

export const normaliseTenderNedObservationEffect = wrapNormalise(
  "normaliseTenderNedObservation",
  normaliseTenderNedObservation
);
export const normaliseInhuurdeskObservationEffect = wrapNormalise(
  "normaliseInhuurdeskObservation",
  normaliseInhuurdeskObservation
);
export const normaliseJsonLdObservationEffect = wrapNormalise(
  "normaliseJsonLdObservation",
  normaliseJsonLdObservation
);
export const normaliseOpdrachtoverheidObservationEffect = wrapNormalise(
  "normaliseOpdrachtoverheidObservation",
  normaliseOpdrachtoverheidObservation
);
export const normaliseNeedstaffingObservationEffect = wrapNormalise(
  "normaliseNeedstaffingObservation",
  normaliseNeedstaffingObservation
);
export const normaliseOnefellowObservationEffect = wrapNormalise(
  "normaliseOnefellowObservation",
  normaliseOnefellowObservation
);
export const normaliseStriiveObservationEffect = wrapNormalise(
  "normaliseStriiveObservation",
  normaliseStriiveObservation
);
export const normaliseFlinterObservationEffect = wrapNormalise(
  "normaliseFlinterObservation",
  normaliseFlinterObservation
);
export const normaliseFreelancerNlObservationEffect = wrapNormalise(
  "normaliseFreelancerNlObservation",
  normaliseFreelancerNlObservation
);
export const normaliseHarveyNashObservationEffect = wrapNormalise(
  "normaliseHarveyNashObservation",
  normaliseHarveyNashObservation
);
export const normaliseCtmObservationEffect = wrapNormalise(
  "normaliseCtmObservation",
  normaliseCtmObservation
);

export const validateNormalisedDraftEffect = (
  draft: NormalisedAanvraagDraft
): Effect.Effect<NormaliseValidationIssue[], never> =>
  Effect.sync(() => validateNormalisedDraft(draft));

const runNormalise =
  (
    effectFn: (
      body: Uint8Array,
      contentHash: string
    ) => Effect.Effect<NormalisedAanvraagDraft, UseCaseFault>
  ) =>
  (
    body: Uint8Array,
    contentHash: string,
    options?: RunUseCaseOptions
  ): Promise<NormalisedAanvraagDraft> =>
    runUseCasePromise(effectFn(body, contentHash), options);

export const runNormaliseTenderNedObservation = runNormalise(
  normaliseTenderNedObservationEffect
);
export const runNormaliseInhuurdeskObservation = runNormalise(
  normaliseInhuurdeskObservationEffect
);
export const runNormaliseJsonLdObservation = runNormalise(
  normaliseJsonLdObservationEffect
);
export const runNormaliseOpdrachtoverheidObservation = runNormalise(
  normaliseOpdrachtoverheidObservationEffect
);
export const runNormaliseNeedstaffingObservation = runNormalise(
  normaliseNeedstaffingObservationEffect
);
export const runNormaliseOnefellowObservation = runNormalise(
  normaliseOnefellowObservationEffect
);
export const runNormaliseStriiveObservation = runNormalise(
  normaliseStriiveObservationEffect
);
export const runNormaliseFlinterObservation = runNormalise(
  normaliseFlinterObservationEffect
);
export const runNormaliseFreelancerNlObservation = runNormalise(
  normaliseFreelancerNlObservationEffect
);
export const runNormaliseHarveyNashObservation = runNormalise(
  normaliseHarveyNashObservationEffect
);
export const runNormaliseCtmObservation = runNormalise(
  normaliseCtmObservationEffect
);

export const runValidateNormalisedDraft = (
  draft: NormalisedAanvraagDraft,
  options?: RunUseCaseOptions
): Promise<NormaliseValidationIssue[]> =>
  runUseCasePromise(validateNormalisedDraftEffect(draft), options);
