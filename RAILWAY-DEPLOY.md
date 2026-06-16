# Deploying ChampSet to Railway

ChampSet ships as a 6-service Docker Compose stack (`DEPLOY.md`, written for a
single VPS). Railway runs one container per service and provides TLS + edge,
so Caddy is dropped and the stack is split into 5 Railway services in one
project. This runbook is the Railway equivalent of `DEPLOY.md`.

## Service topology

| Railway service | Source | Exposed | Notes |
|---|---|---|---|
| `postgres` | Railway Postgres plugin | internal | Replaces the compose `db`. Gives `DATABASE_URL`. |
| `convex` | image `ghcr.io/get-convex/convex-backend` | `3210` (api), `3211` (site) | Stateful: attach a Railway Volume at `/convex/data`. Points at `postgres`. |
| `searxng` | image `searxng/searxng` (+ repo `searxng/settings.yml`) | internal `8080` | No key. Rotate the placeholder secret in settings.yml. |
| `backend` | repo `backend/Dockerfile` | `3501` | Fastify API + Mastra agents + refresh scheduler. |
| `frontend` | repo `frontend/Dockerfile` | public domain | Next.js. `NEXT_PUBLIC_*` are baked at build time. |

Private networking: services reach each other at `<name>.railway.internal`.

## Environment matrix

`backend` service:
```
CONVEX_URL=http://convex.railway.internal:3210
CONVEX_SELF_HOSTED_ADMIN_KEY=<from convex bootstrap, step 4>
CLERK_SECRET_KEY=<clerk prod secret>
CLERK_PUBLISHABLE_KEY=<clerk prod publishable>
CLERK_JWT_ISSUER_DOMAIN=<https://<your-app>.clerk.accounts.dev or prod issuer>
OPENROUTER_API_KEY=<our openrouter key>          # "our API key" for the proprietary engine
SEARXNG_URL=http://searxng.railway.internal:8080
PORT=3501
# A/B web engine
SEARCH_PROVIDER=searxng        # app-wide default; dashboard toggle + per-Set choice override
EXA_API_KEY=<exa key>          # required for the Exa engine
# EXA_SEARCH_TYPE=auto
# EXA_NUM_RESULTS=10
```

`frontend` service (build-time + runtime):
```
NEXT_PUBLIC_CONVEX_URL=https://<convex-public-domain>
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<clerk prod publishable>
NEXT_PUBLIC_BACKEND_URL=https://<backend-public-domain>
CLIENT_ORIGIN=https://<frontend-public-domain>
```

`convex` service:
```
INSTANCE_NAME=champset
DATABASE_URL=<from postgres plugin>
# plus the standard self-hosted Convex vars from docker-compose.prod.yml
```

## Deploy order

1. Create the Railway project; add the **Postgres** plugin.
2. Deploy **searxng** (image) and **convex** (image + Volume). Wait for convex healthy.
3. **Bootstrap Convex once** (Railway one-off shell or local against the convex public URL):
   ```bash
   KEY=$(railway run --service convex ./generate_admin_key.sh | grep '^convex-self-hosted|')
   # set CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY on the backend service
   cd frontend && bun install
   bunx convex env set CLERK_JWT_ISSUER_DOMAIN "$ISSUER" --url https://<convex-domain> --admin-key "$KEY"
   bunx convex deploy --url https://<convex-domain> --admin-key "$KEY"
   ```
4. Deploy **backend** (Dockerfile) with the env above.
5. Deploy **frontend** (Dockerfile) with the `NEXT_PUBLIC_*` build vars set BEFORE first build (they are baked in). Point its domain as the app URL.
6. (Optional) Seed curated datasets: `bunx convex run publicSeed:seedPublicDatasets --url https://<convex-domain> --admin-key "$KEY"`.

## Verify

- `https://<frontend-domain>` loads, Clerk sign-in works, a Set builds.
- `https://<backend-domain>/health` returns 200.
- Backend logs show `[search_web:searxng] Searching SearXNG` on the default engine.
- Flip the dashboard **Engine** toggle to **Exa**, build a Set, and logs show
  `[search_web:exa] Searching Exa`. Each run's engine is recorded on `runStats.searchProvider`.

## Notes

- The frontend image bakes `NEXT_PUBLIC_*` at build time, so rebuild it when those change.
- Only `postgres` and the `convex` volume hold state. Back both up.
- This is heavier to stand up than the VPS path in `DEPLOY.md`. If "live today"
  is the priority and Railway setup stalls, the VPS runbook is the fast fallback.
