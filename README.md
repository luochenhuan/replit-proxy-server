# replit-proxy-server

An OpenAI-compatible LLM proxy in TypeScript. It sits in front of a local [Ollama](https://ollama.com) server, authenticates users by API token, meters token usage per user per model, and enforces admin-configured usage limits — the billing/limiting control point described in the take-home prompt.

## Quick start

```bash
# Prerequisites: Node 20+, Ollama running with the models pulled
ollama pull llama3.2:1b && ollama pull moondream

npm install
npm start            # proxy listens on http://localhost:8000
```

Use it exactly like the OpenAI API:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="my-user-token")

response = client.chat.completions.create(
    model="llama3.2:1b",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is 2+2?"},
    ],
    temperature=0.7,
    max_tokens=100,
)
```

Both `base_url="http://localhost:8000"` and `.../v1` work (routes are registered under both prefixes, since SDKs differ in what they append).

### Verifying

```bash
npm test             # 35 unit/integration tests (no Ollama needed)
npm run typecheck    # strict TypeScript
npm run test:e2e     # end-to-end via the `openai` SDK against live Ollama:
                     #   chat, streaming, moondream vision, usage API, 429 enforcement

# Load test (measures the proxy itself, using an instant mock model server):
npx tsx scripts/mock-ollama.ts &
OLLAMA_BASE_URL=http://127.0.0.1:11435 LOG_LEVEL=warn npm start &
npm run loadtest
```

Measured on a MacBook (single Node process, 200 concurrent connections, 50 distinct users, 15s):

```
Requests/sec  avg=10,875   max=11,237
Latency (ms)  avg=17.9  p50=17  p97.5=23  p99=24
2xx=163,134  errors=0  timeouts=0
```

Post-run accounting was exact: recorded tokens equaled `requests × tokens-per-response` with zero drift, confirming usage metering is loss-free under concurrency.

## API surface

### User endpoints (authenticated by `Authorization: Bearer <user-token>`)

| Route | Description |
|---|---|
| `POST /v1/chat/completions` | Proxied to Ollama; streaming and vision supported |
| `POST /v1/completions` | Legacy completions, proxied |
| `GET /v1/models` | Passthrough |
| `GET /v1/usage` | The caller's per-model token usage, lifetime totals, and current limits |
| `GET /healthz` | Unauthenticated health check |

`GET /v1/usage` example response:

```json
{
  "user_id": "user_1c9f2a...",
  "models": {
    "llama3.2:1b": { "prompt_tokens": 70, "completion_tokens": 29, "total_tokens": 99, "requests": 2 },
    "moondream":   { "prompt_tokens": 744, "completion_tokens": 85, "total_tokens": 829, "requests": 1 }
  },
  "totals": { "prompt_tokens": 814, "completion_tokens": 114, "total_tokens": 928, "requests": 3 },
  "limits": null
}
```

### Admin endpoints (authenticated by `Authorization: Bearer $ADMIN_API_KEY`, default `admin-secret`)

| Route | Description |
|---|---|
| `GET /admin/usage` | Usage overview across all users |
| `GET /admin/limits` | All configured limits |
| `GET /admin/limits/:userId` | One user's limits |
| `PUT /admin/limits/:userId` | Create/replace limits (validated) |
| `DELETE /admin/limits/:userId` | Remove limits (back to unlimited) |

Limit config shape — every field optional, but at least one limit required:

```json
{
  "shortTerm": { "windowSeconds": 60,    "maxRequests": 100, "maxTokens": 50000 },
  "longTerm":  { "windowSeconds": 86400, "maxTokens": 2000000 },
  "total":     { "maxTokens": 100000000 }
}
```

When a limit trips, the proxy returns **429** with an OpenAI-shaped error body and a `Retry-After` header, so `openai` SDK clients raise their native `RateLimitError` (verified in the e2e suite).

### Configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Listen port |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama model server URL |
| `ADMIN_API_KEY` | `admin-secret` | Admin API bearer token |
| `SERVER_CONNECTIONS` | `128` | Keep-alive socket pool size to the model server |
| `LOG_LEVEL` | `info` | Pino log level |

## Architecture

```
                          ┌────────────────────────────────────────────────┐
 OpenAI SDK clients ────► │  Fastify (port 8000)                           │
                          │                                                │
                          │  auth hook ─► Limiter.check ─► ProxyHandler ───┼──► undici Pool ──► Ollama
                          │                   │                 │          │    (keep-alive
                          │             LimitStore        SseUsageScanner  │     sockets)
                          │                   │                 │          │
 Admin (separate key) ──► │  /admin/*     UsageStore ◄─────record          │
 Users ─────────────────► │  /v1/usage        │                            │
                          └───────────────────┴────────────────────────────┘
```

```
src/
  config.ts                 env-driven config, parsed once at startup
  auth.ts                   bearer-token → userId mapping
  errors.ts                 OpenAI-shaped error envelope
  types.ts                  shared domain types (Usage, LimitConfig, ...)
  app.ts                    composition root — wires everything, testable via inject()
  server.ts                 entry point + graceful shutdown
  proxy/
    model-server.ts         undici connection pool to Ollama (the model server)
    proxy-handler.ts        request lifecycle: limit-check → forward → observe → record
    usage-extractor.ts      usage from JSON bodies and (incrementally) from SSE streams
  limits/limiter.ts         limit evaluation + admin config validation
  store/
    usage-store.ts          UsageStore interface + in-memory lifetime-aggregate impl
    limit-store.ts          LimitStore interface + in-memory impl
    window-counter-store.ts WindowCounterStore — staggered fixed-window counters
scripts/
  e2e.ts                    end-to-end suite using the `openai` SDK
  loadtest.ts               autocannon load test (multi-user traffic)
  mock-ollama.ts            instant model server for isolating proxy throughput
test/                       unit + integration tests (vitest, fake model server)
```

**Request lifecycle** for a completion:

1. Auth hook extracts the bearer token; the user's identity is the SHA-256 of the token (raw keys never appear in logs or admin output).
2. `Limiter.check` evaluates total → short-term → long-term limits against recorded usage. Violations return 429 **before any model server work is done** — throttled users cost nothing.
3. The body is forwarded to Ollama over a keep-alive connection pool. For streaming requests the proxy injects `stream_options.include_usage: true` so the terminal SSE chunk always carries token counts.
4. The response is piped back verbatim. A scanner *observes* the bytes in flight to extract usage — it never buffers or modifies the stream — and records usage when the response completes.

## Design decisions and trade-offs

### Language & framework: TypeScript + Fastify + undici

- **Node's event loop is the right shape for this workload.** An LLM proxy is almost pure I/O: thousands of long-lived streams with tiny per-request CPU. A single Node process handles this without thread tuning. Go would also be a fine choice. Python (asyncio) can absolutely build this — LiteLLM is the existence proof — but this design inspects every SSE chunk on the hot path, which in CPython runs as interpreted bytecode under the GIL; the expected per-process throughput is several times lower, forcing multi-worker + shared-state (Redis) architecture much earlier. Node lets one process with in-memory state cover this exercise's scale with large headroom (measured below).
- **Fastify over Express**: ~3-5× higher throughput, first-class async/await, schema-oriented, structured logging (pino) built in.
- **undici `Pool` over `fetch`/axios**: connection reuse is mandatory at this RPS — a client that opens a fresh TCP connection per request accumulates sockets in `TIME_WAIT` (60s) and exhausts ephemeral ports within seconds at thousands of req/s. Given reuse, `Pool` is chosen for two things the alternatives don't give cleanly: a **bounded connection count** (`connections: 128` acts as admission control — a traffic spike queues in the proxy instead of becoming a connection storm against the inference server; axios's underlying agent defaults to unbounded sockets), and the **headers-vs-body-inactivity timeout split** (fail fast if the model server never starts responding, separately detect a stream that goes quiet mid-response — a single whole-request timeout can't cap hangs without also killing legitimately long streams). It's also the lowest-overhead path: Node's built-in `fetch` is itself implemented on undici, but adds the WHATWG spec layer and hides these knobs behind a custom dispatcher.
- Deliberately **no proxy framework** (http-proxy, etc.) — the prompt requires the proxy logic be my own, and the interesting parts (usage observation mid-stream) need custom code anyway.

### Streaming: observe, don't buffer

The streaming path pipes model server bytes straight to the client while an incremental SSE scanner watches for the terminal usage chunk. Options considered:

1. **Buffer the whole stream, parse at the end** — simple, but destroys time-to-first-token (the entire point of streaming) and holds O(response) memory per request. Rejected.
2. **Re-parse and re-emit SSE events** — allows rewriting chunks but risks corrupting output for edge-case events and adds latency. Rejected: the proxy's contract is byte-for-byte fidelity so every OpenAI SDK behaves identically against it.
3. **Tap the stream (chosen)** — memory is O(one partial line) per in-flight stream, zero added latency, response bytes untouched. Backpressure is honored (`write()` return value + `drain`), so a slow client can't force unbounded buffering inside the proxy.

To guarantee usage is present, the proxy force-injects `stream_options.include_usage` into model server streaming requests. Trade-off: clients that didn't ask for usage receive one extra terminal chunk. OpenAI SDKs tolerate this (verified e2e); the alternative — estimating tokens ourselves with a tokenizer — would drift from what Ollama actually counts and double-bills nobody knows how.

### Billing accuracy: check-then-record (bounded overshoot)

Token counts are only knowable **after** a request completes, so limits are checked before forwarding against already-recorded usage. Consequence: a user can overshoot a *token* cap by at most one request's worth. Alternatives:

- **Pre-reserve estimated tokens, reconcile after** — rejects legitimate requests when estimates are wrong, needs a tokenizer per model, adds a reconciliation path. Not worth it: `max_tokens` bounds the overshoot anyway, and this is the same trade-off commercial metered APIs make.
- **Kill streams mid-flight when a cap is crossed** — hostile UX (truncated answers you still pay for) for marginal cost protection.

Request-count limits have no slack — the N+1th request in a window is rejected exactly.

Failure-mode choices: HTTP-error responses from Ollama record no usage (nothing was generated). A stream that dies before its usage chunk logs a warning and records nothing — under-billing, deliberately: when accounting is uncertain, err in the user's favor and make it observable.

### Rate limiting: staggered fixed-window counters

The same algorithm used by LiteLLM's limiter (modeled on Envoy's rate limit service): each (user, window) pair holds one counter and the epoch millis at which its current window began. The window starts at the first recorded usage after expiry — staggered per user, not clock-aligned — and resets lazily on the next read or write once `windowSeconds` have elapsed. Storage is O(1) per user per configured window (two counters = ~200 bytes) regardless of traffic volume.

- **Accepted trade-off: 2× boundary burst.** A user can consume up to twice the cap across one window boundary (fill the tail of window N, then the head of window N+1). The exact-sliding-window alternative (a per-event log with backward scan) closes that gap but costs O(events-per-24h) storage per user — ~12 MB/user at 1 req/s, vs. 200 bytes. Production limiters universally choose the fixed-window approximation; LiteLLM, Envoy, and `rate-limiter-flexible` all do.
- **Why not an event log?** Billing only needs lifetime aggregates (O(users × models), already in `UsageStore`). The event log existed solely to serve window queries for rate limiting. Moving to O(1) counters eliminates that cost entirely while keeping the same three limit axes.
- **`retryAfterSeconds` is exact**: `windowStart + window − now`, not a heuristic fraction — clients know precisely when to retry.

Three limit axes map directly to the prompt: `shortTerm` (burst control), `longTerm` (daily/monthly budgets), `total` (lifetime cap → in-arrears billing cutoff). Only usage recorded *after* a limit is configured counts against it — pre-existing usage is not back-counted.

### State: in-memory behind storage interfaces

Usage, limits, and window counters live in memory behind `UsageStore` / `LimitStore` / `WindowCounterStore` interfaces. This is the honest choice for a single-process exercise — no external infra to run, and the request path stays synchronous (no per-request store I/O), which is why the proxy does 10k+ req/s.

The interfaces are the scaling seam. Multiple proxy instances behind a load balancer would share a Redis/Postgres-backed implementation; the request-path code doesn't change. Window counters map directly to Redis keys with TTL (LiteLLM's v3 limiter uses exactly this: a Lua script atomically checks-and-increments counter keys per descriptor). A production version would also flush usage aggregates asynchronously (write-behind) rather than synchronously awaiting the store, accepting seconds of limit-enforcement lag across instances in exchange for keeping the hot path fast — rate limiting tolerates slight staleness; billing reconciles from the durable aggregate log.

Restart durability is out of scope here; in production the usage aggregates would be the billing source of truth and must be durable (append to a log/queue, aggregated by a separate billing service).

### Auth: identity = hash of token

Any non-empty bearer token is accepted and the user id is `sha256(token)` truncated. Rationale: the prompt says each user *has* a token that identifies them, and key issuance/validation is a separate service in the real system. Hashing keeps raw credentials out of logs, metrics, and admin responses (admins address users by opaque id). Swapping `identify()` for a key-database lookup is a one-function change; nothing else in the codebase sees tokens.

The admin API is a **separate trust domain**: its own key (`ADMIN_API_KEY`), its own route scope, 403 on everything without it.

### Reliability

- **Client disconnects abort model server work** (`AbortController` wired to the response socket) — abandoned requests don't keep burning inference compute.
- **Backpressure** on the streaming path — a slow reader stalls its own stream instead of growing proxy memory.
- **Timeouts** on model server headers (120s) and body inactivity (300s) so a hung Ollama can't leak connections; failures surface as OpenAI-shaped 502s.
- **Graceful shutdown** on SIGINT/SIGTERM: stop accepting, drain in-flight requests, close the model server pool.
- **Bounded memory everywhere**: SSE scanner caps its line buffer (1 MB), body limit 20 MB (vision images), event logs pruned by retention.
- **Errors are OpenAI-shaped** at every layer, so SDK clients get typed exceptions (`RateLimitError`, `APIError`) rather than opaque failures.

### Performance demonstration

"Hundreds of requests per second" is a property of the *proxy*, not of a 1B-parameter model on a laptop — real inference saturates at a few req/s regardless of how good the proxy is. So the load test isolates the proxy with a mock model server that responds instantly with an OpenAI-shaped body: every proxy code path (auth, limit check, pool round-trip, usage parse, accounting across 50 concurrent users) runs for real; only the model doesn't. Result: **~10,900 req/s, p99 = 24 ms, zero errors, zero accounting drift** — ~50× the "hundreds" bar. The e2e suite separately proves correctness against real Ollama end-to-end.

## Testing strategy

| Layer | What | How |
|---|---|---|
| Unit | usage store, window-counter store, limiter, config validation, SSE scanner (incl. byte-by-byte chunk fragmentation, malformed JSON) | vitest, pure in-memory |
| Integration | full HTTP surface: auth, both route prefixes, streaming usage injection, 429s, admin CRUD, user isolation | `fastify.inject()` + fake model server — no network, no Ollama |
| End-to-end | the `openai` SDK against live proxy + live Ollama: chat, streaming, moondream vision (Lorem Picsum image), usage API, limit enforcement, restore | `npm run test:e2e` |
| Load | 200 connections, 50 users, 15s, accounting verified after | `npm run loadtest` |

## Dependencies installed

Runtime:

- **fastify** — HTTP server framework (routing, hooks, pino logging, high throughput)
- **undici** — model server HTTP client; `Pool` provides bounded keep-alive connections to Ollama

Dev-only:

- **typescript** — strict type checking
- **tsx** — run TypeScript directly (dev server, scripts)
- **vitest** — unit/integration test runner
- **@types/node** — Node type definitions
- **openai** — official SDK, used only to *test* the proxy as the prompt requires (not by the proxy itself)
- **autocannon** — HTTP load generator for the throughput demonstration

## Not yet implemented (by design)

- The **bonus feature** was explicitly deferred per instructions.
- Durable/distributed storage, real key management, per-model pricing (billing here is in tokens; multiplying by a price table is trivial once prices exist), and horizontal scaling are discussed above as the natural next steps along the existing interfaces.
