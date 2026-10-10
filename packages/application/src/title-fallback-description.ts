export interface TitleFallbackDescriptionParts {
  readonly externalId: string;
  readonly platform: string;
  readonly title: string;
}

/** The exact placeholder used when Motian has no usable description. */
export const titleFallbackDescription = ({
  externalId,
  platform,
  title,
}: TitleFallbackDescriptionParts): string =>
  `${title} (${platform}/${externalId})`;

/** Explicit placeholder detection; this deliberately is not a length heuristic. */
export const isTitleFallbackDescription = (
  text: string,
  parts: TitleFallbackDescriptionParts | null | undefined
): boolean =>
  parts !== null &&
  parts !== undefined &&
  text === titleFallbackDescription(parts);
