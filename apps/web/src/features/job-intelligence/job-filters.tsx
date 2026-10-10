"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  contractLabels,
  searchStatusLabels,
  werkvormLabels,
} from "./presentation";
import type {
  FacetCount,
  JobContractType,
  JobSearchFacets,
  JobSearchFilters,
  JobSearchStatus,
  JobSource,
  JobSourceOption,
  JobWerkvorm,
} from "./types";
import {
  DEFAULT_JOB_QUERY_SCOPE,
  JOB_SEARCH_STATUS_VALUES,
  JOB_WERKVORMEN,
  NL_PROVINCES,
} from "./types";

const DEFAULT_VISIBLE_OPTIONS = 6;

const contractOptions: readonly JobContractType[] = [
  "interim",
  "detachering",
  "vast",
  "freelance",
];

const contractInfos = {
  detachering:
    "In dienst bij een detacheerder, geplaatst bij de opdrachtgever.",
  freelance: "Zelfstandig (zzp/freelance) op interim-basis.",
  interim: "Zelfstandig (zzp/freelance) op interim-basis.",
  vast: "Vast dienstverband bij de opdrachtgever.",
} as const satisfies Record<JobContractType, string>;

const RATE_SLIDER = { max: 200, min: 0, step: 5 } as const;
const HOURS_SLIDER = { max: 40, min: 0, step: 1 } as const;

const CLOSING_PRESETS = [
  { freshness: "24h" as const, label: "Vandaag" },
  { freshness: "7d" as const, label: "7 dagen" },
  { freshness: "30d" as const, label: "14 dagen" },
] as const;

export const countActiveJobFilters = (filters: JobSearchFilters): number => {
  let n =
    filters.sources.length +
    filters.contractTypes.length +
    filters.locations.length +
    filters.status.length +
    filters.werkvormen.length +
    filters.provincies.length +
    filters.skills.length;
  if (filters.freshness !== "all") {
    n += 1;
  }
  if (filters.minRate !== null || filters.maxRate !== null) {
    n += 1;
  }
  if (filters.urenPerWeekMin !== null || filters.urenPerWeekMax !== null) {
    n += 1;
  }
  if (filters.publicatiedatumVanaf || filters.publicatiedatumTot) {
    n += 1;
  }
  if (filters.queryScope !== DEFAULT_JOB_QUERY_SCOPE) {
    n += 1;
  }
  return n;
};

interface FacetGroupProps {
  readonly badgeCount?: number;
  readonly children: React.ReactNode;
  readonly note?: string;
  readonly title: string;
}

const FacetGroup = ({ badgeCount, children, note, title }: FacetGroupProps) => {
  const [open, setOpen] = useState(true);

  return (
    <fieldset className="border-b border-border py-3 last:border-b-0">
      <legend className="sr-only">{title}</legend>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="flex min-h-9 w-full items-center justify-between text-xs font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="inline-flex items-center gap-2">
          {title}
          {badgeCount && badgeCount > 0 ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium normal-case tracking-normal text-primary tabular-nums">
              {badgeCount}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open ? (
        <div className="mt-2 space-y-1.5">
          {note ? (
            <p className="text-[11px] text-muted-foreground">{note}</p>
          ) : null}
          {children}
        </div>
      ) : null}
    </fieldset>
  );
};

interface FacetOptionProps<T extends string> {
  readonly checked: boolean;
  readonly count: number;
  readonly info?: string;
  readonly label: string;
  readonly onChange: (value: T) => void;
  readonly value: T;
}

const FacetOption = <T extends string>({
  checked,
  count,
  info,
  label,
  onChange,
  value,
}: FacetOptionProps<T>) => (
  <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm transition-colors hover:text-primary">
    <input
      type="checkbox"
      checked={checked}
      onChange={() => onChange(value)}
      className="size-4 shrink-0 accent-[var(--primary)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    />
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {info ? (
      <span
        title={info}
        className="grid size-4 shrink-0 place-items-center rounded-full border border-input text-[10px] text-muted-foreground"
      >
        i
      </span>
    ) : null}
    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
      {count}
    </span>
  </label>
);

const SelectAllBar = ({
  allSelected,
  groupLabel,
  noneSelected,
  onClear,
  onSelectAll,
}: {
  readonly allSelected: boolean;
  readonly groupLabel: string;
  readonly noneSelected: boolean;
  readonly onClear: () => void;
  readonly onSelectAll: () => void;
}) => (
  <div className="mb-1 flex items-center gap-2 text-[12px]">
    <button
      type="button"
      disabled={allSelected}
      onClick={onSelectAll}
      aria-label={`Alles selecteren in ${groupLabel}`}
      className="font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:text-muted-foreground disabled:no-underline"
    >
      Alles selecteren
    </button>
    <span className="text-border">|</span>
    <button
      type="button"
      disabled={noneSelected}
      onClick={onClear}
      aria-label={`Selectie wissen in ${groupLabel}`}
      className="font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:text-muted-foreground disabled:no-underline"
    >
      Alles wissen
    </button>
  </div>
);

const ShowAllToggle = ({
  hiddenLabel,
  onToggle,
  showAll,
  total,
}: {
  readonly hiddenLabel: string;
  readonly onToggle: () => void;
  readonly showAll: boolean;
  readonly total: number;
}) => (
  <button
    type="button"
    onClick={onToggle}
    className="min-h-8 text-[11px] text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
  >
    {showAll
      ? `Toon minder ${hiddenLabel}`
      : `Toon alle ${total} ${hiddenLabel}`}
  </button>
);

const findFacetCount = <T extends string>(
  facets: readonly FacetCount<T>[],
  value: T
): number => facets.find((facet) => facet.value === value)?.count ?? 0;

const DualRangeGroup = ({
  badgeActive,
  defaultMax,
  defaultMin,
  maxBound,
  minBound,
  onApply,
  prefix,
  step,
  title,
  valueMax,
  valueMin,
}: {
  readonly badgeActive: boolean;
  readonly defaultMax: number;
  readonly defaultMin: number;
  readonly maxBound: number;
  readonly minBound: number;
  readonly onApply: (min: number | null, max: number | null) => void;
  readonly prefix?: string;
  readonly step: number;
  readonly title: string;
  readonly valueMax: number | null;
  readonly valueMin: number | null;
}) => {
  const lo = valueMin ?? defaultMin;
  const hi = valueMax ?? defaultMax;
  const [a, setA] = useState(lo);
  const [b, setB] = useState(hi);

  useEffect(() => {
    setA(valueMin ?? defaultMin);
    setB(valueMax ?? defaultMax);
  }, [defaultMax, defaultMin, valueMax, valueMin]);

  const commit = (nextMin: number, nextMax: number) => {
    const clampedMin = Math.max(minBound, Math.min(nextMin, nextMax));
    const clampedMax = Math.min(maxBound, Math.max(nextMax, clampedMin));
    setA(clampedMin);
    setB(clampedMax);
    if (clampedMin === defaultMin && clampedMax === defaultMax) {
      onApply(null, null);
      return;
    }
    onApply(clampedMin, clampedMax);
  };

  const fillLeft = ((a - minBound) / (maxBound - minBound)) * 100;
  const fillRight = ((maxBound - b) / (maxBound - minBound)) * 100;

  return (
    <div className="border-b border-border py-3">
      <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {badgeActive ? (
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium normal-case tracking-normal text-primary">
            •
          </span>
        ) : null}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-input bg-background px-2">
          {prefix ? (
            <span className="text-xs text-muted-foreground">{prefix}</span>
          ) : null}
          <input
            type="number"
            value={a}
            min={minBound}
            max={maxBound}
            step={step}
            aria-label={`${title} minimum`}
            onChange={(event) => setA(Number(event.target.value))}
            onBlur={() => commit(a, b)}
            className="h-9 w-full min-w-0 bg-transparent px-1 font-mono text-xs tabular-nums outline-none"
          />
        </div>
        <span className="text-xs text-muted-foreground">tot</span>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-input bg-background px-2">
          {prefix ? (
            <span className="text-xs text-muted-foreground">{prefix}</span>
          ) : null}
          <input
            type="number"
            value={b}
            min={minBound}
            max={maxBound}
            step={step}
            aria-label={`${title} maximum`}
            onChange={(event) => setB(Number(event.target.value))}
            onBlur={() => commit(a, b)}
            className="h-9 w-full min-w-0 bg-transparent px-1 font-mono text-xs tabular-nums outline-none"
          />
        </div>
      </div>
      <div className="relative mt-3 h-6">
        <div className="absolute top-1/2 right-2 left-2 h-0.5 -translate-y-1/2 rounded bg-border" />
        <div
          className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded bg-primary"
          style={{
            left: `calc(0.5rem + ${fillLeft}%)`,
            right: `calc(0.5rem + ${fillRight}%)`,
          }}
        />
        <input
          type="range"
          min={minBound}
          max={maxBound}
          step={step}
          value={a}
          aria-label={`${title} van`}
          onChange={(event) => {
            const next = Math.min(Number(event.target.value), b - step);
            setA(next);
          }}
          onMouseUp={() => commit(a, b)}
          onTouchEnd={() => commit(a, b)}
          className="pointer-events-none absolute inset-0 w-full appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background"
        />
        <input
          type="range"
          min={minBound}
          max={maxBound}
          step={step}
          value={b}
          aria-label={`${title} tot`}
          onChange={(event) => {
            const next = Math.max(Number(event.target.value), a + step);
            setB(next);
          }}
          onMouseUp={() => commit(a, b)}
          onTouchEnd={() => commit(a, b)}
          className="pointer-events-none absolute inset-0 w-full appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background"
        />
      </div>
    </div>
  );
};

const DateGroup = ({
  from,
  onApply,
  to,
}: {
  readonly from: string | null;
  readonly onApply: (from: string | null, to: string | null) => void;
  readonly to: string | null;
}) => (
  <div className="border-b border-border py-3">
    <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      Gepubliceerd tussen
    </p>
    <div className="mt-2 flex items-center gap-2">
      <input
        type="date"
        value={from ?? ""}
        onChange={(event) => onApply(event.target.value || null, to)}
        aria-label="Publicatiedatum vanaf"
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <input
        type="date"
        value={to ?? ""}
        onChange={(event) => onApply(from, event.target.value || null)}
        aria-label="Publicatiedatum tot"
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      />
    </div>
  </div>
);

const SkillPicker = ({
  onToggle,
  options,
  selected,
}: {
  readonly onToggle: (value: string) => void;
  readonly options: readonly FacetCount[];
  readonly selected: readonly string[];
}) => {
  const [term, setTerm] = useState("");
  const normalized = term.trim().toLocaleLowerCase("nl-NL");
  const filtered = useMemo(() => {
    const base = [
      ...selected.map((skill) => ({
        count: findFacetCount(options, skill),
        value: skill,
      })),
      ...options.filter((option) => !selected.includes(option.value)),
    ];
    if (!normalized) {
      return base;
    }
    return base.filter((option) =>
      option.value.toLocaleLowerCase("nl-NL").includes(normalized)
    );
  }, [normalized, options, selected]);

  return (
    <FacetGroup
      title="Skills"
      note="Skills-facet is vaak leeg tot enrichment; geselecteerde waarden worden wel doorgestuurd."
    >
      <input
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Filter skills…"
        aria-label="Filter skills"
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground">Geen skills</p>
        ) : null}
        {filtered.map((option) => (
          <FacetOption
            key={option.value}
            value={option.value}
            label={option.value}
            count={option.count}
            checked={selected.includes(option.value)}
            onChange={onToggle}
          />
        ))}
      </div>
    </FacetGroup>
  );
};

interface JobFiltersProps {
  readonly facets: JobSearchFacets;
  readonly filters: JobSearchFilters;
  readonly onClear: () => void;
  readonly onContractTypesChange: (values: readonly JobContractType[]) => void;
  readonly onContractToggle: (value: JobContractType) => void;
  readonly onFreshnessChange: (value: JobSearchFilters["freshness"]) => void;
  readonly onHoursRangeChange: (min: number | null, max: number | null) => void;
  readonly onLocationsChange: (values: readonly string[]) => void;
  readonly onLocationToggle: (value: string) => void;
  readonly onPostedRangeChange: (
    from: string | null,
    to: string | null
  ) => void;
  readonly onProvincesChange: (values: readonly string[]) => void;
  readonly onProvinceToggle: (value: string) => void;
  readonly onRateRangeChange: (min: number | null, max: number | null) => void;
  readonly onSkillToggle: (value: string) => void;
  readonly onSourcesChange: (values: readonly JobSource[]) => void;
  readonly onSourceToggle: (value: JobSource) => void;
  readonly onStatusChange: (values: readonly JobSearchStatus[]) => void;
  readonly onStatusToggle: (value: JobSearchStatus) => void;
  readonly onWerkvormenChange: (values: readonly JobWerkvorm[]) => void;
  readonly onWerkvormToggle: (value: JobWerkvorm) => void;
  readonly sources: readonly JobSourceOption[];
}

export const JobFilters = ({
  facets,
  filters,
  onClear,
  onContractTypesChange,
  onContractToggle,
  onFreshnessChange,
  onHoursRangeChange,
  onLocationsChange,
  onLocationToggle,
  onPostedRangeChange,
  onProvincesChange,
  onProvinceToggle,
  onRateRangeChange,
  onSkillToggle,
  onSourcesChange,
  onSourceToggle,
  onStatusChange,
  onStatusToggle,
  onWerkvormenChange,
  onWerkvormToggle,
  sources,
}: JobFiltersProps) => {
  const [showAllSources, setShowAllSources] = useState(false);
  const [showAllLocations, setShowAllLocations] = useState(false);
  const [showAllProvinces, setShowAllProvinces] = useState(false);
  const activeCount = countActiveJobFilters(filters);
  const visibleSources = showAllSources
    ? sources
    : sources.slice(0, DEFAULT_VISIBLE_OPTIONS);
  const visibleLocations = showAllLocations
    ? facets.locations
    : facets.locations.slice(0, DEFAULT_VISIBLE_OPTIONS);

  const provinceOptions = useMemo(() => {
    const facetMap = new Map(
      (facets.provincies ?? []).map((facet) => [facet.value, facet.count])
    );
    const values = [
      ...NL_PROVINCES,
      ...filters.provincies.filter(
        (province) => !NL_PROVINCES.some((known) => known === province)
      ),
    ];
    return values.map((value) => ({
      count: facetMap.get(value) ?? 0,
      value,
    }));
  }, [facets.provincies, filters.provincies]);

  const visibleProvinces = showAllProvinces
    ? provinceOptions
    : provinceOptions.slice(0, DEFAULT_VISIBLE_OPTIONS);

  return (
    <div className="px-4 pb-4 min-[800px]:px-0">
      <div className="flex min-h-11 items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
          Filters
          {activeCount > 0 ? (
            <span className="grid size-5 place-items-center rounded-full bg-primary font-mono text-[10px] text-primary-foreground tabular-nums">
              {activeCount}
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          data-testid="job-filters-clear-all"
          onClick={onClear}
          className="min-h-8 text-[11px] text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Alles wissen
        </button>
      </div>

      <FacetGroup title="Bron" badgeCount={filters.sources.length}>
        <SelectAllBar
          groupLabel="Bron"
          allSelected={
            sources.length > 0 &&
            sources.every((source) => filters.sources.includes(source.value))
          }
          noneSelected={filters.sources.length === 0}
          onSelectAll={() =>
            onSourcesChange(sources.map((source) => source.value))
          }
          onClear={() => onSourcesChange([])}
        />
        {visibleSources.map((source) => (
          <FacetOption
            key={source.value}
            value={source.value}
            label={source.label}
            count={findFacetCount(facets.sources, source.value)}
            checked={filters.sources.includes(source.value)}
            onChange={onSourceToggle}
          />
        ))}
        {sources.length > DEFAULT_VISIBLE_OPTIONS ? (
          <ShowAllToggle
            hiddenLabel="bronnen"
            onToggle={() => setShowAllSources((previous) => !previous)}
            showAll={showAllSources}
            total={sources.length}
          />
        ) : null}
      </FacetGroup>

      <FacetGroup title="Contract" badgeCount={filters.contractTypes.length}>
        <SelectAllBar
          groupLabel="Contract"
          allSelected={contractOptions.every((value) =>
            filters.contractTypes.includes(value)
          )}
          noneSelected={filters.contractTypes.length === 0}
          onSelectAll={() => onContractTypesChange(contractOptions)}
          onClear={() => onContractTypesChange([])}
        />
        {contractOptions.map((contract) => (
          <FacetOption
            key={contract}
            value={contract}
            label={contractLabels[contract]}
            info={contractInfos[contract]}
            count={findFacetCount(facets.contractTypes, contract)}
            checked={filters.contractTypes.includes(contract)}
            onChange={onContractToggle}
          />
        ))}
      </FacetGroup>

      <FacetGroup title="Status" badgeCount={filters.status.length}>
        <SelectAllBar
          groupLabel="Status"
          allSelected={JOB_SEARCH_STATUS_VALUES.every((value) =>
            filters.status.includes(value)
          )}
          noneSelected={filters.status.length === 0}
          onSelectAll={() => onStatusChange(JOB_SEARCH_STATUS_VALUES)}
          onClear={() => onStatusChange([])}
        />
        {JOB_SEARCH_STATUS_VALUES.map((status) => (
          <FacetOption
            key={status}
            value={status}
            label={searchStatusLabels[status]}
            count={findFacetCount(facets.status, status)}
            checked={filters.status.includes(status)}
            onChange={onStatusToggle}
          />
        ))}
      </FacetGroup>

      <FacetGroup title="Werkvorm" badgeCount={filters.werkvormen.length}>
        <SelectAllBar
          groupLabel="Werkvorm"
          allSelected={JOB_WERKVORMEN.every((value) =>
            filters.werkvormen.includes(value)
          )}
          noneSelected={filters.werkvormen.length === 0}
          onSelectAll={() => onWerkvormenChange(JOB_WERKVORMEN)}
          onClear={() => onWerkvormenChange([])}
        />
        {JOB_WERKVORMEN.map((werkvorm) => (
          <FacetOption
            key={werkvorm}
            value={werkvorm}
            label={werkvormLabels[werkvorm]}
            count={findFacetCount(facets.werkvormen ?? [], werkvorm)}
            checked={filters.werkvormen.includes(werkvorm)}
            onChange={onWerkvormToggle}
          />
        ))}
      </FacetGroup>

      <FacetGroup title="Locatie" badgeCount={filters.locations.length}>
        {facets.locations.length === 0 ? (
          <p className="text-xs text-muted-foreground">Geen locaties</p>
        ) : (
          <SelectAllBar
            groupLabel="Locatie"
            allSelected={
              facets.locations.length > 0 &&
              facets.locations.every((location) =>
                filters.locations.includes(location.value)
              )
            }
            noneSelected={filters.locations.length === 0}
            onSelectAll={() =>
              onLocationsChange(
                facets.locations.map((location) => location.value)
              )
            }
            onClear={() => onLocationsChange([])}
          />
        )}
        {visibleLocations.map(({ count, value }) => (
          <FacetOption
            key={value}
            value={value}
            label={value}
            count={count}
            checked={filters.locations.includes(value)}
            onChange={onLocationToggle}
          />
        ))}
        {facets.locations.length > DEFAULT_VISIBLE_OPTIONS ? (
          <ShowAllToggle
            hiddenLabel="locaties"
            onToggle={() => setShowAllLocations((previous) => !previous)}
            showAll={showAllLocations}
            total={facets.locations.length}
          />
        ) : null}
      </FacetGroup>

      <FacetGroup
        title="Regio"
        badgeCount={filters.provincies.length}
        note="Alleen brongepubliceerde provincies worden getoond; de index kan daarom spaarzame facetwaarden bevatten."
      >
        <SelectAllBar
          groupLabel="Regio"
          allSelected={
            provinceOptions.length > 0 &&
            provinceOptions.every((province) =>
              filters.provincies.includes(province.value)
            )
          }
          noneSelected={filters.provincies.length === 0}
          onSelectAll={() =>
            onProvincesChange(provinceOptions.map((province) => province.value))
          }
          onClear={() => onProvincesChange([])}
        />
        {visibleProvinces.map(({ count, value }) => (
          <FacetOption
            key={value}
            value={value}
            label={value}
            count={count}
            checked={filters.provincies.includes(value)}
            onChange={onProvinceToggle}
          />
        ))}
        {provinceOptions.length > DEFAULT_VISIBLE_OPTIONS ? (
          <ShowAllToggle
            hiddenLabel="regio's"
            onToggle={() => setShowAllProvinces((previous) => !previous)}
            showAll={showAllProvinces}
            total={provinceOptions.length}
          />
        ) : null}
      </FacetGroup>

      <SkillPicker
        options={facets.skills ?? []}
        selected={filters.skills}
        onToggle={onSkillToggle}
      />

      <DualRangeGroup
        title="Tarief per uur"
        prefix="€"
        badgeActive={filters.minRate !== null || filters.maxRate !== null}
        minBound={RATE_SLIDER.min}
        maxBound={RATE_SLIDER.max}
        step={RATE_SLIDER.step}
        defaultMin={RATE_SLIDER.min}
        defaultMax={RATE_SLIDER.max}
        valueMin={filters.minRate}
        valueMax={filters.maxRate}
        onApply={onRateRangeChange}
      />

      <DualRangeGroup
        title="Uren per week"
        badgeActive={
          filters.urenPerWeekMin !== null || filters.urenPerWeekMax !== null
        }
        minBound={HOURS_SLIDER.min}
        maxBound={HOURS_SLIDER.max}
        step={HOURS_SLIDER.step}
        defaultMin={HOURS_SLIDER.min}
        defaultMax={HOURS_SLIDER.max}
        valueMin={filters.urenPerWeekMin}
        valueMax={filters.urenPerWeekMax}
        onApply={onHoursRangeChange}
      />

      <FacetGroup
        title="Sluit binnen"
        badgeCount={filters.freshness === "all" ? 0 : 1}
        note="Preset op publicatie-freshness (SearchFilters.freshnessDays). Echte sluitingsdatum-filter volgt wanneer de API die kent."
      >
        <div className="flex flex-wrap gap-1.5">
          {CLOSING_PRESETS.map((preset) => {
            const pressed = filters.freshness === preset.freshness;
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={pressed}
                onClick={() =>
                  onFreshnessChange(pressed ? "all" : preset.freshness)
                }
                className={`rounded-full border px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  pressed
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background text-muted-foreground hover:bg-accent"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </FacetGroup>

      <DateGroup
        from={filters.publicatiedatumVanaf}
        to={filters.publicatiedatumTot}
        onApply={onPostedRangeChange}
      />
    </div>
  );
};
