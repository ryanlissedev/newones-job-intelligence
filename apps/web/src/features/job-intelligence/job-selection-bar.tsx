"use client";

import {
  SNAPSHOT_MAX_SELECTED_IDS,
  selectionCountLabel,
} from "./snapshot-selection";

interface JobSelectionBarProps {
  readonly count: number;
  readonly isSelectingAll: boolean;
  readonly onClear: () => void;
  readonly onSelectAll: () => void;
  readonly responseComplete: boolean;
  readonly total: number;
}

const selectionButtonClass =
  "inline-flex min-h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45";

export const JobSelectionBar = ({
  count,
  isSelectingAll,
  onClear,
  onSelectAll,
  responseComplete,
  total,
}: JobSelectionBarProps) => (
  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2.5">
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-xs font-medium text-foreground" role="status">
        {selectionCountLabel(count)}
      </p>
      {total > SNAPSHOT_MAX_SELECTED_IDS ? (
        <p className="text-xs text-muted-foreground">
          Meer dan {SNAPSHOT_MAX_SELECTED_IDS} matches: verfijn de zoekopdracht
          of selecteer per rij.
        </p>
      ) : null}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={selectionButtonClass}
        disabled={total === 0 || isSelectingAll || !responseComplete}
        onClick={onSelectAll}
        title={`Selecteer maximaal ${SNAPSHOT_MAX_SELECTED_IDS} matches uit deze zoekopdracht`}
      >
        {isSelectingAll ? "Selecteren…" : "Selecteer alle matches"}
      </button>
      <button
        type="button"
        className={selectionButtonClass}
        disabled={count === 0}
        onClick={onClear}
      >
        Selectie wissen
      </button>
    </div>
  </div>
);
