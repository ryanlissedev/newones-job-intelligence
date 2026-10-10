import { ExternalLink, Sparkles, X } from "lucide-react";

import { useMarktvragenChat } from "@/features/marktvragen/marktvragen-chat-context";

import { JobBodyContent } from "./job-body-content";
import {
  aangevuldLabel,
  formatContract,
  formatDate,
  formatRate,
  formatRemote,
  isFieldAangevuld,
} from "./presentation";
import { isSafeHref } from "./sanitize-job-html";
import type {
  JobContactpersoon,
  JobEnrichedField,
  JobListing,
  JobMarkering,
  MarkeringSyncState,
} from "./types";

const RAW_PREVIEW_INDENT = 2;

const badgeClass =
  "rounded-full border border-border bg-secondary px-2.5 py-0.5 text-[11px] font-medium";

const ISO_DATE_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;

const dateOnlyFormatter = new Intl.DateTimeFormat("nl-NL", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const formatOptionalDate = (value: string | null | undefined): string => {
  if (!value || value.trim() === "") {
    return "Onbekend";
  }
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match?.groups) {
    return value;
  }

  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const lastDay =
    month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  if (day < 1 || day > lastDay) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return match.groups.hour === undefined
    ? dateOnlyFormatter.format(date)
    : formatDate(value);
};

const DetailField = ({
  aangevuld = false,
  aangevuldField,
  label,
  value,
}: {
  readonly aangevuld?: boolean;
  readonly aangevuldField?: JobEnrichedField["field"];
  readonly label: string;
  readonly value: string;
}) => (
  <div>
    <dt className="text-[10px] tracking-wide text-muted-foreground uppercase">
      {label}
    </dt>
    <dd className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs break-words">
      <span>{value}</span>
      {aangevuld && aangevuldField ? (
        <span
          className="rounded-full border border-chart-2/40 bg-chart-2/10 px-2 py-0.5 text-[10px] font-medium text-chart-2"
          title={aangevuldLabel(aangevuldField)}
        >
          aangevuld
        </span>
      ) : null}
    </dd>
  </div>
);

/**
 * Rendered only when the source published a province (CTP-514, F04). An absent
 * province stays absent rather than showing "Onbekend": the detail page never
 * claims a fact the source did not publish.
 */
const ProvincieField = ({
  provincie,
}: {
  readonly provincie?: string | null;
}) => (provincie ? <DetailField label="Provincie" value={provincie} /> : null);

/**
 * Rendered only when the source published a duration instead of an end date
 * (CTP-514, F11). Same hide-on-null choice as Provincie: an absent duration
 * stays absent rather than showing "Onbekend".
 */
const LooptijdField = ({ duration }: { readonly duration?: string | null }) =>
  duration ? <DetailField label="Looptijd" value={duration} /> : null;

const DetailSection = ({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) => (
  <div>
    <h3 className="mb-2 font-display text-sm font-semibold">{title}</h3>
    {children}
  </div>
);

const JobBadges = ({ job }: { readonly job: JobListing }) => (
  <div className="mt-3 flex flex-wrap gap-1.5">
    <span className={`${badgeClass} border-primary/40 text-primary`}>
      {formatContract(job)}
    </span>
    {job.status === "closing-soon" ? (
      <span className={`${badgeClass} border-chart-2/40 text-chart-2`}>
        Sluit binnenkort
      </span>
    ) : null}
    {job.dedupGroepId ? (
      <span
        className={badgeClass}
        title="Deze vacature is ook via een andere bron gevonden"
      >
        Duplicaat
      </span>
    ) : null}
    <span className={badgeClass}>{formatRemote(job)}</span>
  </div>
);

const MAILTO_SAFE_EMAIL =
  /^[^\s@?&'"/\\<>]+@[^\s@?&'"/\\<>]+\.[^\s@?&'"/\\<>]+$/u;
const TEL_SAFE_PHONE = /^\+?[0-9][0-9 ()-]{4,}$/u;

const contactEmailNode = (email: string | null): React.ReactNode => {
  if (!email) {
    return null;
  }
  // A scraped email may carry `?`/`&` — that would inject RFC-6068
  // headers (bcc/subject) into the mailto. Only a clean addr-spec gets
  // a link; anything else still renders as text.
  if (!MAILTO_SAFE_EMAIL.test(email)) {
    return <span className="font-mono">{email}</span>;
  }
  return (
    <a
      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
      href={`mailto:${email}`}
    >
      {email}
    </a>
  );
};

const contactTelefoonNode = (telefoon: string | null): React.ReactNode => {
  if (!telefoon) {
    return null;
  }
  // Same scraped-input rule as the mailto: only a plausibly diallable
  // number becomes a tel: link; anything else renders as text.
  if (!TEL_SAFE_PHONE.test(telefoon)) {
    return <span className="font-mono">{telefoon}</span>;
  }
  return (
    <a
      className="font-mono underline decoration-dotted underline-offset-2 hover:text-foreground"
      href={`tel:${telefoon.replaceAll(/[^+0-9]/gu, "")}`}
    >
      {telefoon}
    </a>
  );
};

const ContactpersoonCard = ({
  contact,
}: {
  readonly contact: JobContactpersoon;
}) => (
  <li className="rounded-lg border border-border bg-background/60 p-3">
    <p className="text-xs font-medium">
      {contact.naam ?? "Naam onbekend"}
      {contact.rol ? (
        <span className="ml-1.5 font-normal text-[10px] text-muted-foreground">
          {contact.rol}
        </span>
      ) : null}
    </p>
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
      {contactEmailNode(contact.email)}
      {contactTelefoonNode(contact.telefoon)}
    </div>
  </li>
);

const ContactpersonenSection = ({
  contactpersonen,
}: {
  readonly contactpersonen?: readonly JobContactpersoon[];
}) =>
  contactpersonen && contactpersonen.length > 0 ? (
    <DetailSection title="Contactpersonen">
      <ul className="space-y-2">
        {contactpersonen.map((contact) => (
          <ContactpersoonCard
            key={`${contact.naam ?? ""}|${contact.email ?? ""}|${contact.telefoon ?? ""}|${contact.rol ?? ""}`}
            contact={contact}
          />
        ))}
      </ul>
    </DetailSection>
  ) : null;

const ProvenanceCard = ({
  record,
}: {
  readonly record: JobListing["sourceRecords"][number];
}) => (
  <article className="rounded-lg border border-border bg-background/60 p-3">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium">{record.displayName}</p>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
          {record.reference}
        </p>
      </div>
      {isSafeHref(record.url) ? (
        <a
          href={record.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open bronrecord ${record.reference}`}
          className="grid size-9 shrink-0 place-items-center rounded-md border border-input text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      ) : null}
    </div>
    <dl className="mt-3 grid gap-1.5 font-mono text-[10px] text-muted-foreground">
      <div className="flex justify-between gap-3">
        <dt>bron</dt>
        <dd className="text-foreground/80">{record.displayName}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt>bron_referentie</dt>
        <dd className="truncate text-foreground/80">{record.reference}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt>scrape_run_id</dt>
        <dd className="truncate text-foreground/80">{record.scrapeRunId}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt>normalisatieversie</dt>
        <dd className="text-foreground/80">{record.normalizationVersion}</dd>
      </div>
      {record.lastSeenAt ? (
        <div className="flex justify-between gap-3">
          <dt>laatst gezien</dt>
          <dd className="text-foreground/80">
            {formatDate(record.lastSeenAt)}
          </dd>
        </div>
      ) : null}
      {record.validFrom ? (
        <div className="flex justify-between gap-3">
          <dt>versie geldig vanaf</dt>
          <dd className="text-foreground/80">{formatDate(record.validFrom)}</dd>
        </div>
      ) : null}
      {record.validTo ? (
        <div className="flex justify-between gap-3">
          <dt>versie geldig tot</dt>
          <dd className="text-foreground/80">{formatDate(record.validTo)}</dd>
        </div>
      ) : null}
    </dl>
  </article>
);

interface JobDetailProps {
  readonly descriptionId: string;
  readonly job: JobListing;
  readonly isMarkeringMutationPending?: boolean;
  readonly liveData?: boolean;
  readonly markering?: JobMarkering | null;
  readonly markeringSyncState?: MarkeringSyncState;
  readonly onClose: () => void;
  readonly onMarkeer?: () => void;
  readonly titleId: string;
}

const markeringActionLabel = (
  markering: JobMarkering | null,
  isPending: boolean
): string => {
  if (isPending) {
    return "Markering opslaan…";
  }
  return markering ? "Opnieuw markeren als relevant" : "Markeren als relevant";
};

const markeringActionTitle = (
  isPending: boolean,
  isAvailable: boolean
): string => {
  if (isPending) {
    return "Markering wordt opgeslagen";
  }
  return isAvailable
    ? "Markeer als relevant"
    : "Markeren vereist de U7 REST-capability";
};

const AskMarktvragenButton = ({
  job,
  onHandoff,
}: {
  readonly job: JobListing;
  readonly onHandoff: () => void;
}) => {
  const { enabled, sendToChat } = useMarktvragenChat();

  if (!enabled) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => {
        sendToChat(`Vertel me over deze aanvraag: ${job.title}`, {
          aanvraagId: job.id,
          kind: "aanvraag",
          label: job.title,
        });
        // The detail is a modal <dialog> (top layer): the chat panel can never
        // paint above it, so the handoff must close the detail to be visible.
        onHandoff();
      }}
      className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Sparkles aria-hidden="true" className="size-4" />
      Vraag de agent over deze aanvraag
    </button>
  );
};

export const JobDetail = ({
  descriptionId,
  job,
  isMarkeringMutationPending = false,
  liveData = false,
  markering = null,
  markeringSyncState = "idle",
  onClose,
  onMarkeer,
  titleId,
}: JobDetailProps) => {
  const rawPreview =
    job.rawPreview ??
    JSON.stringify(
      {
        contract_type: job.contractType,
        description: job.description,
        location: job.location,
        organization: job.organization,
        skills: job.skills,
        title: job.title,
      },
      null,
      RAW_PREVIEW_INDENT
    );

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-start gap-3 border-b border-border px-4 py-4">
        <div className="min-w-0 flex-1">
          <h2
            id={titleId}
            className="font-display text-lg leading-snug font-semibold tracking-tight"
          >
            {job.title}
          </h2>
          <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">
            {job.organization ?? "Onbekend"} · {job.location ?? "Onbekend"}
          </p>
          <JobBadges job={job} />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Vacaturedetail sluiten"
          className="grid size-9 shrink-0 place-items-center rounded-md border border-input text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <DetailField
            label="Organisatie"
            value={job.organization ?? "Onbekend"}
            aangevuld={isFieldAangevuld(job, "organisatie")}
            aangevuldField="organisatie"
          />
          <DetailField
            label="Locatie"
            value={job.location ?? "Onbekend"}
            aangevuld={isFieldAangevuld(job, "locatie")}
            aangevuldField="locatie"
          />
          <ProvincieField provincie={job.provincie} />
          <DetailField
            label="Tarief"
            value={formatRate(job)}
            aangevuld={isFieldAangevuld(job, "tarief")}
            aangevuldField="tarief"
          />
          <DetailField
            label="Contract"
            value={formatContract(job)}
            aangevuld={isFieldAangevuld(job, "contract")}
            aangevuldField="contract"
          />
          <DetailField
            label="Werkvorm"
            value={formatRemote(job)}
            aangevuld={isFieldAangevuld(job, "remote")}
            aangevuldField="remote"
          />
          <DetailField
            label="Gepubliceerd"
            aangevuld={isFieldAangevuld(job, "publicatiedatum")}
            aangevuldField="publicatiedatum"
            value={formatDate(job.publishedAt)}
          />
          <DetailField
            label="Sluit"
            aangevuld={isFieldAangevuld(job, "sluitingsdatum")}
            aangevuldField="sluitingsdatum"
            value={formatDate(job.closingAt)}
          />
          <DetailField
            label="Uren per week"
            aangevuld={isFieldAangevuld(job, "uren")}
            aangevuldField="uren"
            value={job.hoursPerWeek ?? "Onbekend"}
          />
          <DetailField
            label="Opleiding"
            aangevuld={isFieldAangevuld(job, "opleiding")}
            aangevuldField="opleiding"
            value={job.educationLevel ?? "Onbekend"}
          />
          <DetailField
            label="Startdatum"
            aangevuld={isFieldAangevuld(job, "startdatum")}
            aangevuldField="startdatum"
            value={formatOptionalDate(job.startDate)}
          />
          <DetailField
            label="Einddatum"
            aangevuld={isFieldAangevuld(job, "einddatum")}
            aangevuldField="einddatum"
            value={formatOptionalDate(job.endDate)}
          />
          <LooptijdField duration={job.duration} />
        </dl>

        <DetailSection title="Opdracht">
          <JobBodyContent
            bronSlug={job.sourceRecords[0]?.name}
            content={job.description.trim() || job.summary}
            className="text-foreground"
          />
        </DetailSection>

        {job.skills.length > 0 ? (
          <DetailSection title="Skills">
            <div className="flex flex-wrap gap-1.5">
              {job.skills.map((skill) => (
                <span key={skill} className={badgeClass}>
                  {skill}
                </span>
              ))}
            </div>
          </DetailSection>
        ) : null}

        <ContactpersonenSection contactpersonen={job.contactpersonen} />

        <DetailSection title="Herkomst">
          <div className="space-y-2.5">
            {job.sourceRecords.map((record) => (
              <ProvenanceCard key={record.id} record={record} />
            ))}
          </div>
        </DetailSection>

        <DetailSection title="Raw preview">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {liveData
              ? "Immutable bronpayload via read_raw (preview)."
              : "Veilige voorbeeldpayload. De volledige immutable bronpayload volgt via de U7 read-raw capability."}
          </p>
          <div
            className="mt-2 min-h-0 max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-border bg-[var(--ji-ink)]"
            data-testid="job-raw-preview-scroll"
          >
            <pre className="min-h-0 whitespace-pre-wrap break-words p-3 font-mono text-[10px] leading-relaxed text-[var(--ji-paper-muted)]">
              {rawPreview}
            </pre>
          </div>
        </DetailSection>
      </div>

      <div className="border-t border-border bg-card p-3">
        {markeringSyncState === "idle" ? null : (
          <p className="mb-2 text-[11px] text-muted-foreground" role="status">
            Synchronisatie: {markeringSyncState}
          </p>
        )}
        {markering ? (
          <p className="mb-2 text-[11px] text-muted-foreground">
            Markering:{" "}
            <span className="font-medium text-foreground">
              {markering.status.replaceAll("_", " ")}
            </span>
          </p>
        ) : null}
        <button
          type="button"
          disabled={!onMarkeer || isMarkeringMutationPending}
          onClick={onMarkeer}
          title={markeringActionTitle(
            isMarkeringMutationPending,
            Boolean(onMarkeer)
          )}
          className="min-h-11 w-full rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
        >
          {markeringActionLabel(markering, isMarkeringMutationPending)}
        </button>
        <AskMarktvragenButton job={job} onHandoff={onClose} />
      </div>
    </div>
  );
};
