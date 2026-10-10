"use client";

import {
  List,
  Loader2,
  Map as MapIcon,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { queryScopeLabels, sortLabels } from "./presentation";
import type { JobQueryScope, JobSearchState, ResultsViewMode } from "./types";
import {
  ENRICHED_SEARCH_DATA_AVAILABLE,
  JOB_QUERY_SCOPES,
  selectableJobSortOptions,
} from "./types";

const sortOptions = selectableJobSortOptions(ENRICHED_SEARCH_DATA_AVAILABLE);

const isJobSort = (value: string): value is JobSearchState["sort"] =>
  sortOptions.some((candidate) => candidate === value);

const isJobQueryScope = (value: string): value is JobQueryScope =>
  JOB_QUERY_SCOPES.some((candidate) => candidate === value);

const selectClass =
  "h-12 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface JobSearchQueryBarProps {
  readonly activeFilterCount: number;
  /** "N in archief" next to an active-scope count; null when the archive is already included. */
  readonly archiveTotal: number | null;
  readonly countLabel: "opdracht" | "opdrachten";
  readonly isRefreshing: boolean;
  readonly onClearQueryDraft: () => void;
  readonly onOpenFilters: () => void;
  readonly onQueryDraftChange: (value: string) => void;
  readonly onResetQueryDraft: () => void;
  readonly onQueryScopeChange: (scope: JobQueryScope) => void;
  readonly onScopeChange: (scope: JobSearchState["scope"]) => void;
  readonly onSortChange: (sort: JobSearchState["sort"]) => void;
  readonly onSubmit: (event?: React.FormEvent<HTMLFormElement>) => void;
  readonly onViewModeChange: (viewMode: ResultsViewMode) => void;
  readonly queryDraft: string;
  readonly queryScope: JobQueryScope;
  readonly scope: JobSearchState["scope"];
  readonly sort: JobSearchState["sort"];
  readonly syntaxError: string | null;
  readonly total: number;
  readonly viewMode: ResultsViewMode;
}

export const JobSearchQueryBar = ({
  activeFilterCount,
  archiveTotal,
  countLabel,
  isRefreshing,
  onClearQueryDraft,
  onOpenFilters,
  onQueryDraftChange,
  onQueryScopeChange,
  onResetQueryDraft,
  onScopeChange,
  onSortChange,
  onSubmit,
  onViewModeChange,
  queryDraft,
  queryScope,
  scope,
  sort,
  syntaxError,
  total,
  viewMode,
}: JobSearchQueryBarProps) => (
  <div className="space-y-2">
    <form
      role="search"
      onSubmit={onSubmit}
      className="flex flex-wrap items-start gap-2"
    >
      <div className="min-w-[240px] flex-1">
        <label htmlFor="job-query" className="sr-only">
          Zoek opdrachten met Boolean-logica
        </label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            id="job-query"
            value={queryDraft}
            onChange={(event) => onQueryDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onResetQueryDraft();
              }
            }}
            aria-invalid={syntaxError ? true : undefined}
            aria-describedby={
              syntaxError ? "job-query-error" : "job-query-hint"
            }
            placeholder='Bijv. (Azure OR "Power BI") NOT junior'
            className="min-h-12 w-full rounded-[10px] border-2 border-primary bg-card pr-11 pl-9 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/30 sm:text-sm"
          />
          {queryDraft ? (
            <button
              type="button"
              onClick={onClearQueryDraft}
              aria-label="Zoekveld leegmaken"
              className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
        <p id="job-query-hint" className="mt-1.5 text-xs text-muted-foreground">
          Boolean: AND, OR, NOT, haakjes en "frases". Standaard zoekt in de
          volledige vacature (titel + beschrijving).
        </p>
        {syntaxError ? (
          <p
            id="job-query-error"
            className="mt-2 text-xs font-medium text-destructive"
          >
            {syntaxError}
          </p>
        ) : null}
      </div>

      <label className="flex h-12 items-center gap-2 self-start text-xs text-muted-foreground">
        <span className="hidden sm:inline">Zoek in</span>
        <select
          aria-label="Zoekbereik titel of alles"
          value={queryScope}
          onChange={(event) => {
            const { value } = event.target;
            if (isJobQueryScope(value)) {
              onQueryScopeChange(value);
            }
          }}
          className={selectClass}
        >
          {JOB_QUERY_SCOPES.map((value) => (
            <option key={value} value={value}>
              {queryScopeLabels[value]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex h-12 items-center gap-2 self-start text-xs text-muted-foreground">
        <span className="hidden sm:inline">Sorteren</span>
        <select
          aria-label="Resultaten sorteren"
          value={sort}
          onChange={(event) => {
            const { value } = event.target;
            if (isJobSort(value)) {
              onSortChange(value);
            }
          }}
          className={selectClass}
        >
          {sortOptions.map((value) => (
            <option key={value} value={value}>
              {sortLabels[value]}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        className="inline-flex h-12 shrink-0 items-center justify-center gap-2 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Search aria-hidden="true" className="size-4" />
        Zoeken
      </button>
    </form>

    <div className="flex min-h-11 flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={onOpenFilters}
        className="inline-flex min-h-11 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring min-[800px]:hidden"
      >
        <SlidersHorizontal aria-hidden="true" className="size-4" />
        Filters
        {activeFilterCount > 0 ? (
          <span className="grid size-5 place-items-center rounded-full bg-primary font-mono text-[10px] text-primary-foreground">
            {activeFilterCount}
          </span>
        ) : null}
      </button>

      <p aria-live="polite" className="mr-auto flex items-center gap-2">
        {isRefreshing ? (
          <Loader2 aria-hidden="true" className="size-3 animate-spin" />
        ) : null}
        <span>
          <strong className="font-mono font-semibold text-foreground tabular-nums">
            {total}
          </strong>{" "}
          {countLabel}
          {archiveTotal !== null && archiveTotal > 0
            ? ` · ${archiveTotal} in archief`
            : ""}
          {isRefreshing ? " · bijwerken…" : ""}
        </span>
      </p>

      {/* RJC-383: the one explicit way into the archive partition. */}
      <label className="flex min-h-11 cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={scope === "all"}
          onChange={(event) =>
            onScopeChange(event.target.checked ? "all" : "active")
          }
          className="size-4 accent-[var(--primary)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        Ook in archief zoeken
      </label>

      <div
        aria-label="Weergave"
        className="ml-auto inline-flex overflow-hidden rounded-md border border-input"
        role="group"
      >
        <button
          type="button"
          aria-pressed={viewMode === "list"}
          onClick={() => onViewModeChange("list")}
          className={`inline-flex h-9 items-center gap-1.5 px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            viewMode === "list"
              ? "bg-primary/10 font-medium text-foreground"
              : "bg-background text-muted-foreground hover:bg-accent/50"
          }`}
        >
          <List aria-hidden="true" className="size-3.5" />
          Lijst
        </button>
        <button
          type="button"
          aria-pressed={viewMode === "map"}
          onClick={() => onViewModeChange("map")}
          className={`inline-flex h-9 items-center gap-1.5 border-l border-input px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            viewMode === "map"
              ? "bg-primary/10 font-medium text-foreground"
              : "bg-background text-muted-foreground hover:bg-accent/50"
          }`}
        >
          <MapIcon aria-hidden="true" className="size-3.5" />
          Kaart
        </button>
      </div>
    </div>
  </div>
);
