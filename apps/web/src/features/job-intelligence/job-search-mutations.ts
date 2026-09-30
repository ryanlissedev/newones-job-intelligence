import type { Dispatch, SetStateAction } from "react";

import { markeringMutationOutcome } from "./markering-sync";
import { SNAPSHOT_MAX_SELECTED_IDS } from "./snapshot-selection";
import type {
  JobIntelligenceActions,
  JobListing,
  JobMarkering,
  JobSearchFilters,
  JobSearchScope,
  MarkeringSyncState,
} from "./types";

interface JobSearchMutationsInput {
  readonly actions?: JobIntelligenceActions;
  readonly applyMarkeringResult: (
    resourceId: string,
    markering: JobMarkering
  ) => void;
  readonly filters: JobSearchFilters;
  readonly getSelectedJobId: () => string | null;
  readonly markeringMutationsInFlight: { current: Set<string> };
  readonly query: string;
  readonly selectedIds: readonly string[];
  readonly resultsComplete: boolean;
  readonly scope: JobSearchScope;
  readonly selectedJob: JobListing | null;
  readonly setIsCreatingSnapshot: Dispatch<SetStateAction<boolean>>;
  readonly setIsMarkeringMutationPending: Dispatch<SetStateAction<boolean>>;
  readonly setIsSavingSearch: Dispatch<SetStateAction<boolean>>;
  readonly setMarkeringSyncState?: Dispatch<SetStateAction<MarkeringSyncState>>;
  readonly setSavedSearchMessage: Dispatch<SetStateAction<string | null>>;
  readonly setSnapshotMessage: Dispatch<SetStateAction<string | null>>;
  readonly onSnapshotCreated?: (snapshot: {
    readonly id: string;
    readonly resultCount: number;
  }) => void;
}

type MarkSelectedJobInput = Pick<
  JobSearchMutationsInput,
  | "actions"
  | "applyMarkeringResult"
  | "getSelectedJobId"
  | "markeringMutationsInFlight"
  | "selectedJob"
  | "setIsMarkeringMutationPending"
  | "setMarkeringSyncState"
  | "setSnapshotMessage"
>;

const createMarkSelectedJob =
  ({
    actions,
    applyMarkeringResult,
    getSelectedJobId,
    markeringMutationsInFlight,
    selectedJob,
    setIsMarkeringMutationPending,
    setMarkeringSyncState,
    setSnapshotMessage,
  }: MarkSelectedJobInput) =>
  async () => {
    if (!actions || !selectedJob) {
      return;
    }
    const resourceId = selectedJob.id;
    if (
      getSelectedJobId() !== resourceId ||
      markeringMutationsInFlight.current.has(resourceId)
    ) {
      return;
    }
    markeringMutationsInFlight.current.add(resourceId);
    setIsMarkeringMutationPending(true);
    setMarkeringSyncState?.("pending");
    try {
      const markering = await actions.markeerAanvraag({
        aanvraagId: resourceId,
        status: "relevant",
      });
      if (getSelectedJobId() !== resourceId) {
        return;
      }
      applyMarkeringResult(resourceId, markering);
      setMarkeringSyncState?.("commit");
    } catch (error) {
      if (getSelectedJobId() !== resourceId) {
        return;
      }
      // A transport failure can happen after the server committed. Keep the
      // open detail visibly uncertain so the bounded readback poll can settle
      // it, instead of falsely claiming a rollback.
      setMarkeringSyncState?.(
        error instanceof Error ? markeringMutationOutcome(error) : "uncertain"
      );
      setSnapshotMessage("Markeren mislukt. Probeer het opnieuw.");
    } finally {
      markeringMutationsInFlight.current.delete(resourceId);
      setIsMarkeringMutationPending(
        markeringMutationsInFlight.current.size > 0
      );
    }
  };

export const createJobSearchMutations = ({
  actions,
  applyMarkeringResult,
  filters,
  getSelectedJobId,
  markeringMutationsInFlight,
  query,
  selectedIds,
  resultsComplete,
  scope,
  selectedJob,
  setIsCreatingSnapshot,
  setIsMarkeringMutationPending,
  setIsSavingSearch,
  setMarkeringSyncState,
  setSavedSearchMessage,
  setSnapshotMessage,
  onSnapshotCreated,
}: JobSearchMutationsInput) => ({
  createSnapshot: async () => {
    if (!actions) {
      return;
    }
    if (!resultsComplete) {
      setSnapshotMessage(
        "Snapshot geblokkeerd: wacht op een volledige zoekuitkomst."
      );
      return;
    }
    // RJC-385 / CTP-393: a snapshot covers the recruiter's explicit
    // selection.
    if (selectedIds.length === 0) {
      setSnapshotMessage(
        "Geen opdrachten geselecteerd. Vink resultaten aan of kies ‘Selecteer alle matches’."
      );
      return;
    }
    if (selectedIds.length > SNAPSHOT_MAX_SELECTED_IDS) {
      setSnapshotMessage(
        `Snapshot geblokkeerd: maximaal ${SNAPSHOT_MAX_SELECTED_IDS} opdrachten per snapshot (nu ${selectedIds.length} geselecteerd).`
      );
      return;
    }
    setIsCreatingSnapshot(true);
    setSnapshotMessage(null);
    try {
      const snapshot = await actions.createSnapshot({
        filters,
        query,
        scope,
        selectedIds,
      });
      setSnapshotMessage(
        `Snapshot aangemaakt (${snapshot.resultCount} geselecteerde opdrachten).`
      );
      onSnapshotCreated?.(snapshot);
    } catch {
      setSnapshotMessage(
        "Snapshot mislukt. Controleer je sessie en probeer opnieuw."
      );
    } finally {
      setIsCreatingSnapshot(false);
    }
  },
  markSelectedJob: createMarkSelectedJob({
    actions,
    applyMarkeringResult,
    getSelectedJobId,
    markeringMutationsInFlight,
    selectedJob,
    setIsMarkeringMutationPending,
    setMarkeringSyncState,
    setSnapshotMessage,
  }),
  saveCurrentSearch: async () => {
    if (!actions) {
      return;
    }
    setIsSavingSearch(true);
    setSavedSearchMessage(null);
    try {
      const saved = await actions.createSavedSearch({
        filters,
        naam: query.trim() || "Zoekopdracht zonder term",
        query,
      });
      setSavedSearchMessage(`Opgeslagen als “${saved.naam}”.`);
    } catch {
      setSavedSearchMessage(
        "Opslaan mislukt. Controleer je sessie en probeer opnieuw."
      );
    } finally {
      setIsSavingSearch(false);
    }
  },
});
