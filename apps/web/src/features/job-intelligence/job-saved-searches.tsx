"use client";

import { ChevronDown, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { runAsync } from "./run-async";
import type {
  JobIntelligenceActions,
  JobSearchFilters,
  SavedSearchSummary,
} from "./types";

const BooleanQueryText = ({ query }: { readonly query: string }) => {
  const parts = query.split(/\b(?<op>AND|OR|NOT|EN|OF|NIET)\b/gu);
  return (
    <>
      {parts.map((part, index) =>
        /^(?<op>AND|OR|NOT|EN|OF|NIET)$/u.test(part) ? (
          <b key={`${part}-${index}`} className="font-medium text-primary">
            {part}
          </b>
        ) : (
          <span key={`t-${index}`}>{part}</span>
        )
      )}
    </>
  );
};

const summarizeFilters = (filters: JobSearchFilters): string => {
  const parts: string[] = [];
  if (filters.sources.length > 0) {
    parts.push(filters.sources.join(", "));
  }
  if (filters.contractTypes.length > 0) {
    parts.push(filters.contractTypes.join(", "));
  }
  if (filters.status.length > 0) {
    parts.push(filters.status.join(", "));
  }
  if (filters.provincies.length > 0) {
    parts.push(filters.provincies.join(", "));
  }
  if (filters.locations.length > 0) {
    parts.push(filters.locations.slice(0, 3).join(", "));
  }
  if (filters.skills.length > 0) {
    parts.push(filters.skills.slice(0, 3).join(", "));
  }
  if (filters.minRate !== null || filters.maxRate !== null) {
    parts.push(`€${filters.minRate ?? "…"}–€${filters.maxRate ?? "…"}`);
  }
  if (filters.freshness !== "all") {
    parts.push(filters.freshness);
  }
  return parts.join(" · ");
};

interface JobSavedSearchesProps {
  readonly actions?: JobIntelligenceActions;
  readonly activeId: string | null;
  readonly canSave: boolean;
  readonly filters: JobSearchFilters;
  readonly isSaving: boolean;
  readonly onApply: (saved: SavedSearchSummary) => void;
  readonly onSaved: (saved: {
    readonly id: string;
    readonly naam: string;
  }) => void;
  readonly query: string;
  readonly refreshKey: number;
}

export const JobSavedSearches = ({
  actions,
  activeId,
  canSave,
  filters,
  isSaving,
  onApply,
  onSaved,
  query,
  refreshKey,
}: JobSavedSearchesProps) => {
  const [open, setOpen] = useState(true);
  const [items, setItems] = useState<readonly SavedSearchSummary[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const nameId = useId();

  const reload = useCallback(async () => {
    if (!actions) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const listed = await actions.listSavedSearches();
      setItems(listed);
    } catch {
      setError("Opgeslagen zoekopdrachten konden niet worden geladen.");
    } finally {
      setLoading(false);
    }
  }, [actions]);

  useEffect(() => {
    runAsync(reload);
  }, [reload, refreshKey]);

  const save = async () => {
    if (!actions || !canSave) {
      return;
    }
    const naam =
      name.trim() || query.trim() || `Zoekopdracht ${items.length + 1}`;
    try {
      const saved = await actions.createSavedSearch({
        filters,
        naam,
        query,
      });
      setName("");
      onSaved(saved);
      await reload();
    } catch {
      setError("Opslaan mislukt. Controleer je sessie en probeer opnieuw.");
    }
  };

  const remove = async (id: string) => {
    if (!actions) {
      return;
    }
    try {
      await actions.deleteSavedSearch(id);
      await reload();
    } catch {
      setError("Verwijderen mislukt.");
    }
  };

  return (
    <section className="border-b border-border pb-3 mb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-9 w-full items-center justify-between text-xs font-semibold tracking-wide text-foreground uppercase outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="inline-flex items-center gap-2">
          Mijn zoekopdrachten
          {items.length > 0 ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary tabular-nums">
              {items.length}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-3.5 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>

      {open ? (
        <div className="mt-2 space-y-2">
          {loading ? (
            <p className="text-xs text-muted-foreground">Laden…</p>
          ) : null}
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {!loading && items.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nog geen opgeslagen zoekopdrachten. Stel filters in, geef een naam
              en klik Opslaan.
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            {items.map((item) => {
              const filterSummary = summarizeFilters(item.filters);
              return (
                <div
                  key={item.id}
                  className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 rounded-lg border px-2.5 py-2 text-left ${
                    activeId === item.id
                      ? "border-primary bg-primary/5"
                      : "border-border bg-card hover:border-primary/60"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onApply(item)}
                    className="min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block truncate text-sm font-semibold">
                      {item.naam}
                    </span>
                    <span
                      className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground"
                      title={item.query || "(geen zoekterm)"}
                    >
                      {item.query ? (
                        <BooleanQueryText query={item.query} />
                      ) : (
                        "— geen zoekterm —"
                      )}
                    </span>
                    {filterSummary ? (
                      <span
                        className="mt-0.5 block truncate text-[11px] text-muted-foreground/80"
                        title={filterSummary}
                      >
                        {filterSummary}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`Verwijder ${item.naam}`}
                    onClick={() => runAsync(() => remove(item.id))}
                    className="self-start rounded-md p-1 text-muted-foreground outline-none hover:text-amber-700 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2 pt-1">
            <label htmlFor={nameId} className="sr-only">
              Naam voor zoekopdracht
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runAsync(save);
                }
              }}
              placeholder="Naam voor huidige zoekopdracht"
              disabled={!actions}
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
            />
            <button
              type="button"
              disabled={!actions || !canSave || isSaving}
              onClick={() => runAsync(save)}
              className="h-9 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? "…" : "Opslaan"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
};
