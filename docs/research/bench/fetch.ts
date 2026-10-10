const TOTAL = 2000, C = 50; let done = 0, t0 = performance.now();
async function w() { while (done < TOTAL) { done++; const r = await fetch("http://127.0.0.1:4567/"); await r.text(); } }
await Promise.all(Array.from({ length: C }, w));
console.log(`bun fetch: ${TOTAL} reqs c=${C} in ${(performance.now()-t0).toFixed(0)}ms maxRSS=${(process.resourceUsage().maxRSS/1e6).toFixed(0)}MB rss=${(process.memoryUsage().rss/1e6).toFixed(0)}MB`);
