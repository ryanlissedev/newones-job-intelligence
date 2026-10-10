import type { BronId } from "@ji/domain";
import { Effect } from "effect";

import { mapUnknownToUseCaseFault, runUseCasePromise } from "../effect";
import type { RunUseCaseOptions, UseCaseFault } from "../effect";
import {
  activateBron,
  createBron,
  isPollableBron,
  listPublicBronnen,
  mapPublicBronnen,
  toPublicBronView,
  validateSecretRef,
} from "./register";
import type {
  ActivateBronRegisterResult,
  BronPersistence,
  BronRegisterRecord,
  CreateBronInput,
  CreateBronResult,
  PublicBronView,
} from "./register";

export const createBronEffect = (
  input: CreateBronInput
): Effect.Effect<CreateBronResult, never> =>
  Effect.sync(() => createBron(input));

export const toPublicBronViewEffect = (
  record: BronRegisterRecord
): Effect.Effect<PublicBronView, never> =>
  Effect.sync(() => toPublicBronView(record));

export const validateSecretRefEffect = (
  secretRef: string | null
): Effect.Effect<string[], never> =>
  Effect.sync(() => validateSecretRef(secretRef));

export const isPollableBronEffect = (
  record: BronRegisterRecord
): Effect.Effect<boolean, never> => Effect.sync(() => isPollableBron(record));

export const mapPublicBronnenEffect = (
  records: BronRegisterRecord[]
): Effect.Effect<PublicBronView[], never> =>
  Effect.sync(() => mapPublicBronnen(records));

/** Same Result wire as native `activateBron` (ok/reason); port throws → UseCaseFault. */
export const activateBronEffect = (
  persistence: BronPersistence,
  input: {
    bronId: BronId;
    testImportRunId: string;
    minimumTestImportObservations?: number;
  }
): Effect.Effect<ActivateBronRegisterResult, UseCaseFault> =>
  Effect.tryPromise({
    catch: (cause) => mapUnknownToUseCaseFault(cause),
    try: () => activateBron(persistence, input),
  });

export const listPublicBronnenEffect = (
  persistence: BronPersistence
): Effect.Effect<PublicBronView[], UseCaseFault> =>
  Effect.tryPromise({
    catch: (cause) => mapUnknownToUseCaseFault(cause),
    try: () => listPublicBronnen(persistence),
  });

export const runCreateBron = (
  input: CreateBronInput,
  options?: RunUseCaseOptions
): Promise<CreateBronResult> =>
  runUseCasePromise(createBronEffect(input), options);

export const runActivateBron = (
  persistence: BronPersistence,
  input: {
    bronId: BronId;
    testImportRunId: string;
    minimumTestImportObservations?: number;
  },
  options?: RunUseCaseOptions
): Promise<ActivateBronRegisterResult> =>
  runUseCasePromise(activateBronEffect(persistence, input), options);

export const runListPublicBronnen = (
  persistence: BronPersistence,
  options?: RunUseCaseOptions
): Promise<PublicBronView[]> =>
  runUseCasePromise(listPublicBronnenEffect(persistence), options);
