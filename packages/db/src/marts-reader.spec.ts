import { describe, expect, it } from "bun:test";

import { guardMartsSql } from "./marts-reader";

describe("guardMartsSql", () => {
  it("accepts a plain SELECT and strips the trailing semicolon", () => {
    const result = guardMartsSql("SELECT count(*) FROM aanvraag;");
    expect(result).toEqual({
      ok: true,
      sql: "SELECT count(*) FROM aanvraag",
    });
  });

  it("accepts WITH, VALUES and TABLE heads", () => {
    for (const sql of [
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "VALUES (1, 'a')",
      "TABLE aanvraag",
      "  select 1",
    ]) {
      expect(guardMartsSql(sql).ok).toBe(true);
    }
  });

  it("accepts CASE...END and FETCH FIRST (no keyword false positives)", () => {
    for (const sql of [
      "SELECT CASE WHEN n > 1 THEN 'many' ELSE 'one' END FROM t",
      "SELECT * FROM t FETCH FIRST 10 ROWS ONLY",
    ]) {
      expect(guardMartsSql(sql).ok).toBe(true);
    }
  });

  it("rejects empty and whitespace-only input", () => {
    expect(guardMartsSql("   ").ok).toBe(false);
  });

  it("rejects non-SELECT heads", () => {
    for (const sql of [
      "DELETE FROM aanvraag",
      "INSERT INTO aanvraag VALUES (1)",
      "DROP TABLE aanvraag",
      "UPDATE aanvraag SET x = 1",
      "EXPLAIN SELECT 1",
      "SET search_path = 'public'",
      "SHOW tables",
    ]) {
      expect(guardMartsSql(sql).ok).toBe(false);
    }
  });

  it("rejects statement chaining even inside literals-free SQL", () => {
    expect(guardMartsSql("SELECT 1; DELETE FROM aanvraag").ok).toBe(false);
    expect(guardMartsSql("SELECT 1; SELECT 2").ok).toBe(false);
  });

  it("does not treat a semicolon inside a string literal as chaining", () => {
    const result = guardMartsSql("SELECT ';' AS sep");
    expect(result.ok).toBe(true);
  });

  it("rejects write keywords anywhere in the statement", () => {
    for (const sql of [
      "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
      "SELECT * INTO backup FROM aanvraag",
      "SELECT * FROM aanvraag FOR UPDATE",
      "SELECT * FROM aanvraag FOR KEY SHARE",
      "SELECT pg_catalog.pg_sleep(10)",
    ]) {
      expect(guardMartsSql(sql).ok).toBe(false);
    }
  });

  it("rejects qualification of non-marts schemas", () => {
    for (const sql of [
      "SELECT * FROM public.users",
      "SELECT * FROM curated.aanvraag",
      "SELECT * FROM staging.raw",
      "SELECT * FROM information_schema.tables",
    ]) {
      expect(guardMartsSql(sql).ok).toBe(false);
    }
  });

  it("does not flag schema names inside string literals", () => {
    const result = guardMartsSql("SELECT * FROM t WHERE url LIKE '%public.%'");
    expect(result.ok).toBe(true);
  });

  it("does not flag keywords inside comments or literals", () => {
    for (const sql of [
      "SELECT 'delete this' AS note",
      "SELECT 1 -- drop the nonsense",
      "SELECT 1 /* update later */",
    ]) {
      expect(guardMartsSql(sql).ok).toBe(true);
    }
  });

  it("returns the reason the agent should rewrite against", () => {
    const result = guardMartsSql("DELETE FROM aanvraag");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
