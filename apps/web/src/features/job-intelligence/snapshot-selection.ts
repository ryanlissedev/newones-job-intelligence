/** Mirrors the server contract constant in packages/application handlers. */
export const SNAPSHOT_MAX_SELECTED_IDS = 100;

export const toggleSelectedId = (
  selected: ReadonlySet<string>,
  id: string
): ReadonlySet<string> => {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
};

export const selectPageIds = (
  selected: ReadonlySet<string>,
  pageIds: readonly string[]
):
  | {
      readonly kind: "ok";
      readonly selected: ReadonlySet<string>;
    }
  | {
      readonly kind: "too-many";
      readonly total: number;
      readonly max: number;
    } => {
  const next = new Set(selected);
  for (const id of pageIds) {
    next.add(id);
  }
  if (next.size > SNAPSHOT_MAX_SELECTED_IDS) {
    return {
      kind: "too-many",
      max: SNAPSHOT_MAX_SELECTED_IDS,
      total: next.size,
    };
  }
  return { kind: "ok", selected: next };
};

export const deselectPageIds = (
  selected: ReadonlySet<string>,
  pageIds: readonly string[]
): ReadonlySet<string> => {
  const next = new Set(selected);
  for (const id of pageIds) {
    next.delete(id);
  }
  return next;
};

export const isPageFullySelected = (
  selected: ReadonlySet<string>,
  pageIds: readonly string[]
): boolean => pageIds.length > 0 && pageIds.every((id) => selected.has(id));

export const selectAllMatchesPlan = (
  total: number
):
  | { readonly kind: "fetch"; readonly pageSize: number }
  | { readonly kind: "too-many"; readonly total: number; readonly max: number }
  | { readonly kind: "empty" } => {
  if (total === 0) {
    return { kind: "empty" };
  }
  if (total > SNAPSHOT_MAX_SELECTED_IDS) {
    return {
      kind: "too-many",
      max: SNAPSHOT_MAX_SELECTED_IDS,
      total,
    };
  }
  return { kind: "fetch", pageSize: SNAPSHOT_MAX_SELECTED_IDS };
};

export const tooManyMatchesMessage = (total: number): string =>
  `Te veel matches om alles te selecteren (${total.toLocaleString("nl-NL")}). Een snapshot bevat maximaal ${SNAPSHOT_MAX_SELECTED_IDS} opdrachten; verfijn de zoekopdracht of selecteer handmatig.`;

export const selectionCountLabel = (count: number): string =>
  `${count} van maximaal ${SNAPSHOT_MAX_SELECTED_IDS} geselecteerd`;
