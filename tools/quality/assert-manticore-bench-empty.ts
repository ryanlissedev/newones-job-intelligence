#!/usr/bin/env bun
/**
 * RJC-400: refuse a dirty local Manticore bench table before relevance/bench.
 * Uses SELECT COUNT(*) (never /search limit:0). Skips when MANTICORE_URL is
 * unset unless BENCH_REQUIRE_MANTICORE=1 or MANTICORE_REQUIRE_LIVE=1.
 */
import {
  assertCleanManticoreTables,
  requireManticoreUrl,
} from "../../benchmarks/manticore-hygiene";

export const runAssertManticoreBenchEmpty = async (
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch
): Promise<"ok" | "skipped"> => {
  const required =
    env.BENCH_REQUIRE_MANTICORE === "1" || env.MANTICORE_REQUIRE_LIVE === "1";
  const url = requireManticoreUrl(env.MANTICORE_URL, required);
  if (!url) {
    return "skipped";
  }
  await assertCleanManticoreTables(
    "manticore-bench-empty",
    url,
    "before",
    request
  );
  return "ok";
};

if (import.meta.main) {
  const result = await runAssertManticoreBenchEmpty();
  if (result === "skipped") {
    console.log("check:manticore-bench-empty: skipped (MANTICORE_URL unset)");
  } else {
    console.log("check:manticore-bench-empty: ok");
  }
}
