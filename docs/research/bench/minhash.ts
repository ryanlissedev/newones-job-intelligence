// ponytail: identical algorithm across langs — FNV1a32 shingle, fmix32(h^seed) x128
const N = +process.argv[2] || 20000, PERMS = 128;
let s = 12345 >>> 0; const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
const gen = () => { const w = []; for (let i = 0; i < 300; i++) w.push("w" + (rnd() % 5000)); return w.join(" "); };
const fnv = (str: string) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const fmix = (h: number) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
const seeds = new Uint32Array(PERMS); for (let i = 0; i < PERMS; i++) seeds[i] = rnd();
const docs: string[] = []; for (let i = 0; i < N; i++) docs.push(gen());
const t0 = performance.now(); let acc = 0;
for (const d of docs) {
  const w = d.split(" "); const sig = new Uint32Array(PERMS).fill(0xffffffff);
  for (let i = 0; i + 2 < w.length; i++) { const h = fnv(w[i] + " " + w[i+1] + " " + w[i+2]);
    for (let p = 0; p < PERMS; p++) { const v = fmix(h ^ seeds[p]); if (v < sig[p]) sig[p] = v; } }
  acc ^= sig[0];
}
const ms = performance.now() - t0;
console.log(`bun minhash: ${N} docs in ${ms.toFixed(0)} ms (${(N / ms * 1000).toFixed(0)} docs/s) chk=${acc} rss=${(process.memoryUsage().rss/1e6).toFixed(0)}MB`);
