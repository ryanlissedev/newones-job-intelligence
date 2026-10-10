import { describe, expect, it } from "bun:test";

import type { SetStateAction } from "react";

import { JOB_FIXTURES } from "./fixtures";
import { createJobSearchMutations } from "./job-search-mutations";
import {
  emptyMarkeringReadbackState,
  mergeMarkeringReadback,
} from "./markering-sync";
import { CapabilityRequestError } from "./rest/capability-client";
import type { JobIntelligenceActions, JobListing, JobMarkering } from "./types";
import { DEFAULT_JOB_SEARCH_STATE } from "./types";

const captureConcreteState =
  <Value>(
    write: (value: Value) => void
  ): ((action: SetStateAction<Value>) => void) =>
  (action) => {
    // SAFETY: createJobSearchMutations only passes concrete values to these
    // setters; this focused harness does not support React updater callbacks.
    write(action as Value);
  };

const baseActions = (
  createSavedSearch: JobIntelligenceActions["createSavedSearch"]
): JobIntelligenceActions => ({
  approveSnapshot: () =>
    Promise.reject(new Error("approveSnapshot not used in this spec")),
  commitExport: () =>
    Promise.reject(new Error("commitExport not used in this spec")),
  createSavedSearch,
  createSnapshot: () => Promise.resolve({ id: "snapshot-1", resultCount: 1 }),
  deleteSavedSearch: () => Promise.resolve(),
  getExportStatus: () =>
    Promise.reject(new Error("getExportStatus not used in this spec")),
  getSnapshot: () =>
    Promise.reject(new Error("getSnapshot not used in this spec")),
  getSnapshotApproval: () => Promise.resolve(null),
  listSavedSearches: () => Promise.resolve([]),
  markeerAanvraag: () => Promise.resolve({ reden: null, status: "relevant" }),
});

const marker = (
  revision: number,
  status: JobMarkering["status"] = "relevant"
): JobMarkering => ({
  reden: null,
  revision,
  status,
  updatedAt: `2026-09-05T00:00:0${revision}.000Z`,
});

const fixtureJobAt = (index: number): JobListing => {
  const job = JOB_FIXTURES[index];
  if (!job) {
    throw new Error(`Missing job fixture at index ${index}`);
  }
  return job;
};

const markeringMutationState = () => ({
  markeringMutationsInFlight: { current: new Set<string>() },
  setIsMarkeringMutationPending: captureConcreteState(() => {}),
});

describe("job-search mutation server truth", () => {
  it("shows saved-search success only after the server confirms persistence", async () => {
    const savedResult = Promise.withResolvers<{
      readonly id: string;
      readonly naam: string;
    }>();
    let isSaving = false;
    let savedMessage: string | null = "old message";
    const selectedJob: JobListing | null = null;
    const mutations = createJobSearchMutations({
      actions: baseActions(() => savedResult.promise),
      applyMarkeringResult: () => {},
      filters: DEFAULT_JOB_SEARCH_STATE.filters,
      getSelectedJobId: () => selectedJob?.id ?? null,
      ...markeringMutationState(),
      query: "Azure",
      resultsComplete: true,
      scope: "active",
      selectedIds: [],
      selectedJob,
      setIsCreatingSnapshot: captureConcreteState(() => {}),
      setIsSavingSearch: captureConcreteState((value) => {
        isSaving = value;
      }),
      setSavedSearchMessage: captureConcreteState((value) => {
        savedMessage = value;
      }),
      setSnapshotMessage: captureConcreteState(() => {}),
    });

    const pending = mutations.saveCurrentSearch();
    expect(isSaving).toBe(true);
    expect(savedMessage).toBeNull();

    savedResult.resolve({ id: "saved-1", naam: "Azure" });
    await pending;
    expect(savedMessage).toBe("Opgeslagen als “Azure”.");
    expect(isSaving).toBe(false);
  });

  it("keeps failure visible when saved-search or markering persistence fails", async () => {
    let savedMessage: string | null = null;
    let snapshotMessage: string | null = null;
    const selectedJob: JobListing | null = JOB_FIXTURES[0] ?? null;
    const originalSelectedJob = selectedJob;
    let isSaving = false;
    const actions: JobIntelligenceActions = {
      ...baseActions(() => Promise.reject(new Error("database unavailable"))),
      markeerAanvraag: () =>
        Promise.reject(new Error("audit transaction rolled back")),
    };
    const mutations = createJobSearchMutations({
      actions,
      applyMarkeringResult: () => {},
      filters: DEFAULT_JOB_SEARCH_STATE.filters,
      getSelectedJobId: () => selectedJob?.id ?? null,
      ...markeringMutationState(),
      query: "Azure",
      resultsComplete: true,
      scope: "active",
      selectedIds: [],
      selectedJob,
      setIsCreatingSnapshot: captureConcreteState(() => {}),
      setIsSavingSearch: captureConcreteState((value) => {
        isSaving = value;
      }),
      setSavedSearchMessage: captureConcreteState((value) => {
        savedMessage = value;
      }),
      setSnapshotMessage: captureConcreteState((value) => {
        snapshotMessage = value;
      }),
    });

    await mutations.saveCurrentSearch();
    expect(savedMessage).toBe(
      "Opslaan mislukt. Controleer je sessie en probeer opnieuw."
    );
    expect(isSaving).toBe(false);

    await mutations.markSelectedJob();
    expect(snapshotMessage).toBe("Markeren mislukt. Probeer het opnieuw.");
    expect(selectedJob).toBe(originalSelectedJob);
  });

  it("blocks snapshots for incomplete or still-refreshing results", async () => {
    let snapshotCalls = 0;
    let snapshotMessage: string | null = null;
    const actions: JobIntelligenceActions = {
      ...baseActions(() => Promise.resolve({ id: "saved-1", naam: "Azure" })),
      createSnapshot: () => {
        snapshotCalls += 1;
        return Promise.resolve({ id: "snapshot-1", resultCount: 1 });
      },
    };
    const mutations = createJobSearchMutations({
      actions,
      applyMarkeringResult: () => {},
      filters: DEFAULT_JOB_SEARCH_STATE.filters,
      getSelectedJobId: () => null,
      ...markeringMutationState(),
      query: "Azure",
      resultsComplete: false,
      scope: "active",
      selectedIds: [JOB_FIXTURES[0]?.id].filter(
        (id): id is string => id !== undefined
      ),
      selectedJob: null,
      setIsCreatingSnapshot: captureConcreteState(() => {}),
      setIsSavingSearch: captureConcreteState(() => {}),
      setSavedSearchMessage: captureConcreteState(() => {}),
      setSnapshotMessage: captureConcreteState((value) => {
        snapshotMessage = value;
      }),
    });

    await mutations.createSnapshot();

    expect(snapshotCalls).toBe(0);
    expect(snapshotMessage).toBe(
      "Snapshot geblokkeerd: wacht op een volledige zoekuitkomst."
    );
  });

  it("blocks snapshots with an empty explicit selection", async () => {
    let snapshotCalls = 0;
    let snapshotMessage: string | null = null;
    const mutations = createJobSearchMutations({
      actions: {
        ...baseActions(() => Promise.resolve({ id: "saved-1", naam: "Azure" })),
        createSnapshot: () => {
          snapshotCalls += 1;
          return Promise.resolve({ id: "snapshot-1", resultCount: 0 });
        },
      },
      applyMarkeringResult: () => {},
      filters: DEFAULT_JOB_SEARCH_STATE.filters,
      getSelectedJobId: () => null,
      ...markeringMutationState(),
      query: "Azure",
      resultsComplete: true,
      scope: "active",
      selectedIds: [],
      selectedJob: null,
      setIsCreatingSnapshot: captureConcreteState(() => {}),
      setIsSavingSearch: captureConcreteState(() => {}),
      setSavedSearchMessage: captureConcreteState(() => {}),
      setSnapshotMessage: captureConcreteState((value) => {
        snapshotMessage = value;
      }),
    });

    await mutations.createSnapshot();

    expect(snapshotCalls).toBe(0);
    expect(snapshotMessage).toBe(
      "Geen opdrachten geselecteerd. Vink resultaten aan of kies ‘Selecteer alle matches’."
    );
  });

  it("creates a snapshot for exactly the selected ids and clears them on success", async () => {
    const selectedIds = [JOB_FIXTURES[0]?.id, JOB_FIXTURES[1]?.id].filter(
      (id): id is string => id !== undefined
    );
    let snapshotInput: readonly string[] = [];
    let snapshotMessage: string | null = null;
    let snapshotCreated: { id: string; resultCount: number } | null = null;
    const mutations = createJobSearchMutations({
      actions: {
        ...baseActions(() => Promise.resolve({ id: "saved-1", naam: "Azure" })),
        createSnapshot: (input) => {
          snapshotInput = input.selectedIds;
          return Promise.resolve({ id: "snapshot-1", resultCount: 2 });
        },
      },
      applyMarkeringResult: () => {},
      filters: DEFAULT_JOB_SEARCH_STATE.filters,
      getSelectedJobId: () => null,
      ...markeringMutationState(),
      onSnapshotCreated: (snapshot) => {
        snapshotCreated = snapshot;
      },
      query: "Azure",
      resultsComplete: true,
      scope: "active",
      selectedIds,
      selectedJob: null,
      setIsCreatingSnapshot: captureConcreteState(() => {}),
      setIsSavingSearch: captureConcreteState(() => {}),
      setSavedSearchMessage: captureConcreteState(() => {}),
      setSnapshotMessage: captureConcreteState((value) => {
        snapshotMessage = value;
      }),
    });

    await mutations.createSnapshot();

    expect(snapshotInput).toEqual(selectedIds);
    // CTP-652: the callback carries the snapshot id so the toolbar can link
    // "Bekijk snapshot" to /snapshots/<id>.
    expect(snapshotCreated).toEqual({ id: "snapshot-1", resultCount: 2 });
    expect(snapshotMessage).toBe(
      "Snapshot aangemaakt (2 geselecteerde opdrachten)."
    );
  });

  it("does not restore a closed detail after a delayed markering response", async () => {
    const markResult = Promise.withResolvers<JobMarkering>();
    let selectedJob: JobListing | null = JOB_FIXTURES[0] ?? null;
    const mutations = createJobSearchMutations({
      actions: {
        ...baseActions(() => Promise.resolve({ id: "saved-1", naam: "Azure" })),
        markeerAanvraag: () => markResult.promise,
      },
      applyMarkeringResult: (resourceId, markering) => {
        if (selectedJob?.id === resourceId) {
          selectedJob = { ...selectedJob, markering };
        }
      },
      filters: DEFAULT_JOB_SEARCH_STATE.filters,
      getSelectedJobId: () => selectedJob?.id ?? null,
      ...markeringMutationState(),
      query: "Azure",
      resultsComplete: true,
      scope: "active",
      selectedIds: [],
      selectedJob,
      setIsCreatingSnapshot: captureConcreteState(() => {}),
      setIsSavingSearch: captureConcreteState(() => {}),
      setSavedSearchMessage: captureConcreteState(() => {}),
      setSnapshotMessage: captureConcreteState(() => {}),
    });

    const pending = mutations.markSelectedJob();
    selectedJob = null;
    markResult.resolve({
      reden: null,
      revision: 1,
      status: "relevant",
      updatedAt: "2026-09-05T00:00:01.000Z",
    });
    await pending;

    expect(selectedJob).toBeNull();
  });

  it("keeps a newer poll revision over an older mutation response", async () => {
    const markResult = Promise.withResolvers<JobMarkering>();
    let readback = mergeMarkeringReadback(
      emptyMarkeringReadbackState(),
      marker(2, "gevolgd"),
      "poll"
    );
    let selectedJob: JobListing | null = {
      ...fixtureJobAt(0),
      markering: readback.markering,
    };
    const mutations = createJobSearchMutations({
      actions: {
        ...baseActions(() => Promise.resolve({ id: "saved-1", naam: "Azure" })),
        markeerAanvraag: () => markResult.promise,
      },
      applyMarkeringResult: (resourceId, markering) => {
        readback = mergeMarkeringReadback(readback, markering, "mutation");
        if (selectedJob?.id === resourceId) {
          selectedJob = { ...selectedJob, markering: readback.markering };
        }
      },
      filters: DEFAULT_JOB_SEARCH_STATE.filters,
      getSelectedJobId: () => selectedJob?.id ?? null,
      ...markeringMutationState(),
      query: "Azure",
      scope: "active",
      selectedIds: [],
      selectedJob,
      setIsCreatingSnapshot: captureConcreteState(() => {}),
      setIsSavingSearch: captureConcreteState(() => {}),
      setMarkeringSyncState: captureConcreteState(() => {}),
      setSavedSearchMessage: captureConcreteState(() => {}),
      setSnapshotMessage: captureConcreteState(() => {}),
    });

    const pending = mutations.markSelectedJob();
    markResult.resolve(marker(1));
    await pending;

    expect(selectedJob?.markering).toEqual(marker(2, "gevolgd"));
  });

  it("ignores success, failure, and uncertain outcomes after selection changes", async () => {
    const firstJob = fixtureJobAt(0);
    const secondJob = fixtureJobAt(1);
    const savedSearchResult = Promise.resolve({ id: "saved-1", naam: "Azure" });

    await Promise.all(
      (["success", "failure", "uncertain"] as const).map(async (outcome) => {
        const markResult = Promise.withResolvers<JobMarkering>();
        let selectedJobId: string | null = firstJob.id;
        const applied: string[] = [];
        const syncStates: string[] = [];
        const messages: string[] = [];
        const mutations = createJobSearchMutations({
          actions: {
            ...baseActions(() => savedSearchResult),
            markeerAanvraag: () => markResult.promise,
          },
          applyMarkeringResult: (resourceId) => {
            applied.push(resourceId);
          },
          filters: DEFAULT_JOB_SEARCH_STATE.filters,
          getSelectedJobId: () => selectedJobId,
          ...markeringMutationState(),
          query: "Azure",
          scope: "active",
          selectedIds: [],
          selectedJob: firstJob,
          setIsCreatingSnapshot: captureConcreteState(() => {}),
          setIsSavingSearch: captureConcreteState(() => {}),
          setMarkeringSyncState: captureConcreteState((value) => {
            syncStates.push(value);
          }),
          setSavedSearchMessage: captureConcreteState(() => {}),
          setSnapshotMessage: captureConcreteState((value) => {
            if (value) {
              messages.push(value);
            }
          }),
        });

        const pending = mutations.markSelectedJob();
        selectedJobId = secondJob.id;
        if (outcome === "success") {
          markResult.resolve(marker(1));
        } else if (outcome === "failure") {
          markResult.reject(
            new CapabilityRequestError(403, {
              error: { code: "FORBIDDEN", message: "denied" },
            })
          );
        } else {
          markResult.reject(new TypeError("network unavailable"));
        }
        await pending;

        expect(applied, outcome).toEqual([]);
        expect(syncStates, outcome).toEqual(["pending"]);
        expect(messages, outcome).toEqual([]);
      })
    );
  });

  it("coalesces concurrent markering clicks for one selected resource", async () => {
    const selectedJob = fixtureJobAt(0);
    const markResult = Promise.withResolvers<JobMarkering>();
    let calls = 0;
    const syncStates: string[] = [];
    const mutations = createJobSearchMutations({
      actions: {
        ...baseActions(() => Promise.resolve({ id: "saved-1", naam: "Azure" })),
        markeerAanvraag: () => {
          calls += 1;
          return markResult.promise;
        },
      },
      applyMarkeringResult: () => {},
      filters: DEFAULT_JOB_SEARCH_STATE.filters,
      getSelectedJobId: () => selectedJob.id,
      ...markeringMutationState(),
      query: "Azure",
      scope: "active",
      selectedIds: [],
      selectedJob,
      setIsCreatingSnapshot: captureConcreteState(() => {}),
      setIsSavingSearch: captureConcreteState(() => {}),
      setMarkeringSyncState: captureConcreteState((value) => {
        syncStates.push(value);
      }),
      setSavedSearchMessage: captureConcreteState(() => {}),
      setSnapshotMessage: captureConcreteState(() => {}),
    });

    const first = mutations.markSelectedJob();
    const second = mutations.markSelectedJob();
    expect(calls).toBe(1);

    markResult.resolve(marker(1));
    await Promise.all([first, second]);
    expect(syncStates).toEqual(["pending", "commit"]);
  });

  it("keeps the resource locked across a poll-triggered rerender", async () => {
    const selectedJob = fixtureJobAt(0);
    const markResult = Promise.withResolvers<JobMarkering>();
    const markeringMutationsInFlight = { current: new Set<string>() };
    const mutationPendingStates: boolean[] = [];
    let calls = 0;
    const input = {
      actions: {
        ...baseActions(() => Promise.resolve({ id: "saved-1", naam: "Azure" })),
        markeerAanvraag: () => {
          calls += 1;
          return markResult.promise;
        },
      },
      applyMarkeringResult: () => {},
      filters: DEFAULT_JOB_SEARCH_STATE.filters,
      getSelectedJobId: () => selectedJob.id,
      markeringMutationsInFlight,
      query: "Azure",
      scope: "active" as const,
      selectedIds: [],
      selectedJob,
      setIsCreatingSnapshot: captureConcreteState(() => {}),
      setIsMarkeringMutationPending: captureConcreteState((value) => {
        mutationPendingStates.push(value);
      }),
      setIsSavingSearch: captureConcreteState(() => {}),
      setMarkeringSyncState: captureConcreteState(() => {}),
      setSavedSearchMessage: captureConcreteState(() => {}),
      setSnapshotMessage: captureConcreteState(() => {}),
    };

    const beforePollRerender = createJobSearchMutations(input);
    const first = beforePollRerender.markSelectedJob();

    // A poll can update sync state and rerender while the POST is unresolved.
    // The new callback must retain the resource lock from the prior render.
    const afterPollRerender = createJobSearchMutations(input);
    const attemptedSecond = afterPollRerender.markSelectedJob();
    expect(calls).toBe(1);
    expect(markeringMutationsInFlight.current.has(selectedJob.id)).toBe(true);

    markResult.resolve(marker(1));
    await Promise.all([first, attemptedSecond]);

    expect(mutationPendingStates).toEqual([true, false]);
    expect(markeringMutationsInFlight.current.size).toBe(0);
  });
});
