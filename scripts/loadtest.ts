/**
 * Load test demonstrating the proxy sustains hundreds of requests per second.
 *
 * Two modes:
 *   npm run loadtest            — proxy backed by the mock server (measures
 *                                 proxy overhead: auth, limits, accounting, piping)
 *   MODE=real npm run loadtest  — proxy backed by real Ollama (measures the
 *                                 whole system; bounded by inference speed)
 *
 * Prerequisites: proxy running on :8000; for the default mode, start the mock
 * with `npx tsx scripts/mock-ollama.ts` and the proxy with
 * `OLLAMA_BASE_URL=http://127.0.0.1:11435 npm start`.
 */
import autocannon from "autocannon";

const PROXY = process.env.PROXY_URL ?? "http://localhost:8000";
const DURATION = Number(process.env.DURATION ?? 15);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 200);

const payload = JSON.stringify({
  model: "llama3.2:1b",
  messages: [{ role: "user", content: "What is 2+2?" }],
  max_tokens: 20,
});

async function main() {
  console.log(`Load testing ${PROXY} — ${CONNECTIONS} connections, ${DURATION}s`);

  const result = await autocannon({
    url: `${PROXY}/v1/chat/completions`,
    method: "POST",
    duration: DURATION,
    connections: CONNECTIONS,
    headers: {
      "content-type": "application/json",
      // Spread traffic across 50 distinct users so per-user accounting is
      // exercised the way real multi-tenant traffic would.
      authorization: "Bearer placeholder",
    },
    requests: Array.from({ length: 50 }, (_, i) => ({
      method: "POST" as const,
      path: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer loadtest-user-${i}`,
      },
      body: payload,
    })),
  });

  console.log(`
  Requests/sec  avg=${result.requests.average}  max=${result.requests.max}
  Latency (ms)  avg=${result.latency.average}  p50=${result.latency.p50}  p97_5=${result.latency.p97_5}  p99=${result.latency.p99}
  Throughput    ${(result.throughput.average / 1024 / 1024).toFixed(1)} MB/s
  2xx=${result["2xx"]}  non2xx=${result.non2xx}  errors=${result.errors}  timeouts=${result.timeouts}
`);

  if (result.requests.average < 200) {
    console.error("FAIL: below 200 req/s target");
    process.exit(1);
  }
  console.log("PASS: sustained hundreds of requests per second.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
