"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ji/ui/components/table";
import { z } from "zod";

/** Rendered row budget — the capability caps at 10k, the widget at 100. */
const DISPLAY_ROW_LIMIT = 100;

interface ToolPartLike {
  readonly errorText?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly state: string;
  readonly toolName?: string;
  readonly type: string;
}

type ToolCell =
  | boolean
  | null
  | number
  | string
  | readonly ToolCell[]
  | { readonly [key: string]: ToolCell };

const toolCellSchema: z.ZodType<ToolCell> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(toolCellSchema),
    z.record(z.string(), toolCellSchema),
  ])
);

const toolErrorOutputSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const queryExecuteOutputSchema = z.object({
  columns: z.array(z.string()),
  mode: z.literal("execute"),
  rowCap: z.number(),
  rows: z.array(z.record(z.string(), toolCellSchema)),
  sql: z.string(),
  truncated: z.boolean(),
});

const queryExplainOutputSchema = z.object({
  mode: z.literal("explain"),
  plan: z.array(z.string()),
  sql: z.string(),
});

const listTablesOutputSchema = z.object({
  tables: z.array(
    z.looseObject({
      columns: z.array(z.looseObject({ name: z.string() })),
      name: z.string(),
    })
  ),
});

const recipesOutputSchema = z.object({
  recipes: z.array(
    z.looseObject({ name: z.string(), question: z.string(), sql: z.string() })
  ),
});

const dictionaryOutputSchema = z.looseObject({
  metrics: z.array(z.looseObject({ name: z.string() })),
  tables: z.array(z.looseObject({ name: z.string() })),
  version: z.string(),
});

const sqlInputSchema = z.looseObject({ sql: z.string() });

type QueryExecuteOutput = z.infer<typeof queryExecuteOutputSchema>;
type QueryExplainOutput = z.infer<typeof queryExplainOutputSchema>;

const toolName = (part: ToolPartLike): string =>
  part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : (part.toolName ?? part.type);

const inputSql = (part: ToolPartLike): string | null => {
  const parsed = sqlInputSchema.safeParse(part.input);
  return parsed.success ? parsed.data.sql : null;
};

const SqlBlock = ({ sql }: { readonly sql: string }) => (
  <details className="group rounded-md border border-border bg-muted/40 text-xs">
    <summary className="cursor-pointer px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground select-none group-open:border-b group-open:border-border">
      SQL
    </summary>
    <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
      {sql}
    </pre>
  </details>
);

const ToolShell = ({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) => (
  <div className="my-1.5 space-y-1.5">
    <p className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
      {title}
    </p>
    {children}
  </div>
);

const PendingWidget = ({ name }: { readonly name: string }) => (
  <ToolShell title={name}>
    <p className="rounded-md border border-border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
      Bezig…
    </p>
  </ToolShell>
);

const ErrorWidget = ({
  message,
  name,
  sql,
}: {
  readonly message: string;
  readonly name: string;
  readonly sql: string | null;
}) => (
  <ToolShell title={name}>
    <div className="space-y-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs">
      <p className="text-destructive">{message}</p>
      {sql ? <SqlBlock sql={sql} /> : null}
    </div>
  </ToolShell>
);

const cellText = (cell: ToolCell): string => {
  if (cell === null) {
    return "—";
  }
  if (Array.isArray(cell) || cell instanceof Object) {
    return JSON.stringify(cell);
  }
  return String(cell);
};

const ExplainWidget = ({ output }: { readonly output: QueryExplainOutput }) => (
  <ToolShell title="query_marts · dry-run">
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
      {output.plan.join("\n")}
    </pre>
    <SqlBlock sql={output.sql} />
  </ToolShell>
);

const ExecuteWidget = ({ output }: { readonly output: QueryExecuteOutput }) => {
  const visible = output.rows.slice(0, DISPLAY_ROW_LIMIT);
  return (
    <ToolShell title={`query_marts · ${output.rows.length} rijen`}>
      <div className="overflow-hidden rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {output.columns.map((column) => (
                <TableHead className="whitespace-nowrap" key={column}>
                  {column}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row, index) => (
              <TableRow key={index}>
                {output.columns.map((column) => (
                  <TableCell
                    className="max-w-64 truncate"
                    key={column}
                    title={cellText(row[column] ?? null)}
                  >
                    {cellText(row[column] ?? null)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {output.rows.length > visible.length ? (
        <p className="text-[11px] text-muted-foreground">
          {visible.length} van {output.rows.length} rijen getoond
        </p>
      ) : null}
      {output.truncated ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          Resultaat afgekapt op {output.rowCap.toLocaleString("nl-NL")} rijen —
          verfijn de query met filters of LIMIT.
        </p>
      ) : null}
      <SqlBlock sql={output.sql} />
    </ToolShell>
  );
};

const QueryMartsWidget = ({ part }: { readonly part: ToolPartLike }) => {
  const error = toolErrorOutputSchema.safeParse(part.output);
  if (error.success) {
    return (
      <ErrorWidget
        message={`${error.data.error.code}: ${error.data.error.message}`}
        name="query_marts"
        sql={inputSql(part)}
      />
    );
  }
  const explain = queryExplainOutputSchema.safeParse(part.output);
  if (explain.success) {
    return <ExplainWidget output={explain.data} />;
  }
  const execute = queryExecuteOutputSchema.safeParse(part.output);
  if (execute.success) {
    return <ExecuteWidget output={execute.data} />;
  }
  return null;
};

const ListTablesWidget = ({ part }: { readonly part: ToolPartLike }) => {
  const error = toolErrorOutputSchema.safeParse(part.output);
  if (error.success) {
    return (
      <ErrorWidget
        message={`${error.data.error.code}: ${error.data.error.message}`}
        name="list_marts_tables"
        sql={null}
      />
    );
  }
  const parsed = listTablesOutputSchema.safeParse(part.output);
  if (!parsed.success) {
    return null;
  }
  const { tables } = parsed.data;
  return (
    <ToolShell title={`list_marts_tables · ${tables.length} tabellen`}>
      {tables.length === 0 ? (
        <p className="rounded-md border border-border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
          Het marts-schema heeft nog geen tabellen.
        </p>
      ) : (
        <ul className="space-y-1 rounded-md border border-border px-2.5 py-2 text-xs">
          {tables.map((table) => (
            <li key={table.name}>
              <span className="font-mono font-medium">{table.name}</span>
              <span className="text-muted-foreground">
                {" "}
                ({table.columns.length} kolommen)
              </span>
            </li>
          ))}
        </ul>
      )}
    </ToolShell>
  );
};

const RecipesWidget = ({ part }: { readonly part: ToolPartLike }) => {
  const parsed = recipesOutputSchema.safeParse(part.output);
  if (!parsed.success) {
    return null;
  }
  const { recipes } = parsed.data;
  return (
    <ToolShell title={`search_query_catalog · ${recipes.length} recepten`}>
      {recipes.length === 0 ? (
        <p className="rounded-md border border-border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
          Geen opgeslagen recept gevonden — de agent schrijft nieuwe SQL.
        </p>
      ) : (
        <ul className="space-y-1 rounded-md border border-border px-2.5 py-2 text-xs">
          {recipes.map((recipe) => (
            <li key={recipe.name}>
              <span className="font-mono font-medium">{recipe.name}</span>
              <span className="text-muted-foreground">
                {" "}
                — {recipe.question}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ToolShell>
  );
};

const DictionaryWidget = ({ part }: { readonly part: ToolPartLike }) => {
  const parsed = dictionaryOutputSchema.safeParse(part.output);
  if (!parsed.success) {
    return null;
  }
  const dictionary = parsed.data;
  return (
    <ToolShell title={`get_data_dictionary · ${dictionary.version}`}>
      <p className="rounded-md border border-border px-2.5 py-2 text-xs text-muted-foreground">
        {dictionary.tables.length} tabellen en {dictionary.metrics.length}{" "}
        metrieken beschreven
      </p>
    </ToolShell>
  );
};

const GenericJsonWidget = ({ part }: { readonly part: ToolPartLike }) => {
  const name = toolName(part);
  let body = "";
  try {
    body = JSON.stringify(part.output, null, 2);
  } catch {
    body = String(part.output);
  }
  return (
    <ToolShell title={name}>
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {body}
      </pre>
    </ToolShell>
  );
};

export const MarktvragenToolPart = ({
  part,
}: {
  readonly part: ToolPartLike;
}) => {
  if (part.state !== "output-available" && part.state !== "output-error") {
    return <PendingWidget name={toolName(part)} />;
  }
  if (part.state === "output-error") {
    return (
      <ErrorWidget
        message={part.errorText ?? "Tool-aanroep mislukt"}
        name={toolName(part)}
        sql={inputSql(part)}
      />
    );
  }
  switch (toolName(part)) {
    case "query_marts": {
      return <QueryMartsWidget part={part} />;
    }
    case "list_marts_tables": {
      return <ListTablesWidget part={part} />;
    }
    case "search_query_catalog": {
      return <RecipesWidget part={part} />;
    }
    case "get_data_dictionary": {
      return <DictionaryWidget part={part} />;
    }
    default: {
      return <GenericJsonWidget part={part} />;
    }
  }
};
