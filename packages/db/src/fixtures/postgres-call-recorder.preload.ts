import { mock } from "bun:test";
import { appendFileSync } from "node:fs";

const record = (event: string): void => {
  const markerPath = process.env.POSTGRES_CALL_MARKER;
  if (markerPath) {
    appendFileSync(markerPath, `${event}\n`);
  }
};

record("loaded");

const fakeSql = Object.assign(
  () => {
    record("query");
    return Promise.resolve([]);
  },
  {
    end: (): Promise<void> => {
      record("end");
      return Promise.resolve();
    },
    unsafe: (): Promise<unknown[]> => {
      record("unsafe");
      return Promise.resolve([]);
    },
  }
);

mock.module("postgres", () => ({
  default: () => {
    record("constructor");
    return fakeSql;
  },
}));
