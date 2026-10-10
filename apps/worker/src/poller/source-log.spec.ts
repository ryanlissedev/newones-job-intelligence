import { describe, expect, it } from "bun:test";

import {
  alreadyRunningSourceLog,
  failedSourceLog,
  MAX_ERROR_MESSAGE_LENGTH,
  redactErrorMessage,
} from "./source-log";

const base = { bronSlug: "harveynash", durationMs: 1234 } as const;

describe("alreadyRunningSourceLog", () => {
  it("reports a clean skip without an error envelope", () => {
    expect(alreadyRunningSourceLog(base)).toEqual({
      bronSlug: "harveynash",
      curated: 0,
      durationMs: 1234,
      found: 0,
      remaining: 0,
      skippedReason: "already_running",
    });
  });
});

describe("failedSourceLog", () => {
  it("truncates a long message to the cap", () => {
    const message = `boom ${"x".repeat(1000)}`;
    const log = failedSourceLog({ ...base, error: new Error(message) });

    expect(log.errorMessage).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(log.errorMessage).toBe(message.slice(0, MAX_ERROR_MESSAGE_LENGTH));
    expect(log.errorName).toBe("Error");
    expect(log.bronSlug).toBe("harveynash");
    expect(log.durationMs).toBe(1234);
  });

  it("keeps a short message whole", () => {
    const log = failedSourceLog({
      ...base,
      error: new Error("HTTP 503 from /vacancies"),
    });

    expect(log.errorMessage).toBe("HTTP 503 from /vacancies");
  });

  it("reports zero volume so a failure cannot read as a successful poll", () => {
    const log = failedSourceLog({ ...base, error: new Error("nope") });

    expect(log.curated).toBe(0);
    expect(log.found).toBe(0);
    expect(log.remaining).toBe(0);
  });

  it("names a non-Error throw without inventing a message", () => {
    const log = failedSourceLog({ ...base, error: "plain string" });

    expect(log.errorName).toBe("UnknownError");
    expect(log.errorMessage).toBe("plain string");
  });

  it("omits errorMessage when the error carries none", () => {
    const error = new Error("cleared below");
    error.message = "";
    const log = failedSourceLog({ ...base, error });

    expect(log.errorMessage).toBeUndefined();
    expect(Object.hasOwn(log, "errorMessage")).toBe(false);
  });

  it("joins the cause chain so the message that names the failure survives", () => {
    // The CTP-499 shape: the outermost message identifies nothing.
    const error = new Error("Curation failed for observation 7100e5cb", {
      cause: new Error("Failed query: insert into dedup_groep", {
        cause: new Error(
          "index row size 3368 exceeds btree version 4 maximum 2704"
        ),
      }),
    });

    expect(failedSourceLog({ ...base, error }).errorMessage).toBe(
      "Curation failed for observation 7100e5cb <- Failed query: insert into dedup_groep <- index row size 3368 exceeds btree version 4 maximum 2704"
    );
  });

  it("stops at four levels rather than following an unbounded chain", () => {
    let error = new Error("level5");
    for (const label of ["level4", "level3", "level2", "level1"]) {
      error = new Error(label, { cause: error });
    }

    expect(failedSourceLog({ ...base, error }).errorMessage).toBe(
      "level1 <- level2 <- level3 <- level4"
    );
  });

  it("does not loop on a self-referencing cause", () => {
    const error = new Error("outer");
    error.cause = error;

    expect(failedSourceLog({ ...base, error }).errorMessage).toBe("outer");
  });

  it("skips an empty link rather than leaving a dangling separator", () => {
    const blank = new Error("cleared below");
    blank.message = "";
    blank.cause = new Error("the real one");
    const error = new Error("outer", { cause: blank });

    expect(failedSourceLog({ ...base, error }).errorMessage).toBe(
      "outer <- the real one"
    );
  });

  it("redacts a connection string carried by a nested cause", () => {
    const error = new Error("poll failed", {
      cause: new Error("connect ECONNREFUSED postgres://ji_app:hunter2@h/d"),
    });
    const log = failedSourceLog({ ...base, error });

    expect(log.errorMessage).toBe(
      "poll failed <- connect ECONNREFUSED [redacted]"
    );
    expect(log.errorMessage).not.toContain("hunter2");
  });

  it("truncates a long chain to the cap", () => {
    const error = new Error("x".repeat(200), {
      cause: new Error("y".repeat(400)),
    });

    expect(failedSourceLog({ ...base, error }).errorMessage).toHaveLength(
      MAX_ERROR_MESSAGE_LENGTH
    );
  });

  it("carries a custom error name", () => {
    const error = new Error("gateway timeout");
    error.name = "FetchError";

    expect(failedSourceLog({ ...base, error }).errorName).toBe("FetchError");
  });
});

describe("redactErrorMessage", () => {
  it("strips a postgres connection string with its password", () => {
    const redacted = redactErrorMessage(
      "connect ECONNREFUSED postgres://ji_app:hunter2@10.0.0.4:5432/ji tail"
    );

    expect(redacted).toBe("connect ECONNREFUSED [redacted] tail");
    expect(redacted).not.toContain("hunter2");
  });

  it("strips the postgresql:// spelling and every occurrence", () => {
    const redacted = redactErrorMessage(
      "postgresql://a:b@h/d and postgresql://c:d@h/d"
    );

    expect(redacted).toBe("[redacted] and [redacted]");
  });

  it("redacts before truncating so a cut cannot leave a password", () => {
    const redacted = redactErrorMessage(
      `${"p".repeat(MAX_ERROR_MESSAGE_LENGTH - 10)}postgres://ji_app:hunter2@h/d`
    );

    expect(redacted).not.toContain("hunter2");
    expect(redacted).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
  });

  it("leaves a message without a connection string untouched", () => {
    expect(redactErrorMessage("HTTP 429 from bluetrail")).toBe(
      "HTTP 429 from bluetrail"
    );
  });
});
