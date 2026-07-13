# replit-proxy-server

An OpenAI-compatible LLM proxy (TypeScript/Fastify) that sits in front of a
local Ollama server, authenticates users by API token, meters per-user/
per-model token usage, and enforces admin-configured rate limits.

This was imported from GitHub and set up to run fully on Replit, including a
local Ollama instance and the models it depends on.

## Running on Replit

- The `Start application` workflow runs `scripts/start-with-ollama.sh`, which
  starts `ollama serve` (if not already running) and then `npm start`
  (the proxy, listening on port 8000).
- Required models (`llama3.2:1b`, `moondream`) have already been pulled into
  `~/.ollama/models` — they persist across restarts, no need to re-pull.
- Node.js was upgraded to v22 (from the imported default v20) because
  `undici@8` requires Node >= 22.19.
- `ADMIN_API_KEY` defaults to `admin-secret` (see `src/config.ts`); set the
  `ADMIN_API_KEY` env var to change it.

### Verifying

```bash
npm test             # 44 unit/integration tests (no Ollama needed)
npm run typecheck    # strict TypeScript
npm run test:e2e     # end-to-end via the openai SDK against the live proxy + Ollama
```

All of the above pass in this environment.

## User preferences

(none recorded yet)
