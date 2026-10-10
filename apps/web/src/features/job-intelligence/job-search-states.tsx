import {
  Braces,
  CircleAlert,
  RefreshCw,
  SearchX,
  ServerOff,
} from "lucide-react";

interface StateAction {
  readonly label: string;
  readonly onClick: () => void;
}

interface SearchStatePanelProps {
  readonly action: StateAction;
  readonly description: string;
  readonly icon: typeof SearchX;
  readonly title: string;
  readonly tone?: "default" | "error";
}

const SearchStatePanel = ({
  action,
  description,
  icon: Icon,
  title,
  tone = "default",
}: SearchStatePanelProps) => (
  <div className="grid min-h-[420px] place-items-center p-6 text-center">
    <div className="max-w-md">
      <span
        className={`mx-auto grid size-12 place-items-center rounded-lg border ${
          tone === "error"
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-border bg-secondary text-muted-foreground"
        }`}
      >
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <h2 className="mt-4 font-display text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <button
        type="button"
        onClick={action.onClick}
        className="mt-5 min-h-11 rounded-md border border-input bg-background px-4 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {action.label}
      </button>
    </div>
  </div>
);

export const JobLoadingState = () => (
  <div className="p-3" aria-busy="true" aria-label="Resultaten laden">
    <p className="sr-only">Resultaten laden</p>
    <div className="space-y-2">
      {Array.from({ length: 7 }, (_, index) => (
        <div
          key={`job-skeleton-${index + 1}`}
          className="grid min-h-20 grid-cols-[minmax(0,2fr)_minmax(7rem,0.8fr)] gap-5 rounded-lg border border-border bg-card p-3 min-[800px]:grid-cols-[minmax(0,2fr)_repeat(3,minmax(6rem,0.7fr))]"
        >
          <div className="space-y-2.5">
            <div className="h-3 w-2/3 animate-pulse rounded-sm bg-muted" />
            <div className="h-2.5 w-1/3 animate-pulse rounded-sm bg-muted" />
          </div>
          <div className="h-3 w-3/4 animate-pulse rounded-sm bg-muted" />
          <div className="hidden h-3 w-2/3 animate-pulse rounded-sm bg-muted min-[800px]:block" />
          <div className="hidden h-3 w-1/2 animate-pulse rounded-sm bg-muted min-[800px]:block" />
        </div>
      ))}
    </div>
  </div>
);

export const JobEmptyState = ({
  onReset,
}: {
  readonly onReset: () => void;
}) => (
  <SearchStatePanel
    icon={SearchX}
    title="Geen opdrachten gevonden"
    description="Maak de Boolean-query of actieve filters ruimer. We tonen nooit een lege tabel met nullen."
    action={{ label: "Wis zoekopdracht en filters", onClick: onReset }}
  />
);

export const JobSyntaxErrorState = ({
  message,
  onReset,
}: {
  readonly message: string;
  readonly onReset: () => void;
}) => (
  <SearchStatePanel
    icon={Braces}
    title="Boolean-query klopt nog niet"
    description={message}
    action={{ label: "Terug naar alle opdrachten", onClick: onReset }}
    tone="error"
  />
);

export const JobEngineErrorState = ({
  onRetry,
}: {
  readonly onRetry: () => void;
}) => (
  <SearchStatePanel
    icon={ServerOff}
    title="Zoeken tijdelijk niet beschikbaar"
    description="De zoekengine gaf geen veilig antwoord. Probeer exact dezelfde URL-state opnieuw; er zijn geen wijzigingen uitgevoerd. Referentie: preview-engine-01."
    action={{ label: "Opnieuw proberen", onClick: onRetry }}
    tone="error"
  />
);

export const JobIncompleteState = ({
  onRetry,
}: {
  readonly onRetry: () => void;
}) => (
  <SearchStatePanel
    icon={RefreshCw}
    title="Zoekresultaat is onvolledig"
    description="De zoekmachine bereikte de tijdslimiet voordat alle resultaten bekend waren. Probeer dezelfde zoekopdracht opnieuw; een snapshot blijft geblokkeerd."
    action={{ label: "Opnieuw proberen", onClick: onRetry }}
    tone="error"
  />
);

export const JobIncompleteWarning = ({
  onRetry,
}: {
  readonly onRetry: () => void;
}) => (
  <div
    role="alert"
    className="flex flex-wrap items-center justify-between gap-3 border-b border-chart-2/40 bg-chart-2/10 px-4 py-3"
  >
    <div>
      <p className="text-sm font-medium">Zoekresultaat is onvolledig</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        De zoekmachine bereikte de tijdslimiet. De zichtbare opdrachten zijn
        slechts een deel; een snapshot blijft geblokkeerd.
      </p>
    </div>
    <button
      type="button"
      onClick={onRetry}
      className="min-h-10 rounded-md border border-input bg-background px-3 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      Opnieuw proberen
    </button>
  </div>
);

export const JobInitialState = ({
  onExample,
}: {
  readonly onExample: (query: string) => void;
}) => (
  <div className="grid min-h-[420px] place-items-center p-6 text-center">
    <div className="max-w-xl">
      <span className="mx-auto grid size-12 place-items-center rounded-lg border border-border bg-secondary text-muted-foreground">
        <CircleAlert aria-hidden="true" className="size-5" />
      </span>
      <h2 className="mt-4 font-display text-lg font-semibold tracking-tight">
        Start met een scherpe vraag
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Combineer termen met AND, OR, NOT, haakjes en aanhalingstekens.
      </p>
      <div className="mt-5 grid gap-2 text-left sm:grid-cols-3">
        {["Azure AND data", '"Power BI" OR DAX', "security NOT junior"].map(
          (query) => (
            <button
              key={query}
              type="button"
              onClick={() => onExample(query)}
              className="min-h-11 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              {query}
            </button>
          )
        )}
      </div>
    </div>
  </div>
);
