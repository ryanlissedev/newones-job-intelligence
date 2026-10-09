import { InMemorySearchEngine } from "./in-memory-engine";
import { MemoryResultCache } from "./cache/result-cache";
const which = process.argv[2];
const { SearchAdapter } = await import(which === "orig" ? "./adapter.orig" : "./adapter");
const SECONDS = 600; const QUERIES = ["Azure","Java","Python","SAP","Scrum","Data","DevOps","Security","Cloud","Frontend"];
const scenario = process.argv[3] ?? "bursts"; const advancesAt = (s: number) => { if (scenario === "sustained") return s % 3 === 0; const c = s % 140; return c < 40 && c % 2 === 0; };
let now = 0; const engine = new InMemorySearchEngine(); let versionReads = 0;
const counted = { applyBatch: (b: any) => engine.applyBatch(b), deleteDocument: (id: string) => engine.deleteDocument(id), getAppliedVersion: () => { versionReads++; return engine.getAppliedVersion(); }, search: (p: any) => engine.search(p), upsertDocument: (d: any) => engine.upsertDocument(d) };
const adapter = new SearchAdapter({ cache: new MemoryResultCache(500, () => now), engine: counted as any, versionPin: { now: () => now } });
let seq = 1n; await engine.applyBatch({ appliedSequence: seq, mutations: [] });
let hits = 0, misses = 0, versions = 0;
for (let s = 0; s < SECONDS; s++) { now = s * 1000; if (advancesAt(s)) { seq++; versions++; await engine.applyBatch({ appliedSequence: seq, mutations: [] }); }
  const r: any = await adapter.search({ query: QUERIES[s % QUERIES.length] }); if (r.ok && r.cache === "hit") hits++; else misses++; await Promise.resolve(); }
const vReadsDuringSearch = versionReads;
console.log(JSON.stringify({ scenario, adapter: which === "orig" ? "main (a4ff669)" : "this PR", simulatedSeconds: SECONDS, searches: SECONDS, distinctQueries: QUERIES.length, sequenceAdvances: versions, hits, misses, hitRate: +(hits / SECONDS).toFixed(3), versionReads: vReadsDuringSearch, awaitedVersionReadsBeforeCacheLookup: which === "orig" ? SECONDS : 1 }));
