# replit-proxy-server

An OpenAI-compatible LLM proxy (TypeScript/Fastify) that sits in front of a
local Ollama server, authenticates users by API token, meters per-user/
per-model token usage, enforces admin-configured rate limits, and serves
web dashboards for users and admins.

This was imported from GitHub and set up to run fully on Replit, including a
local Ollama instance and the models it depends on.

## Running on Replit

- The `Start application` workflow runs `scripts/start-with-ollama.sh`, which
  starts `ollama serve` (if not already running), pulls the required models
  if they are missing, and then runs `npm start` (the proxy on port 8000).
- Required models (`llama3.2:1b`, `moondream`) are pulled automatically on
  first start; they persist in `~/.ollama/models` across restarts.
- Node.js was upgraded to v22 (from the imported default v20) because
  `undici@8` requires Node >= 22.19 and the SQLite backend uses `node:sqlite`
  (built into Node 22.5+).
- `ADMIN_API_KEY` defaults to `admin-secret` (see `src/config.ts`); set the
  `ADMIN_API_KEY` env var to change it.
- Storage defaults to SQLite (`data/meter.db`); set `STORAGE=memory` to use
  ephemeral in-memory stores instead.

### Web dashboards

- `/` — landing page
- `/dashboard` — user dashboard (enter your user token to see usage/history)
- `/admin/dashboard` — admin dashboard (enter the admin key to manage limits
  and view fleet-wide usage/costs)

### Verifying

```bash
npm test             # 71 unit/integration tests (no Ollama needed)
npm run typecheck    # strict TypeScript
npm run test:e2e     # end-to-end via the openai SDK against the live proxy + Ollama
npm run seed         # populate the DB with synthetic demo data for the dashboards
```

All of the above pass in this environment.

## User preferences

(none recorded yet)
