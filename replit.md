# replit-proxy-server

An OpenAI-compatible LLM proxy written with TypeScript and Fastify.
It can use either local Ollama or Ollama Cloud, authenticates users by API token, meters per-user and per-model token usage, enforces admin-configured rate limits, and serves web dashboards for users and admins.

This was imported from GitHub and configured to use Ollama Cloud when published on Replit while preserving an explicit local Ollama workflow for development.

## Running on Replit

- The published Autoscale deployment runs `npm run start:seeded`, which seeds the SQLite database before starting the proxy and does not attempt to start Ollama inside Replit.
- Set the production secret `OLLAMA_BASE_URL=https://ollama.com`.
- Set the production secret `OLLAMA_API_KEY` to an Ollama Cloud API key.
- Set `ADMIN_API_KEY` to a separate strong value because it protects the proxy's administrative routes.
- The `Start application` development workflow runs `npm run start:local:seeded`, which seeds the SQLite database before starting the local Ollama development environment.
- Local mode starts `ollama serve` when necessary, pulls `llama3.2:1b` and `moondream`, clears inherited cloud credentials, and starts the proxy on port 8000.
- Node.js v22 is configured because `undici@8` requires Node 22.19 or newer and the SQLite backend uses `node:sqlite`.
- Storage defaults to SQLite at `data/meter.db`, which is required for the startup seed data.
- Do not set `STORAGE=memory` with either seeded startup command because the seed exits with an error and prevents the proxy from starting when data cannot be shared between processes.

### Web dashboards

- `/` - landing page
- `/dashboard` - user dashboard where a user token provides access to usage and history
- `/admin/dashboard` - admin dashboard where the admin key provides access to limits and fleet-wide usage and costs

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
