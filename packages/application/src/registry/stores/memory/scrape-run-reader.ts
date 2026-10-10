import type {
  ScrapeRunListQuery,
  ScrapeRunReader,
  ScrapeRunView,
} from "../types";

const encodeCursor = (gestart: Date, id: string): string =>
  `${gestart.toISOString()}|${id}`;

export class MemoryScrapeRunReader implements ScrapeRunReader {
  private readonly runs: ScrapeRunView[] = [];

  seed(run: ScrapeRunView): void {
    this.runs.push(run);
  }

  getById(id: string): Promise<ScrapeRunView | null> {
    return Promise.resolve(this.runs.find((run) => run.id === id) ?? null);
  }

  list(query: ScrapeRunListQuery): Promise<{
    readonly items: readonly ScrapeRunView[];
    readonly nextCursor: string | null;
  }> {
    const filtered = this.runs
      .filter(
        (run) =>
          (!query.bronId || run.bronId === query.bronId) &&
          (!query.status || run.status === query.status) &&
          (!query.failureCode || run.failureCode === query.failureCode) &&
          (!query.runKind ||
            query.runKind === "all" ||
            run.runKind === query.runKind) &&
          (!query.since || run.gestart >= query.since)
      )
      .toSorted(
        (left, right) =>
          right.gestart.getTime() - left.gestart.getTime() ||
          right.id.localeCompare(left.id)
      );

    let start = 0;
    const { cursor } = query;
    if (cursor) {
      const index = filtered.findIndex(
        (run) => encodeCursor(run.gestart, run.id) < cursor
      );
      start = Math.max(0, index);
    }

    const limit = query.limit ?? 50;
    const items = filtered.slice(start, start + limit);
    const last = items.at(-1);
    const nextCursor =
      filtered.length > start + items.length && last
        ? encodeCursor(last.gestart, last.id)
        : null;
    return Promise.resolve({ items, nextCursor });
  }
}
