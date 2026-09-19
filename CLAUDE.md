# ChampSet

Monorepo: `frontend/` (Next.js 16) + `backend/` (Fastify + Mastra). Run with `make dev` (Docker).

Frontend on :3500, backend on :3501, Mastra Studio on :4111, Convex dashboard on :6791.

## Setup

1. Copy `.env.example` to `.env` and fill in your keys:
   - `OPENROUTER_API_KEY` — from https://openrouter.ai/settings/keys
   - `EXA_API_KEY` (optional) — only needed when the Exa web engine is selected; from https://dashboard.exa.ai/api-keys
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — from Clerk API Keys
   - `CLERK_SECRET_KEY` — from Clerk API Keys
   - `CLERK_JWT_ISSUER_DOMAIN` — your Frontend API URL (e.g. `https://your-app.clerk.accounts.dev`)
2. Create a free Clerk account at https://clerk.com and create an application.
3. In the Clerk dashboard, go to **JWT Templates** and enable the **Convex** template.
4. Run `make dev` — starts all Docker services, auto-generates the Convex admin key on first run, and pushes Convex functions. No manual key generation needed.

## Architecture

Auth is Clerk. Frontend uses `@clerk/nextjs` with `ClerkProvider` wrapping the app. Convex validates Clerk JWTs via `convex/auth.config.ts`. Protected routes enforced by Clerk proxy (`frontend/proxy.ts`). No self-hosted auth database.

Dataset storage uses Convex (self-hosted at :3210). Schema in `frontend/convex/schema.ts`, functions in `frontend/convex/datasets.ts` and `frontend/convex/datasetRows.ts`. Convex dashboard at :6791.

Frontend uses Convex React hooks (`useQuery`, `useMutation`) with `ConvexProviderWithClerk` for authenticated realtime queries. Use `useConvexAuth()` (not Clerk's `useAuth()`) to check auth state in components. For backend calls, the frontend uses `useAuth().getToken()` from `@clerk/nextjs` to get a Bearer token and passes it to the API client in `frontend/lib/backend.ts`.

Backend is Fastify + Mastra. Fastify serves the HTTP API (Clerk JWT auth on protected routes via `backend/src/clerk-auth.ts`). Mastra (`backend/src/mastra/`) is the workflow orchestration layer — it wraps pipelines into inspectable workflows with a Studio UI. Both run as separate Docker services sharing the same source code.

The schema inference pipeline: frontend calls `POST /infer-schema` → Fastify verifies the Clerk JWT → calls `inferSchema()` in `backend/src/pipeline/schema-inference.ts` → Claude Sonnet 4.6 via OpenRouter → returns a Zod-validated `DatasetSchema` → frontend maps it to editable columns in the wizard.

The populate pipeline: frontend calls `POST /populate` with `{ datasetId, datasetName, description, columns }` → Fastify verifies the Clerk JWT → triggers `populateWorkflow` which: (1) clears existing rows, (2) builds a prompt from the schema, (3) runs the populate agent (Claude Sonnet 4.6) which searches the web via the self-hosted SearXNG backend (or Exa when that engine is selected), then inserts rows into Convex one by one. Rows appear in realtime on the frontend via Convex reactive queries.

The blog scrape pipeline (optional): a dataset can have `scrapeSources` (blog/domain URLs, `frontend/convex/scrapeSources.ts`). Frontend calls `POST /datasets/:datasetId/scrape` → Fastify starts a LakeStream blog job per enabled source (`POST /api/scrape/execute` with `data_types: ["blog_url","article"]`), records `running`, then a detached finalizer polls `/api/scrape/status/{jobId}`, fetches articles from `/api/exports/json/{jobId}` (needs `LAKESTREAM_API_KEY`), maps them onto the dataset's columns via `backend/src/pipeline/row-mapping.ts`, and inserts rows. LakeStream is a separate self-hosted service; in Docker the backend reaches a host-run instance at `host.docker.internal:3001`. Only blog functionality is integrated — do not add the generic single-URL extractor.

Row accuracy scoring: `backend/src/pipeline/accuracy.ts` asks `ACCURACY_SCORING_MODEL` (OpenRouter; must return logprobs) to grade a row 0-9, converts the digit-token distribution from `top_logprobs` into an expected 0-100 value, and stores it as `datasetRows.accuracyScore`. The OpenRouter AI SDK provider does not forward logprobs into `providerMetadata`, so the scorer calls the chat-completions HTTP API directly (do not try to read logprobs off `generateText`). Wired into `insert_row`/`update_row` (agent) and the LakeStream blog finalizer. Rendered as a fixed "Accuracy Score" column on the dataset page and compare page, and included in CSV/XLSX exports. Scoring failure is non-fatal: the row is inserted without a score.

Convex functions use `ctx.auth.getUserIdentity()` to get the authenticated user. The `ownerId` field on datasets stores `identity.subject` (Clerk user ID). Do not pass `ownerId` from the client.

## Environment Variables

Root `.env` is the only local env file. Docker Compose, package scripts, and Convex CLI helper targets all read it. Key variables:
- `SEARCH_PROVIDER` / `EXA_API_KEY` — select the agent web engine (`searxng` default, or `exa`). SearXNG needs no key; Exa needs `EXA_API_KEY`.
- `OPENROUTER_API_KEY` — used by backend and Mastra for AI model calls
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` — shared by frontend and backend
- `CONVEX_SELF_HOSTED_ADMIN_KEY` — used by backend for system-level Convex writes
- `ACCURACY_SCORING_MODEL` — model that grades each generated row from logprobs (default `openai/gpt-4o-mini`; must support logprobs)
- `LAKESTREAM_URL` / `LAKESTREAM_API_KEY` — optional blog scraping. `LAKESTREAM_API_KEY` is required to import articles; inside Docker the URL defaults to `http://host.docker.internal:3001` (override with `LAKESTREAM_URL_DOCKER`).

The backend container maps `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` → `CLERK_PUBLISHABLE_KEY` (see `docker-compose.dev.yml`).

## Convex Deploys

Convex is self-hosted — it does NOT hot-reload when you edit files in `frontend/convex/`. After changing any Convex function, schema, or auth config, you must run `make convex-push` to deploy the updated code to the running instance. `make dev` does this automatically on startup, but subsequent edits require a manual push.

In CI/prod, run `npx convex deploy` with `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` set as env vars.

This is an open-source (AGPL) project. Do not commit secrets, API keys, or internal docs.
