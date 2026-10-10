"use client";

import { X } from "lucide-react";

import {
  contractLabels,
  freshnessLabels,
  queryScopeLabels,
  searchStatusLabels,
  sourceLabel,
  werkvormLabels,
} from "./presentation";
import type {
  FreshnessFilter,
  JobContractType,
  JobQueryScope,
  JobSearchFilters,
  JobSearchStatus,
  JobSource,
  JobSourceOption,
  JobWerkvorm,
} from "./types";
import { DEFAULT_JOB_QUERY_SCOPE } from "./types";

interface ActiveChip {
  readonly key: string;
  readonly onRemove: () => void;
  readonly removeLabel: string;
  readonly text: string;
}

interface JobActiveFiltersProps {
  readonly filters: JobSearchFilters;
  readonly onClearAll: () => void;
  readonly onContractToggle: (value: JobContractType) => void;
  readonly onFreshnessChange: (value: FreshnessFilter) => void;
  readonly onHoursRangeChange: (min: number | null, max: number | null) => void;
  readonly onLocationToggle: (value: string) => void;
  readonly onPostedRangeChange: (
    from: string | null,
    to: string | null
  ) => void;
  readonly onProvinceToggle: (value: string) => void;
  readonly onQueryClear: () => void;
  readonly onQueryScopeChange: (value: JobQueryScope) => void;
  readonly onRateRangeChange: (min: number | null, max: number | null) => void;
  readonly onSkillToggle: (value: string) => void;
  readonly onSourceToggle: (value: JobSource) => void;
  readonly onStatusToggle: (value: JobSearchStatus) => void;
  readonly onWerkvormToggle: (value: JobWerkvorm) => void;
  readonly query: string;
  readonly sources: readonly JobSourceOption[];
}

const formatBoundChip = (
  min: number | null,
  max: number | null,
  both: (a: number, b: number) => string,
  minOnly: (a: number) => string,
  maxOnly: (b: number) => string
): string => {
  if (min !== null && max !== null) {
    return both(min, max);
  }
  if (min !== null) {
    return minOnly(min);
  }
  if (max !== null) {
    return maxOnly(max);
  }
  return "";
};

// oxlint-disable-next-line eslint/complexity -- Motian-parity chip builders
const buildChips = ({
  filters,
  onContractToggle,
  onFreshnessChange,
  onHoursRangeChange,
  onLocationToggle,
  onPostedRangeChange,
  onProvinceToggle,
  onQueryClear,
  onQueryScopeChange,
  onRateRangeChange,
  onSkillToggle,
  onSourceToggle,
  onStatusToggle,
  onWerkvormToggle,
  query,
  sources,
}: Omit<JobActiveFiltersProps, "onClearAll">): readonly ActiveChip[] => {
  const chips: ActiveChip[] = [];

  if (query.trim()) {
    chips.push({
      key: `query:${query}`,
      onRemove: onQueryClear,
      removeLabel: `Zoekterm ${query} verwijderen`,
      text: `“${query}”`,
    });
  }

  for (const source of filters.sources) {
    const label =
      sources.find((option) => option.value === source)?.label ??
      sourceLabel(source);
    chips.push({
      key: `source:${source}`,
      onRemove: () => onSourceToggle(source),
      removeLabel: `Bron ${label} verwijderen`,
      text: label,
    });
  }

  for (const contract of filters.contractTypes) {
    chips.push({
      key: `contract:${contract}`,
      onRemove: () => onContractToggle(contract),
      removeLabel: `Contract ${contractLabels[contract]} verwijderen`,
      text: contractLabels[contract],
    });
  }

  for (const status of filters.status) {
    chips.push({
      key: `status:${status}`,
      onRemove: () => onStatusToggle(status),
      removeLabel: `Status ${searchStatusLabels[status]} verwijderen`,
      text: searchStatusLabels[status],
    });
  }

  for (const location of filters.locations) {
    chips.push({
      key: `location:${location}`,
      onRemove: () => onLocationToggle(location),
      removeLabel: `Locatie ${location} verwijderen`,
      text: location,
    });
  }

  if (filters.freshness !== "all") {
    chips.push({
      key: `freshness:${filters.freshness}`,
      onRemove: () => onFreshnessChange("all"),
      removeLabel: `Publicatiefilter ${freshnessLabels[filters.freshness]} verwijderen`,
      text: freshnessLabels[filters.freshness],
    });
  }

  if (filters.minRate !== null || filters.maxRate !== null) {
    const min = filters.minRate;
    const max = filters.maxRate;
    chips.push({
      key: `rate:${min}:${max}`,
      onRemove: () => onRateRangeChange(null, null),
      removeLabel: "Tarieffilter verwijderen",
      text: formatBoundChip(
        min,
        max,
        (a, b) => `€${a}–${b}`,
        (a) => `vanaf €${a}`,
        (b) => `tot €${b}`
      ),
    });
  }

  for (const werkvorm of filters.werkvormen) {
    chips.push({
      key: `arrangement:${werkvorm}`,
      onRemove: () => onWerkvormToggle(werkvorm),
      removeLabel: `Werkvorm ${werkvormLabels[werkvorm]} verwijderen`,
      text: werkvormLabels[werkvorm],
    });
  }

  for (const province of filters.provincies) {
    chips.push({
      key: `province:${province}`,
      onRemove: () => onProvinceToggle(province),
      removeLabel: `Provincie ${province} verwijderen`,
      text: province,
    });
  }

  for (const skill of filters.skills) {
    chips.push({
      key: `skill:${skill}`,
      onRemove: () => onSkillToggle(skill),
      removeLabel: `Skill ${skill} verwijderen`,
      text: skill,
    });
  }

  if (filters.urenPerWeekMin !== null || filters.urenPerWeekMax !== null) {
    const min = filters.urenPerWeekMin;
    const max = filters.urenPerWeekMax;
    chips.push({
      key: `hours:${min}:${max}`,
      onRemove: () => onHoursRangeChange(null, null),
      removeLabel: "Urenfilter verwijderen",
      text: formatBoundChip(
        min,
        max,
        (a, b) => `${a}–${b} u/w`,
        (a) => `vanaf ${a} u/w`,
        (b) => `tot ${b} u/w`
      ),
    });
  }

  if (filters.publicatiedatumVanaf || filters.publicatiedatumTot) {
    const from = filters.publicatiedatumVanaf ?? "…";
    const to = filters.publicatiedatumTot ?? "…";
    chips.push({
      key: `posted:${from}:${to}`,
      onRemove: () => onPostedRangeChange(null, null),
      removeLabel: "Publicatiedatumfilter verwijderen",
      text: `${from} → ${to}`,
    });
  }

  if (filters.queryScope !== DEFAULT_JOB_QUERY_SCOPE) {
    chips.push({
      key: `queryScope:${filters.queryScope}`,
      onRemove: () => onQueryScopeChange(DEFAULT_JOB_QUERY_SCOPE),
      removeLabel: "Zoekbereik resetten",
      text: `Zoek in: ${queryScopeLabels[filters.queryScope]}`,
    });
  }

  return chips;
};

export const JobActiveFilters = (props: JobActiveFiltersProps) => {
  const { onClearAll, ...chipProps } = props;
  const chips = buildChips(chipProps);

  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map(({ key, onRemove, removeLabel, text }) => (
        <button
          key={key}
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="flex min-h-8 items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 text-[11px] outline-none transition-colors hover:border-destructive/60 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
        >
          {text}
          <X aria-hidden="true" className="size-3" />
        </button>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="min-h-8 rounded-full px-2 text-[11px] text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        Alles wissen
      </button>
    </div>
  );
};
