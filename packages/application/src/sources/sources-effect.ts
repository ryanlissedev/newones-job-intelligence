import { Effect } from "effect";

import { runUseCasePromise } from "../effect";
import type { RunUseCaseOptions } from "../effect";
import type { SourceDefinition } from "./definition";
import type { SupportedBronSlug, SOURCES } from "./registry";
import {
  findSourceByNaam,
  isSupportedBronSlug,
  resolveSourceByNaam,
  SUPPORTED_BRON_SLUGS,
} from "./registry";

export const isSupportedBronSlugEffect = (
  value: string
): Effect.Effect<boolean, never> =>
  Effect.sync(() => isSupportedBronSlug(value));

export const findSourceByNaamEffect = <
  Source extends Pick<SourceDefinition, "naam">,
>(
  sources: readonly Source[],
  naam: string
): Effect.Effect<Source | undefined, never> =>
  Effect.sync(() => findSourceByNaam(sources, naam));

export const resolveSourceByNaamEffect = (
  naam: string
): Effect.Effect<(typeof SOURCES)[SupportedBronSlug] | undefined, never> =>
  Effect.sync(() => resolveSourceByNaam(naam));

export const listSupportedBronSlugsEffect = (): Effect.Effect<
  readonly SupportedBronSlug[],
  never
> => Effect.sync(() => SUPPORTED_BRON_SLUGS);

export const runIsSupportedBronSlug = (
  value: string,
  options?: RunUseCaseOptions
): Promise<boolean> =>
  runUseCasePromise(isSupportedBronSlugEffect(value), options);

export const runResolveSourceByNaam = (
  naam: string,
  options?: RunUseCaseOptions
): Promise<(typeof SOURCES)[SupportedBronSlug] | undefined> =>
  runUseCasePromise(resolveSourceByNaamEffect(naam), options);

export const runListSupportedBronSlugs = (
  options?: RunUseCaseOptions
): Promise<readonly SupportedBronSlug[]> =>
  runUseCasePromise(listSupportedBronSlugsEffect(), options);
