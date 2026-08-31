import { performance } from "node:perf_hooks";

const baseUrl = process.env.COHORT_BASE_URL;
const path = process.env.COHORT_LOAD_PATH || "/healthz";
const requests = Number(process.env.COHORT_LOAD_REQUESTS || 500);
const concurrency = Number(process.env.COHORT_LOAD_CONCURRENCY || 25);

if (!baseUrl) throw new Error("COHORT_BASE_URL is required");
if (!Number.isInteger(requests) || requests < 1 || requests > 100_000) throw new Error("COHORT_LOAD_REQUESTS must be between 1 and 100000");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 500) throw new Error("COHORT_LOAD_CONCURRENCY must be between 1 and 500");

let next = 0;
let failures = 0;
const durations = [];

async function worker() {
  while (true) {
    const index = next++;
    if (index >= requests) return;
    const start = performance.now();
    try {
      const response = await fetch(new URL(path, baseUrl));
      if (!response.ok) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    } finally {
      durations.push(performance.now() - start);
    }
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsed = performance.now() - started;
durations.sort((left, right) => left - right);
const percentile = (value) => durations[Math.min(durations.length - 1, Math.floor(durations.length * value))];

console.log(JSON.stringify({
  requests,
  concurrency,
  failures,
  elapsed_ms: Math.round(elapsed),
  requests_per_second: Number((requests / (elapsed / 1000)).toFixed(1)),
  latency_ms: {
    p50: Number(percentile(0.5).toFixed(1)),
    p95: Number(percentile(0.95).toFixed(1)),
    p99: Number(percentile(0.99).toFixed(1)),
  },
}, null, 2));

if (failures > 0) process.exitCode = 1;
