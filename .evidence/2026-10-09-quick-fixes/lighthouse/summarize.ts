// Median Lighthouse mobile metrics per variant and page -> summary.md / .json
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "lh";
type Row = { cls: number; fcp: number; lcp: number; lcpElement: string; score: number; si: number; tbt: number };
const groups = new Map<string, Row[]>();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".report.json"))) {
  // <variant>-<page>-<run>.report.json
  const [variant, page] = file.split("-");
  const lhr = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const a = lhr.audits;
  const lcpItem = a["largest-contentful-paint-element"]?.details?.items?.[0]?.items?.[0]?.node;
  const row: Row = {
    cls: a["cumulative-layout-shift"].numericValue,
    fcp: a["first-contentful-paint"].numericValue,
    lcp: a["largest-contentful-paint"].numericValue,
    lcpElement: lcpItem ? `${lcpItem.nodeLabel ?? ""} (${lcpItem.selector ?? ""})` : "n/a",
    score: Math.round(lhr.categories.performance.score * 100),
    si: a["speed-index"].numericValue,
    tbt: a["total-blocking-time"].numericValue,
  };
  const key = `${page}|${variant}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}
const median = (xs: number[]) => {
  const s = xs.toSorted((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};
const out: Record<string, unknown>[] = [];
let md = "| page | build | runs | perf | FCP ms | LCP ms | SI ms | TBT ms | CLS | LCP element (median run) |\n|---|---|---|---|---|---|---|---|---|---|\n";
for (const key of [...groups.keys()].toSorted()) {
  const rows = groups.get(key) ?? [];
  const [page, variant] = key.split("|");
  const lcp = median(rows.map((r) => r.lcp));
  const mid = rows.find((r) => r.lcp === lcp);
  const rec = {
    cls: median(rows.map((r) => r.cls)),
    fcp: Math.round(median(rows.map((r) => r.fcp))),
    lcp: Math.round(lcp),
    lcpElement: mid?.lcpElement,
    page,
    runs: rows.length,
    score: median(rows.map((r) => r.score)),
    si: Math.round(median(rows.map((r) => r.si))),
    tbt: Math.round(median(rows.map((r) => r.tbt))),
    variant,
  };
  out.push(rec);
  md += `| /${page} | ${variant} | ${rec.runs} | ${rec.score} | ${rec.fcp} | ${rec.lcp} | ${rec.si} | ${rec.tbt} | ${rec.cls.toFixed(3)} | ${rec.lcpElement} |\n`;
}
writeFileSync(join(dir, "summary.md"), md);
writeFileSync(join(dir, "summary.json"), JSON.stringify(out, null, 2));
console.log(md);
