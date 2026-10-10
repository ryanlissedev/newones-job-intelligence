"use client";

import { MapPin } from "lucide-react";

import { geocodeNlLocation, projectToMapPercent } from "./nl-location-coords";
import type { GeoPoint } from "./nl-location-coords";
import type { JobListing } from "./types";

interface JobResultsMapProps {
  readonly jobs: readonly JobListing[];
  readonly onSelect: (job: JobListing, trigger: HTMLButtonElement) => void;
  readonly selectedJobId: string | null;
}

interface PlacedJob {
  readonly job: JobListing;
  readonly point: GeoPoint;
  readonly left: number;
  readonly top: number;
}

export const JobResultsMap = ({
  jobs,
  onSelect,
  selectedJobId,
}: JobResultsMapProps) => {
  const placed: PlacedJob[] = [];
  const unknown: JobListing[] = [];

  for (const job of jobs) {
    const point = geocodeNlLocation(job.location);
    if (point === null) {
      unknown.push(job);
      continue;
    }
    const { left, top } = projectToMapPercent(point);
    placed.push({ job, left, point, top });
  }

  return (
    <div className="grid gap-3 p-3 min-[900px]:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.8fr)]">
      <div
        aria-label="Kaart met zoekresultaten"
        className="relative min-h-[22rem] overflow-hidden rounded-lg border border-border bg-[linear-gradient(160deg,oklch(0.93_0.02_240),oklch(0.88_0.03_150))]"
        role="img"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-[8%] rounded-[40%_45%_38%_42%] border border-primary/25 bg-primary/5"
        />
        <p className="absolute top-3 left-3 rounded-md bg-background/85 px-2 py-1 font-mono text-[10px] text-muted-foreground">
          Nederland · {placed.length} geplaatst
        </p>
        {placed.map(({ job, left, top }) => {
          const selected = selectedJobId === job.id;
          return (
            <button
              key={job.id}
              type="button"
              aria-label={`${job.title}${job.location ? ` in ${job.location}` : ""}`}
              aria-pressed={selected}
              onClick={(event) => onSelect(job, event.currentTarget)}
              className={`absolute z-10 -translate-x-1/2 -translate-y-full rounded-full border bg-background p-1.5 shadow-sm outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring ${
                selected
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground"
              }`}
              style={{ left: `${left}%`, top: `${top}%` }}
              title={`${job.title} · ${job.location ?? "Onbekend"}`}
            >
              <MapPin aria-hidden="true" className="size-3.5" />
            </button>
          );
        })}
        {placed.length === 0 ? (
          <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
            Geen resultaten met herkenbare locatie op deze pagina.
          </p>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-col gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Resultaten op kaart
        </p>
        <ul className="max-h-[22rem] space-y-1 overflow-auto pr-1">
          {placed.map(({ job, point }) => (
            <li key={job.id}>
              <button
                type="button"
                onClick={(event) => onSelect(job, event.currentTarget)}
                className={`w-full rounded-md border px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selectedJobId === job.id
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:bg-accent/40"
                }`}
              >
                <span className="block text-sm font-medium text-foreground line-clamp-2">
                  {job.title}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {job.location ?? point.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {unknown.length > 0 ? (
          <div className="border-t border-border pt-2">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Onbekende locatie ({unknown.length})
            </p>
            <ul className="max-h-40 space-y-1 overflow-auto">
              {unknown.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    onClick={(event) => onSelect(job, event.currentTarget)}
                    className={`w-full rounded-md border px-2.5 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selectedJobId === job.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent/40"
                    }`}
                  >
                    {job.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
};
