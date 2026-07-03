#!/usr/bin/env node
// Zero-dependency load / stress test. Spawns an isolated server, drives N
// requests at concurrency C against read endpoints, reports latency percentiles
// and throughput. Usage: node scripts/loadtest.js [requests] [concurrency]
const { spawnServer } = require('./_spawn.js');

const TOTAL = Number(process.argv[2]) || 2000;
const CONCURRENCY = Number(process.argv[3]) || 50;
const ENDPOINTS = ['/api/opportunities', '/api/stats', '/api/leaderboard'];

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]; }

(async () => {
  console.log(`Load test: ${TOTAL} requests @ concurrency ${CONCURRENCY}`);
  const srv = await spawnServer({ port: 3998 });
  const latencies = [];
  let ok = 0, errors = 0, rateLimited = 0, done = 0;
  const t0 = Date.now();

  async function worker() {
    while (done < TOTAL) {
      done++;
      const url = srv.base + ENDPOINTS[done % ENDPOINTS.length];
      const s = performance.now();
      try {
        const r = await fetch(url);
        const dt = performance.now() - s;
        latencies.push(dt);
        if (r.status === 429) rateLimited++; else if (r.ok) ok++; else errors++;
      } catch { errors++; }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);

  console.log('\n── Results ─────────────────────────────');
  console.log(`Duration        : ${elapsed.toFixed(2)} s`);
  console.log(`Throughput      : ${(TOTAL / elapsed).toFixed(0)} req/s`);
  console.log(`OK / RateLtd / Err : ${ok} / ${rateLimited} / ${errors}`);
  console.log(`Latency mean    : ${(sum / latencies.length).toFixed(1)} ms`);
  console.log(`Latency p50     : ${pct(latencies, 50).toFixed(1)} ms`);
  console.log(`Latency p90     : ${pct(latencies, 90).toFixed(1)} ms`);
  console.log(`Latency p99     : ${pct(latencies, 99).toFixed(1)} ms`);
  console.log(`Latency max     : ${latencies[latencies.length - 1].toFixed(1)} ms`);
  console.log('────────────────────────────────────────');
  console.log(rateLimited > 0 ? 'Note: rate limiter engaged under load (expected protection).' : 'No requests were rate-limited.');

  await srv.stop(); srv.cleanup();
  process.exit(errors > TOTAL * 0.5 ? 1 : 0); // fail only if the server fell over
})();
