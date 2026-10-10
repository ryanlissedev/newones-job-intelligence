import { Checkbox } from "@ji/ui/components/checkbox";
import {
  ArrowUpRight,
  Building2,
  CalendarClock,
  Clock3,
  Copy,
  MapPin,
  RadioTower,
} from "lucide-react";

import {
  contractLabels,
  formatContract,
  formatDate,
  formatRate,
  formatRateParts,
  formatRemote,
  primarySource,
  remoteLabel,
} from "./presentation";
import { stripHtmlToText } from "./sanitize-job-html";
import type { JobListing } from "./types";

interface JobResultsProps {
  readonly jobs: readonly JobListing[];
  readonly onSelect: (job: JobListing, trigger: HTMLButtonElement) => void;
  readonly onTogglePage?: () => void;
  readonly onToggleRow?: (id: string) => void;
  readonly pageFullySelected?: boolean;
  readonly selectedJobId: string | null;
  readonly selectedIds?: ReadonlySet<string>;
}

const ResultTitleButton = ({
  job,
  onSelect,
  showOrganization = true,
}: {
  readonly job: JobListing;
  readonly onSelect: JobResultsProps["onSelect"];
  readonly showOrganization?: boolean;
}) => (
  <button
    type="button"
    onClick={(event) => onSelect(job, event.currentTarget)}
    className="group max-w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <span className="flex items-start gap-1.5 font-medium text-foreground transition-colors group-hover:text-primary">
      <span className="line-clamp-2" title={job.title}>
        {job.title}
      </span>
      <ArrowUpRight
        aria-hidden="true"
        className="mt-0.5 size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </span>
    {showOrganization ? (
      <span className="mt-0.5 block text-[11px] text-muted-foreground">
        {job.organization ?? "Onbekend"}
      </span>
    ) : null}
  </button>
);

const jobStatusPresentation = {
  closed: {
    dotClassName: "bg-muted-foreground",
    label: "Gesloten",
    textClassName: "text-muted-foreground",
  },
  "closing-soon": {
    dotClassName: "bg-chart-2",
    label: "Sluit snel",
    textClassName: "text-chart-2",
  },
  open: {
    dotClassName: "bg-primary",
    label: "Open",
    textClassName: "text-primary",
  },
} satisfies Record<
  JobListing["status"],
  {
    readonly dotClassName: string;
    readonly label: string;
    readonly textClassName: string;
  }
>;

const JobStatus = ({ job }: { readonly job: JobListing }) => {
  const status = jobStatusPresentation[job.status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase ${status.textClassName}`}
    >
      <span className={`size-1.5 rounded-full ${status.dotClassName}`} />
      {status.label}
    </span>
  );
};

/** CTP-610: `dedupGroepId` means another aanvraag describes the same vacancy
 * — surfaced as an indicator, the record itself is never hidden. */
const DuplicaatBadge = ({ job }: { readonly job: JobListing }) =>
  job.dedupGroepId ? (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
      title="Deze vacature is ook via een andere bron gevonden"
    >
      <Copy aria-hidden="true" className="size-3" />
      Duplicaat
    </span>
  ) : null;

const resultRowBackground = (
  job: JobListing,
  selectedJobId: string | null,
  selectedIds: ReadonlySet<string> | undefined
): string => {
  if (selectedJobId === job.id) {
    return "bg-accent";
  }
  return selectedIds?.has(job.id) ? "bg-primary/10" : "";
};

const joinKnown = (parts: readonly (string | null | undefined)[]): string =>
  parts
    .filter(
      (part): part is string =>
        part !== null && part !== undefined && part !== ""
    )
    .join(" · ");

const MAX_REFERENCE_LENGTH = 8;

const shortReference = (reference: string): string =>
  reference.length > MAX_REFERENCE_LENGTH
    ? `${reference.slice(0, MAX_REFERENCE_LENGTH)}…`
    : reference;

const OpdrachtCell = ({
  job,
  onSelect,
  onToggleRow,
  selectedIds,
}: {
  readonly job: JobListing;
  readonly onSelect: JobResultsProps["onSelect"];
  readonly onToggleRow: JobResultsProps["onToggleRow"];
  readonly selectedIds: ReadonlySet<string> | undefined;
}) => {
  const meta = joinKnown([
    job.contractType ? contractLabels[job.contractType] : null,
    job.organization,
  ]);
  return (
    <td className="px-3 py-2.5 align-top">
      <div className="flex items-start gap-2.5">
        <Checkbox
          aria-label={`Selecteer ${job.title}`}
          checked={selectedIds?.has(job.id) ?? false}
          onCheckedChange={() => onToggleRow?.(job.id)}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        <div className="min-w-0">
          <ResultTitleButton
            job={job}
            onSelect={onSelect}
            showOrganization={false}
          />
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <JobStatus job={job} />
            <DuplicaatBadge job={job} />
            {meta ? (
              <span className="min-w-0 truncate" title={meta}>
                · {meta}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </td>
  );
};

const ConditiesCell = ({ job }: { readonly job: JobListing }) => {
  const rate = formatRateParts(job);
  const meta = joinKnown([
    rate?.period,
    job.hoursPerWeek ? `${job.hoursPerWeek} u/w` : null,
    remoteLabel(job),
  ]);
  return (
    <td className="px-3 py-2.5 align-top text-muted-foreground">
      <span className="block truncate font-mono" title={formatRate(job)}>
        {rate?.value ?? "—"}
      </span>
      <span
        className="mt-0.5 block truncate text-[10px]"
        title={meta || undefined}
      >
        {meta || "—"}
      </span>
    </td>
  );
};

const LocatieCell = ({ job }: { readonly job: JobListing }) => (
  <td className="px-3 py-2.5 align-top text-muted-foreground">
    <span className="block truncate" title={job.location ?? undefined}>
      {job.location ?? "—"}
    </span>
    {job.provincie ? (
      <span className="mt-0.5 block truncate text-[10px]" title={job.provincie}>
        {job.provincie}
      </span>
    ) : null}
  </td>
);

const BronCell = ({ job }: { readonly job: JobListing }) => {
  const reference = job.sourceRecords[0]?.reference ?? null;
  return (
    <td className="px-3 py-2.5 align-top text-muted-foreground">
      <span className="block truncate" title={primarySource(job)}>
        {primarySource(job)}
      </span>
      {reference ? (
        <span
          className="mt-0.5 block truncate font-mono text-[10px]"
          title={reference}
        >
          {shortReference(reference)}
        </span>
      ) : null}
    </td>
  );
};

const DataCell = ({ job }: { readonly job: JobListing }) => (
  <td className="px-3 py-2.5 align-top text-muted-foreground">
    <time
      className="block truncate font-mono"
      dateTime={job.publishedAt ?? undefined}
    >
      {job.publishedAt ? formatDate(job.publishedAt) : "—"}
    </time>
    <span
      className={`mt-0.5 block truncate text-[10px] ${
        job.status === "closing-soon" && job.closingAt ? "text-chart-2" : ""
      }`}
    >
      {job.closingAt ? `Sluit ${formatDate(job.closingAt)}` : "—"}
    </span>
  </td>
);

const DesktopResultRow = ({
  job,
  onSelect,
  onToggleRow,
  selectedJobId,
  selectedIds,
}: {
  readonly job: JobListing;
  readonly onSelect: JobResultsProps["onSelect"];
  readonly onToggleRow: JobResultsProps["onToggleRow"];
  readonly selectedJobId: string | null;
  readonly selectedIds: ReadonlySet<string> | undefined;
}) => (
  <tr
    className={`border-t border-border transition-colors hover:bg-accent/60 ${resultRowBackground(job, selectedJobId, selectedIds)}`}
  >
    <OpdrachtCell
      job={job}
      onSelect={onSelect}
      onToggleRow={onToggleRow}
      selectedIds={selectedIds}
    />
    <ConditiesCell job={job} />
    <LocatieCell job={job} />
    <BronCell job={job} />
    <DataCell job={job} />
  </tr>
);

const DesktopResults = ({
  jobs,
  onSelect,
  onTogglePage,
  onToggleRow,
  pageFullySelected = false,
  selectedJobId,
  selectedIds,
}: JobResultsProps) => (
  <div className="hidden overflow-x-auto min-[800px]:block">
    <table className="min-w-[960px] w-full table-fixed text-left text-xs">
      <caption className="sr-only">Gevonden opdrachten</caption>
      <colgroup>
        <col className="w-[36%]" />
        <col className="w-[18%]" />
        <col className="w-[15%]" />
        <col className="w-[16%]" />
        <col className="w-[15%]" />
      </colgroup>
      <thead className="bg-secondary/60 text-[11px] tracking-wide text-muted-foreground uppercase">
        <tr>
          <th scope="col" className="px-3 py-2 font-medium">
            <span className="flex items-center gap-2.5">
              <Checkbox
                aria-label="Selecteer alle resultaten op deze pagina"
                checked={pageFullySelected}
                onCheckedChange={onTogglePage}
                className="size-4 accent-primary"
              />
              Opdracht
            </span>
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            Tarief &amp; uren
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            Locatie
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            Bron
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            Data
          </th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <DesktopResultRow
            key={job.id}
            job={job}
            onSelect={onSelect}
            onToggleRow={onToggleRow}
            selectedIds={selectedIds}
            selectedJobId={selectedJobId}
          />
        ))}
      </tbody>
    </table>
  </div>
);

const MobileResults = ({
  jobs,
  onSelect,
  onToggleRow,
  selectedJobId,
  selectedIds,
}: JobResultsProps) => (
  <div className="grid gap-2 p-2 min-[800px]:hidden">
    {jobs.map((job) => (
      <article
        key={job.id}
        className={`rounded-lg border bg-card p-3 ${
          selectedJobId === job.id ? "border-primary" : "border-border"
        } ${selectedJobId !== job.id && selectedIds?.has(job.id) ? "bg-primary/10" : ""}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              aria-label={`Selecteer ${job.title}`}
              checked={selectedIds?.has(job.id) ?? false}
              onCheckedChange={() => onToggleRow?.(job.id)}
              className="size-4 accent-primary"
            />
            <JobStatus job={job} />
            <DuplicaatBadge job={job} />
          </div>
          <span className="text-[10px] text-muted-foreground">
            {formatContract(job)}
          </span>
        </div>
        <div className="mt-2">
          <ResultTitleButton job={job} onSelect={onSelect} />
        </div>
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {stripHtmlToText(job.summary) || job.summary}
        </p>
        <dl className="mt-3 grid gap-1.5 border-t border-border pt-2.5 text-xs">
          <div className="flex items-start gap-2">
            <MapPin
              aria-hidden="true"
              className="mt-0.5 size-3.5 text-muted-foreground"
            />
            <dt className="sr-only">Locatie</dt>
            <dd>
              {job.location ?? "Onbekend"} · {formatRemote(job)}
            </dd>
          </div>
          <div className="flex items-start gap-2">
            <RadioTower
              aria-hidden="true"
              className="mt-0.5 size-3.5 text-muted-foreground"
            />
            <dt className="sr-only">Tarief</dt>
            <dd className="font-mono">{formatRate(job)}</dd>
          </div>
          <div className="flex items-start gap-2">
            <Clock3
              aria-hidden="true"
              className="mt-0.5 size-3.5 text-muted-foreground"
            />
            <dt className="sr-only">Uren per week</dt>
            <dd className="font-mono">{job.hoursPerWeek ?? "Onbekend"}</dd>
          </div>
          <div className="flex items-start gap-2">
            <Building2
              aria-hidden="true"
              className="mt-0.5 size-3.5 text-muted-foreground"
            />
            <dt className="sr-only">Bron</dt>
            <dd>{primarySource(job)}</dd>
          </div>
          <div className="flex items-start gap-2 text-muted-foreground">
            <CalendarClock aria-hidden="true" className="mt-0.5 size-3.5" />
            <dt className="sr-only">Publicatie en sluiting</dt>
            <dd>
              {formatDate(job.publishedAt)} · sluit {formatDate(job.closingAt)}
            </dd>
          </div>
        </dl>
      </article>
    ))}
  </div>
);

export const JobResults = (props: JobResultsProps) => (
  <>
    <DesktopResults {...props} />
    <MobileResults {...props} />
  </>
);
