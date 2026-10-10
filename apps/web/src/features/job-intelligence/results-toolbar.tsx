"use client";

import { JOB_PAGE_SIZE_OPTIONS } from "./types";
import type { JobPageSize } from "./types";

interface JobResultsToolbarProps {
  readonly onPageSizeChange: (pageSize: JobPageSize) => void;
  readonly pageSize: JobPageSize;
  readonly total: number;
}

export const JobResultsToolbar = ({
  onPageSizeChange,
  pageSize,
  total,
}: JobResultsToolbarProps) => (
  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2.5">
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      Resultaten per pagina
      <select
        aria-label="Resultaten per pagina"
        className="h-9 min-w-[5.5rem] rounded-md border border-input bg-background px-2 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={pageSize}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          const next = JOB_PAGE_SIZE_OPTIONS.find(
            (option) => option === parsed
          );
          if (next !== undefined) {
            onPageSizeChange(next);
          }
        }}
      >
        {JOB_PAGE_SIZE_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
    <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
      {total.toLocaleString("nl-NL")} resultaten
    </p>
  </div>
);
