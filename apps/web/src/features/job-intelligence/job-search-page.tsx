"use client";

import { Drawer, DrawerContent } from "@ji/ui/components/drawer";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { CapabilityDiscovery } from "./capability-discovery";
import { fixtureJobDataAdapter } from "./fixtures";
import { JobActiveFilters } from "./job-active-filters";
import { JobDetail } from "./job-detail";
import { countActiveJobFilters, JobFilters } from "./job-filters";
import { JobResults } from "./job-results";
import { JobResultsMap } from "./job-results-map";
import { JobSavedSearches } from "./job-saved-searches";
import { createJobSearchMutations } from "./job-search-mutations";
import { JobSearchQueryBar } from "./job-search-query-bar";
import {
  JobEmptyState,
  JobEngineErrorState,
  JobIncompleteState,
  JobIncompleteWarning,
  JobLoadingState,
  JobSyntaxErrorState,
} from "./job-search-states";
import { JobSearchToolbar } from "./job-search-toolbar";
import { JobSelectionBar } from "./job-selection-bar";
import {
  emptyMarkeringReadbackState,
  hasNewerMarkering,
  mergeMarkeringReadback,
  startMarkeringPolling,
} from "./markering-sync";
import type {
  MarkeringReadbackSource,
  MarkeringReadbackState,
} from "./markering-sync";
import { validateBooleanPreview } from "./presentation";
import type { CapabilityDiscoveryDocument } from "./rest-job-data-adapter";
import {
  readStoredJobPageSize,
  readStoredResultsViewMode,
  writeStoredJobPageSize,
  writeStoredResultsViewMode,
} from "./results-prefs";
import { JobResultsToolbar } from "./results-toolbar";
import { runAsync } from "./run-async";
import {
  parseJobSearchState,
  resetJobSearchState,
  serializeJobSearchState,
  toggleSearchFilter,
  withResetPage,
} from "./search-state";
import {
  deselectPageIds,
  isPageFullySelected,
  selectAllMatchesPlan,
  selectPageIds,
  tooManyMatchesMessage,
  toggleSelectedId,
} from "./snapshot-selection";
import type {
  JobContractType,
  JobDataAdapter,
  JobIntelligenceActions,
  JobListing,
  JobQueryScope,
  JobSearchFilters,
  JobSearchResponse,
  JobSearchState,
  JobSource,
  JobSourceOption,
  JobWerkvorm,
  MarkeringSyncState,
  PreviewStatus,
  ResultsViewMode,
  SavedSearchSummary,
} from "./types";
import { JOB_PAGE_SIZE } from "./types";

const MARKERING_POLL_INTERVAL_MS = 5000;

const resolveDisplayStatus = (
  syntaxError: string | null,
  responseStatus: PreviewStatus
): PreviewStatus => (syntaxError ? "syntax-error" : responseStatus);

interface ManagedDialogProps {
  readonly children: React.ReactNode;
  readonly className: string;
  readonly descriptionId: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly titleId: string;
}

const ManagedDialog = ({
  children,
  className,
  descriptionId,
  onClose,
  open,
  titleId,
}: ManagedDialogProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isProgrammaticClose = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      isProgrammaticClose.current = false;
      dialog.showModal();
      return;
    }
    if (!open && dialog.open) {
      isProgrammaticClose.current = true;
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onClose={() => {
        if (isProgrammaticClose.current) {
          isProgrammaticClose.current = false;
          return;
        }
        onClose();
      }}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={`ji-dialog ${className}`}
    >
      {children}
    </dialog>
  );
};

const canonicalSearchRequest = (state: JobSearchState): string => {
  const params = serializeJobSearchState({
    ...state,
    selectedJobId: null,
  });
  return params.toString();
};

const countActiveFilters = (filters: JobSearchFilters): number =>
  countActiveJobFilters(filters);

const buildJobsUrl = (state: JobSearchState): string => {
  const params = serializeJobSearchState(state).toString();
  return params ? `/jobs?${params}` : "/jobs";
};

const jobSelectionHistoryMode = (
  currentJobId: string | null,
  nextJobId: string
): "push" | "replace" => (currentJobId === nextJobId ? "replace" : "push");

const resultCountLabel = (total: number): "opdracht" | "opdrachten" =>
  total === 1 ? "opdracht" : "opdrachten";

interface MutableValue<Value> {
  current: Value;
}

const readValue = <Value,>(ref: MutableValue<Value>): Value => ref.current;

const useApplyMarkeringReadback = (
  selectedJobIdRef: MutableValue<string | null>,
  lastAppliedMarkering: MutableValue<MarkeringReadbackState>,
  setSelectedJob: Dispatch<SetStateAction<JobListing | null>>,
  setResponse: Dispatch<SetStateAction<JobSearchResponse>>
) =>
  useCallback(
    (
      resourceId: string,
      markering: JobListing["markering"],
      source: MarkeringReadbackSource
    ): boolean => {
      if (selectedJobIdRef.current !== resourceId) {
        return false;
      }
      const merged = mergeMarkeringReadback(
        lastAppliedMarkering.current,
        markering ?? null,
        source
      );
      if (merged === lastAppliedMarkering.current) {
        return false;
      }
      lastAppliedMarkering.current = merged;
      const nextMarkering = merged.markering;
      setSelectedJob((current) =>
        current?.id === resourceId
          ? { ...current, markering: nextMarkering }
          : current
      );
      setResponse((current) => ({
        ...current,
        items: current.items.map((job) =>
          job.id === resourceId &&
          hasNewerMarkering(job.markering, nextMarkering)
            ? { ...job, markering: nextMarkering }
            : job
        ),
      }));
      return true;
    },
    [lastAppliedMarkering, selectedJobIdRef, setResponse, setSelectedJob]
  );

// RJC-378: totalPages is capped by the engine's retrievable window, so when
// the true total reaches past the last page the user is told to refine
// rather than left wondering where the rest went.
const pageLabel = (response: JobSearchResponse): string => {
  const base = `Pagina ${response.page} van ${response.totalPages}`;
  const beyondWindow = response.totalPages * response.pageSize < response.total;
  return beyondWindow
    ? `${base} — verfijn je zoekopdracht om de overige resultaten te zien`
    : base;
};

const emptyResponse = (
  status: "engine-error" | "loading"
): JobSearchResponse => ({
  archiveTotal: null,
  complete: false,
  facets: { contractTypes: [], locations: [], sources: [], status: [] },
  items: [],
  message:
    status === "engine-error"
      ? "De zoekmachine reageert niet. Probeer het over een moment opnieuw."
      : "Vacatures worden geladen…",
  page: 1,
  pageSize: 0,
  status,
  total: 0,
  totalPages: 1,
});

interface JobResultsPanelProps {
  readonly displayStatus: PreviewStatus;
  readonly isRefreshing: boolean;
  readonly onReset: () => void;
  readonly onRetryEngine: () => void;
  readonly onRetryIncomplete: () => void;
  readonly onSelect: (job: JobListing, trigger: HTMLButtonElement) => void;
  readonly onTogglePage: () => void;
  readonly onToggleRow: (id: string) => void;
  readonly pageFullySelected: boolean;
  readonly response: JobSearchResponse;
  readonly selectedJobId: string | null;
  readonly selectedIds: ReadonlySet<string>;
  readonly syntaxError: string | null;
  readonly viewMode: ResultsViewMode;
}

const IncompleteEmptyResult = ({
  complete,
  displayStatus,
  onRetry,
}: {
  readonly complete: boolean;
  readonly displayStatus: PreviewStatus;
  readonly onRetry: () => void;
}) => {
  if (complete || displayStatus !== "empty") {
    return null;
  }
  return <JobIncompleteState onRetry={onRetry} />;
};

const IncompleteResultWarning = ({
  complete,
  onRetry,
}: {
  readonly complete: boolean;
  readonly onRetry: () => void;
}) => {
  if (complete) {
    return null;
  }
  return <JobIncompleteWarning onRetry={onRetry} />;
};

const JobResultsPanel = ({
  displayStatus,
  isRefreshing,
  onReset,
  onRetryEngine,
  onRetryIncomplete,
  onSelect,
  onTogglePage,
  onToggleRow,
  pageFullySelected,
  response,
  selectedJobId,
  selectedIds,
  syntaxError,
  viewMode,
}: JobResultsPanelProps) => (
  <section
    aria-label="Zoekresultaten"
    className="relative min-w-0 overflow-hidden rounded-lg border border-border bg-card"
  >
    {isRefreshing ? (
      <div
        className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-primary"
        aria-hidden="true"
      />
    ) : null}
    {displayStatus === "loading" ? <JobLoadingState /> : null}
    {displayStatus === "syntax-error" ? (
      <JobSyntaxErrorState
        message={
          syntaxError ??
          response.message ??
          "Controleer de Boolean-syntax en probeer opnieuw."
        }
        onReset={onReset}
      />
    ) : null}
    {displayStatus === "engine-error" ? (
      <JobEngineErrorState onRetry={onRetryEngine} />
    ) : null}
    <IncompleteEmptyResult
      complete={response.complete}
      displayStatus={displayStatus}
      onRetry={onRetryIncomplete}
    />
    {response.complete && displayStatus === "empty" ? (
      <JobEmptyState onReset={onReset} />
    ) : null}
    {displayStatus === "ready" ? (
      <>
        <IncompleteResultWarning
          complete={response.complete}
          onRetry={onRetryIncomplete}
        />
        {viewMode === "map" ? (
          <JobResultsMap
            jobs={response.items}
            selectedJobId={selectedJobId}
            onSelect={onSelect}
          />
        ) : (
          <JobResults
            jobs={response.items}
            onTogglePage={onTogglePage}
            onToggleRow={onToggleRow}
            pageFullySelected={pageFullySelected}
            selectedJobId={selectedJobId}
            selectedIds={selectedIds}
            onSelect={onSelect}
          />
        )}
      </>
    ) : null}
  </section>
);

interface JobSearchPageProps {
  readonly actions?: JobIntelligenceActions;
  readonly adapter?: JobDataAdapter;
  readonly loadCapabilityDiscovery?: () => Promise<CapabilityDiscoveryDocument>;
  readonly liveData?: boolean;
}

const CapabilityDiscoveryEntry = ({
  load,
}: {
  readonly load?: () => Promise<CapabilityDiscoveryDocument>;
}) =>
  load ? (
    <div className="flex justify-end">
      <CapabilityDiscovery load={load} />
    </div>
  ) : null;

const JobSearchPageContent = ({
  actions,
  adapter,
  loadCapabilityDiscovery,
  liveData = false,
}: {
  readonly actions?: JobIntelligenceActions;
  readonly adapter: JobDataAdapter;
  readonly loadCapabilityDiscovery?: () => Promise<CapabilityDiscoveryDocument>;
  readonly liveData: boolean;
}) => {
  const searchParams = useSearchParams();
  const state = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    const parsed = parseJobSearchState(params);
    const hasExplicitPageSize = params.has("perPage") || params.has("pageSize");
    if (hasExplicitPageSize) {
      return parsed;
    }
    return { ...parsed, pageSize: readStoredJobPageSize() };
  }, [searchParams]);
  const [viewMode, setViewMode] = useState<ResultsViewMode>(() =>
    readStoredResultsViewMode()
  );
  const requestKey = canonicalSearchRequest(state);
  const selectionScopeKey = canonicalSearchRequest({
    ...state,
    page: 1,
    pageSize: JOB_PAGE_SIZE,
  });
  const searchRequest = useMemo(
    () => parseJobSearchState(new URLSearchParams(requestKey)),
    [requestKey]
  );
  const [response, setResponse] = useState<JobSearchResponse>(() =>
    emptyResponse("loading")
  );
  const [responseRequestKey, setResponseRequestKey] = useState<string | null>(
    null
  );
  const [selectedJob, setSelectedJob] = useState<JobListing | null>(null);
  const [queryDraft, setQueryDraft] = useState(state.query);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [activeSavedSearchId, setActiveSavedSearchId] = useState<string | null>(
    null
  );
  const [savedSearchRefreshKey, setSavedSearchRefreshKey] = useState(0);
  const [savedSearchMessage, setSavedSearchMessage] = useState<string | null>(
    null
  );
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null);
  const [createdSnapshotId, setCreatedSnapshotId] = useState<string | null>(
    null
  );
  const [isSavingSearch, setIsSavingSearch] = useState(false);
  const [isCreatingSnapshot, setIsCreatingSnapshot] = useState(false);
  const [isSelectingAll, setIsSelectingAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const latestRequestKey = useRef(requestKey);
  const [isMarkeringMutationPending, setIsMarkeringMutationPending] =
    useState(false);
  const [markeringSyncState, setMarkeringSyncState] =
    useState<MarkeringSyncState>("idle");
  const [sources, setSources] = useState<readonly JobSourceOption[]>([]);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  latestRequestKey.current = requestKey;
  useEffect(() => {
    setSelectedIds(new Set());
  }, [selectionScopeKey]);
  useEffect(() => {
    writeStoredJobPageSize(state.pageSize);
  }, [state.pageSize]);

  const lastAppliedMarkering = useRef(emptyMarkeringReadbackState());
  const selectedJobIdRef = useRef<string | null>(state.selectedJobId);
  const markeringMutationsInFlight = useRef(new Set<string>());
  selectedJobIdRef.current = state.selectedJobId;
  const applyMarkeringReadback = useApplyMarkeringReadback(
    selectedJobIdRef,
    lastAppliedMarkering,
    setSelectedJob,
    setResponse
  );

  useEffect(() => {
    setQueryDraft(state.query);
  }, [state.query]);

  // RJC-368: the bron filter list comes from the live catalog, loaded once
  // and independent of the current search's facet counts, so it doesn't
  // flash empty or shrink when a query returns zero hits.
  useEffect(() => {
    let isCurrent = true;
    const loadSources = async () => {
      try {
        const nextSources = await adapter.listSources();
        if (isCurrent) {
          setSources(nextSources);
        }
      } catch {
        if (isCurrent) {
          setSources([]);
        }
      }
    };
    void loadSources();
    return () => {
      isCurrent = false;
    };
  }, [adapter]);

  useEffect(() => {
    let isCurrent = true;
    setIsRefreshing(true);

    const loadResults = async () => {
      try {
        const nextResponse = await adapter.search(searchRequest);
        if (isCurrent) {
          setResponse(nextResponse);
          setResponseRequestKey(requestKey);
        }
      } catch {
        if (isCurrent) {
          setResponse(emptyResponse("engine-error"));
          setResponseRequestKey(requestKey);
        }
      } finally {
        if (isCurrent) {
          setIsRefreshing(false);
        }
      }
    };

    void loadResults();
    return () => {
      isCurrent = false;
    };
  }, [adapter, requestKey, searchRequest, retryNonce]);

  useEffect(() => {
    let isCurrent = true;
    const { selectedJobId } = state;
    setMarkeringSyncState("idle");
    if (!selectedJobId) {
      setSelectedJob(null);
      return;
    }
    setSelectedJob(null);

    const loadSelectedJob = async () => {
      try {
        const job = await adapter.getById(selectedJobId);
        if (isCurrent) {
          const merged = job
            ? mergeMarkeringReadback(
                lastAppliedMarkering.current,
                job.markering ?? null,
                "detail"
              )
            : lastAppliedMarkering.current;
          lastAppliedMarkering.current = merged;
          setSelectedJob(job ? { ...job, markering: merged.markering } : null);
        }
      } catch {
        if (isCurrent) {
          setSelectedJob(null);
          setResponse(emptyResponse("engine-error"));
        }
      }
    };

    void loadSelectedJob();
    return () => {
      isCurrent = false;
    };
  }, [adapter, state.selectedJobId]);

  useEffect(() => {
    const { selectedJobId } = state;
    const { getMarkering } = adapter;
    if (!selectedJobId || !getMarkering) {
      return;
    }

    lastAppliedMarkering.current = emptyMarkeringReadbackState();
    const applyMarkering = (markering: JobListing["markering"]) => {
      if (!applyMarkeringReadback(selectedJobId, markering, "poll")) {
        return;
      }
      if (lastAppliedMarkering.current.markering) {
        setMarkeringSyncState("commit");
      }
    };
    return startMarkeringPolling({
      getMarkering,
      intervalMs: MARKERING_POLL_INTERVAL_MS,
      onMarkering: applyMarkering,
      resourceId: selectedJobId,
    });
  }, [adapter, applyMarkeringReadback, state.selectedJobId]);

  const writeState = (
    nextState: JobSearchState,
    mode: "push" | "replace" = "replace"
  ) => {
    const url = buildJobsUrl(nextState);
    if (mode === "push") {
      window.history.pushState(null, "", url);
      return;
    }
    window.history.replaceState(null, "", url);
  };

  const updateFilters = (filters: JobSearchFilters) => {
    writeState(
      withResetPage(state, {
        filters,
        previewStatus: "ready",
        selectedJobId: null,
      })
    );
  };

  const clearFilters = () => {
    writeState(
      withResetPage(state, {
        filters: { ...resetJobSearchState().filters },
        previewStatus: "ready",
        selectedJobId: null,
      }),
      "push"
    );
    setActiveSavedSearchId(null);
  };

  const clearEverything = () => {
    setQueryDraft("");
    setActiveSavedSearchId(null);
    writeState(resetJobSearchState(), "push");
  };

  const clearQuery = () => {
    setQueryDraft("");
    writeState(
      withResetPage(state, {
        previewStatus: "ready",
        query: "",
        selectedJobId: null,
      }),
      "push"
    );
  };

  const submitSearch = (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    writeState(
      withResetPage(state, {
        previewStatus: "ready",
        query: queryDraft.trim(),
        selectedJobId: null,
      }),
      "push"
    );
  };

  const openJob = (job: JobListing, trigger: HTMLButtonElement) => {
    detailTriggerRef.current = trigger;
    writeState(
      { ...state, selectedJobId: job.id },
      jobSelectionHistoryMode(state.selectedJobId, job.id)
    );
  };

  const closeJob = () => {
    writeState({ ...state, selectedJobId: null });
  };

  // Live mode must still validate Boolean syntax client-side; skipping sends
  // malformed queries to the engine and shows engine-error instead of syntax-error.
  const syntaxError = validateBooleanPreview(state.query);
  const displayStatus = resolveDisplayStatus(syntaxError, response.status);
  const activeFilterCount = countActiveFilters(state.filters);
  const countLabel = resultCountLabel(response.total);
  const pageIds = response.items.map((job) => job.id);
  const pageFullySelected = isPageFullySelected(selectedIds, pageIds);
  const toggleRow = (id: string) => {
    setSelectedIds((current) => toggleSelectedId(current, id));
  };
  const togglePage = () => {
    if (pageFullySelected) {
      setSelectedIds((current) => deselectPageIds(current, pageIds));
      return;
    }
    const result = selectPageIds(selectedIds, pageIds);
    if (result.kind === "too-many") {
      setSnapshotMessage(
        `Selectie geblokkeerd: samen ${result.total} opdrachten, maximaal ${result.max} per snapshot.`
      );
      return;
    }
    setSelectedIds(result.selected);
  };
  const clearSelection = () => {
    setSelectedIds(new Set());
  };
  const selectAllMatches = async () => {
    const plan = selectAllMatchesPlan(response.total);
    if (plan.kind === "empty") {
      return;
    }
    if (plan.kind === "too-many") {
      setSnapshotMessage(tooManyMatchesMessage(plan.total));
      return;
    }
    setIsSelectingAll(true);
    try {
      const allMatches = await adapter.search({
        ...searchRequest,
        page: 1,
        pageSize: plan.pageSize,
      });
      if (latestRequestKey.current !== requestKey) {
        return;
      }
      setSelectedIds(new Set(allMatches.items.map((job) => job.id)));
      setSnapshotMessage(
        `Alle ${allMatches.items.length.toLocaleString("nl-NL")} matches geselecteerd.`
      );
    } catch {
      if (latestRequestKey.current === requestKey) {
        setSnapshotMessage(
          "Selecteren van alle matches mislukt. Probeer het opnieuw."
        );
      }
    } finally {
      setIsSelectingAll(false);
    }
  };
  const canCreateSnapshot =
    response.complete && !isRefreshing && responseRequestKey === requestKey;
  const gridColumns = "min-[800px]:grid-cols-[280px_minmax(0,1fr)]";

  const { createSnapshot, markSelectedJob, saveCurrentSearch } =
    createJobSearchMutations({
      actions,
      applyMarkeringResult: (resourceId, markering) => {
        applyMarkeringReadback(resourceId, markering, "mutation");
      },
      filters: state.filters,
      getSelectedJobId: () => readValue(selectedJobIdRef),
      markeringMutationsInFlight,
      onSnapshotCreated: (snapshot) => {
        clearSelection();
        setCreatedSnapshotId(snapshot.id);
      },
      query: state.query,
      resultsComplete: canCreateSnapshot,
      scope: state.scope,
      selectedIds: [...selectedIds],
      selectedJob,
      setIsCreatingSnapshot,
      setIsMarkeringMutationPending,
      setIsSavingSearch,
      setMarkeringSyncState,
      setSavedSearchMessage,
      setSnapshotMessage,
    });

  const filterProps = {
    facets: response.facets,
    filters: state.filters,
    onClear: clearFilters,
    onContractToggle: (value: JobContractType) =>
      updateFilters({
        ...state.filters,
        contractTypes: toggleSearchFilter(state.filters.contractTypes, value),
      }),
    onContractTypesChange: (values: readonly JobContractType[]) =>
      updateFilters({ ...state.filters, contractTypes: [...values] }),
    onFreshnessChange: (value: JobSearchFilters["freshness"]) =>
      updateFilters({ ...state.filters, freshness: value }),
    onHoursRangeChange: (min: number | null, max: number | null) =>
      updateFilters({
        ...state.filters,
        urenPerWeekMax: max,
        urenPerWeekMin: min,
      }),
    onLocationToggle: (value: string) =>
      updateFilters({
        ...state.filters,
        locations: toggleSearchFilter(state.filters.locations, value),
      }),
    onLocationsChange: (values: readonly string[]) =>
      updateFilters({ ...state.filters, locations: [...values] }),
    onPostedRangeChange: (from: string | null, to: string | null) =>
      updateFilters({
        ...state.filters,
        publicatiedatumTot: to,
        publicatiedatumVanaf: from,
      }),
    onProvinceToggle: (value: string) =>
      updateFilters({
        ...state.filters,
        provincies: toggleSearchFilter(state.filters.provincies, value),
      }),
    onProvincesChange: (values: readonly string[]) =>
      updateFilters({ ...state.filters, provincies: [...values] }),
    onRateRangeChange: (min: number | null, max: number | null) =>
      updateFilters({
        ...state.filters,
        maxRate: max,
        minRate: min,
      }),
    onSkillToggle: (value: string) =>
      updateFilters({
        ...state.filters,
        skills: toggleSearchFilter(state.filters.skills, value),
      }),
    onSourceToggle: (value: JobSource) =>
      updateFilters({
        ...state.filters,
        sources: toggleSearchFilter(state.filters.sources, value),
      }),
    onSourcesChange: (values: readonly JobSource[]) =>
      updateFilters({ ...state.filters, sources: [...values] }),
    onStatusChange: (values: readonly JobSearchFilters["status"][number][]) =>
      updateFilters({ ...state.filters, status: [...values] }),
    onStatusToggle: (value: JobSearchFilters["status"][number]) =>
      updateFilters({
        ...state.filters,
        status: toggleSearchFilter(state.filters.status, value),
      }),
    onWerkvormToggle: (value: JobWerkvorm) =>
      updateFilters({
        ...state.filters,
        werkvormen: toggleSearchFilter(state.filters.werkvormen, value),
      }),
    onWerkvormenChange: (values: readonly JobWerkvorm[]) =>
      updateFilters({ ...state.filters, werkvormen: [...values] }),
    sources,
  };

  const onQueryScopeChange = (queryScope: JobQueryScope) =>
    updateFilters({ ...state.filters, queryScope });

  return (
    <main
      id="main-content"
      className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 lg:px-8"
    >
      <CapabilityDiscoveryEntry load={loadCapabilityDiscovery} />
      <JobSearchToolbar
        actions={actions}
        isCreatingSnapshot={isCreatingSnapshot}
        isSavingSearch={isSavingSearch}
        liveData={liveData}
        canCreateSnapshot={canCreateSnapshot}
        onCreateSnapshot={createSnapshot}
        onPreviewStatusChange={(previewStatus) =>
          writeState({
            ...state,
            previewStatus,
            selectedJobId: null,
          })
        }
        onSaveSearch={async () => {
          await saveCurrentSearch();
          setSavedSearchRefreshKey((value) => value + 1);
        }}
        previewStatus={state.previewStatus}
        savedSearchMessage={savedSearchMessage}
        snapshotId={createdSnapshotId}
        snapshotMessage={snapshotMessage}
        selectionCount={selectedIds.size}
      />

      <div className={`grid items-start gap-6 ${gridColumns}`}>
        <aside className="hidden min-[800px]:block min-[800px]:sticky min-[800px]:top-20 min-[800px]:max-h-[calc(100dvh-6rem)] min-[800px]:overflow-y-auto min-[800px]:pr-2">
          <div className="px-0 pb-2">
            <JobSavedSearches
              actions={actions}
              activeId={activeSavedSearchId}
              canSave={
                Boolean(state.query.trim()) ||
                countActiveJobFilters(state.filters) > 0
              }
              filters={state.filters}
              isSaving={isSavingSearch}
              query={state.query}
              refreshKey={savedSearchRefreshKey}
              onApply={(saved: SavedSearchSummary) => {
                setQueryDraft(saved.query);
                setActiveSavedSearchId(saved.id);
                writeState(
                  withResetPage(state, {
                    filters: saved.filters,
                    previewStatus: "ready",
                    query: saved.query,
                    selectedJobId: null,
                  }),
                  "push"
                );
              }}
              onSaved={(saved) => {
                setActiveSavedSearchId(saved.id);
                setSavedSearchMessage(`Opgeslagen als “${saved.naam}”.`);
                setSavedSearchRefreshKey((value) => value + 1);
              }}
            />
          </div>
          <JobFilters {...filterProps} />
        </aside>

        <div className="min-w-0 space-y-3">
          <JobSearchQueryBar
            activeFilterCount={activeFilterCount}
            archiveTotal={response.archiveTotal}
            countLabel={countLabel}
            isRefreshing={isRefreshing}
            onClearQueryDraft={() => setQueryDraft("")}
            onOpenFilters={() => setFiltersOpen(true)}
            onQueryDraftChange={setQueryDraft}
            onQueryScopeChange={onQueryScopeChange}
            onResetQueryDraft={() => setQueryDraft(state.query)}
            onScopeChange={(scope) =>
              writeState(withResetPage(state, { scope, selectedJobId: null }))
            }
            onSortChange={(sort) =>
              writeState(withResetPage(state, { selectedJobId: null, sort }))
            }
            onSubmit={submitSearch}
            onViewModeChange={(nextViewMode) => {
              writeStoredResultsViewMode(nextViewMode);
              setViewMode(nextViewMode);
            }}
            queryDraft={queryDraft}
            queryScope={state.filters.queryScope}
            scope={state.scope}
            sort={state.sort}
            syntaxError={syntaxError}
            total={response.total}
            viewMode={viewMode}
          />

          <JobActiveFilters
            filters={state.filters}
            onClearAll={clearFilters}
            onContractToggle={filterProps.onContractToggle}
            onFreshnessChange={filterProps.onFreshnessChange}
            onHoursRangeChange={filterProps.onHoursRangeChange}
            onLocationToggle={filterProps.onLocationToggle}
            onPostedRangeChange={filterProps.onPostedRangeChange}
            onProvinceToggle={filterProps.onProvinceToggle}
            onQueryClear={clearQuery}
            onQueryScopeChange={onQueryScopeChange}
            onRateRangeChange={filterProps.onRateRangeChange}
            onSkillToggle={filterProps.onSkillToggle}
            onSourceToggle={filterProps.onSourceToggle}
            onStatusToggle={filterProps.onStatusToggle}
            onWerkvormToggle={filterProps.onWerkvormToggle}
            query={state.query}
            sources={sources}
          />

          {displayStatus === "ready" || displayStatus === "loading" ? (
            <JobResultsToolbar
              pageSize={state.pageSize}
              total={response.total}
              onPageSizeChange={(nextPageSize) => {
                writeStoredJobPageSize(nextPageSize);
                writeState(
                  withResetPage(state, {
                    pageSize: nextPageSize,
                    selectedJobId: null,
                  })
                );
              }}
            />
          ) : null}

          {displayStatus === "ready" ? (
            <JobSelectionBar
              count={selectedIds.size}
              isSelectingAll={isSelectingAll}
              onClear={clearSelection}
              onSelectAll={() => {
                void selectAllMatches();
              }}
              responseComplete={response.complete}
              total={response.total}
            />
          ) : null}

          <JobResultsPanel
            displayStatus={displayStatus}
            isRefreshing={isRefreshing}
            onReset={clearEverything}
            onRetryEngine={() => {
              writeState({ ...state, previewStatus: "ready" });
              setRetryNonce((value) => value + 1);
            }}
            onRetryIncomplete={() => setRetryNonce((value) => value + 1)}
            onSelect={openJob}
            onTogglePage={togglePage}
            onToggleRow={toggleRow}
            pageFullySelected={pageFullySelected}
            response={response}
            selectedJobId={state.selectedJobId}
            selectedIds={selectedIds}
            syntaxError={syntaxError}
            viewMode={viewMode}
          />

          {displayStatus === "ready" ? (
            <div className="flex items-center justify-between gap-4">
              <button
                type="button"
                disabled={response.page <= 1}
                onClick={() =>
                  writeState({
                    ...state,
                    page: Math.max(1, response.page - 1),
                    selectedJobId: null,
                  })
                }
                aria-label="Vorige pagina"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft aria-hidden="true" className="size-3.5" />
                Vorige
              </button>
              <p className="text-center font-mono text-[11px] text-muted-foreground tabular-nums">
                {pageLabel(response)}
              </p>
              <button
                type="button"
                disabled={response.page >= response.totalPages}
                onClick={() =>
                  writeState({
                    ...state,
                    page: Math.min(response.totalPages, response.page + 1),
                    selectedJobId: null,
                  })
                }
                aria-label="Volgende pagina"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
              >
                Volgende
                <ChevronRight aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <ManagedDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        titleId="mobile-filters-title"
        descriptionId="mobile-filters-description"
        className="inset-x-0 top-auto bottom-0 m-0 max-h-[90dvh] w-full max-w-none rounded-t-lg border border-border bg-card p-0 text-foreground"
      >
        <div className="flex min-h-16 items-center gap-3 border-b border-border px-4">
          <div className="min-w-0 flex-1">
            <h2
              id="mobile-filters-title"
              className="font-display text-base font-semibold"
            >
              Resultaten verfijnen
            </h2>
            <p
              id="mobile-filters-description"
              className="mt-0.5 text-xs text-muted-foreground"
            >
              Filters worden direct in de deelbare URL opgeslagen.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen(false)}
            aria-label="Filters sluiten"
            className="grid size-11 shrink-0 place-items-center rounded-md border border-input outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="max-h-[calc(90dvh-8rem)] overflow-y-auto overscroll-contain px-4 pt-3">
          <JobSavedSearches
            actions={actions}
            activeId={activeSavedSearchId}
            canSave={
              Boolean(state.query.trim()) ||
              countActiveJobFilters(state.filters) > 0
            }
            filters={state.filters}
            isSaving={isSavingSearch}
            query={state.query}
            refreshKey={savedSearchRefreshKey}
            onApply={(saved: SavedSearchSummary) => {
              setQueryDraft(saved.query);
              setActiveSavedSearchId(saved.id);
              writeState(
                withResetPage(state, {
                  filters: saved.filters,
                  previewStatus: "ready",
                  query: saved.query,
                  selectedJobId: null,
                }),
                "push"
              );
              setFiltersOpen(false);
            }}
            onSaved={(saved) => {
              setActiveSavedSearchId(saved.id);
              setSavedSearchMessage(`Opgeslagen als “${saved.naam}”.`);
              setSavedSearchRefreshKey((value) => value + 1);
            }}
          />
          <JobFilters {...filterProps} />
        </div>
        <div className="sticky bottom-0 border-t border-border bg-card p-3">
          <button
            type="button"
            onClick={() => setFiltersOpen(false)}
            className="min-h-12 w-full rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            Toon {response.total} {countLabel}
          </button>
        </div>
      </ManagedDialog>

      <Drawer
        open={Boolean(selectedJob)}
        onOpenChange={(open) => {
          if (!open) {
            closeJob();
          }
        }}
        swipeDirection="right"
      >
        <DrawerContent
          aria-labelledby="overlay-job-detail-title"
          aria-describedby="overlay-job-detail-description"
          className="h-dvh w-[40vw] min-w-[32rem] max-w-[44rem] border-l border-border bg-card p-0 text-foreground max-[799px]:w-full max-[799px]:min-w-0 max-[799px]:max-w-none"
          finalFocus={detailTriggerRef}
        >
          {selectedJob ? (
            <JobDetail
              job={selectedJob}
              liveData={liveData}
              markering={selectedJob.markering ?? null}
              isMarkeringMutationPending={isMarkeringMutationPending}
              markeringSyncState={markeringSyncState}
              onClose={closeJob}
              onMarkeer={actions ? () => runAsync(markSelectedJob) : undefined}
              titleId="overlay-job-detail-title"
              descriptionId="overlay-job-detail-description"
            />
          ) : null}
        </DrawerContent>
      </Drawer>
    </main>
  );
};

export const JobSearchPage = ({
  actions,
  adapter = fixtureJobDataAdapter,
  loadCapabilityDiscovery,
  liveData = false,
}: JobSearchPageProps) => (
  <JobSearchPageContent
    actions={actions}
    adapter={adapter}
    loadCapabilityDiscovery={loadCapabilityDiscovery}
    liveData={liveData}
  />
);
