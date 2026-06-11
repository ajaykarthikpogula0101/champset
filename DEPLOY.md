# Deploying ChampSet to a VPS with Docker Compose

This is the production runbook for a single small server (Hetzner CX22, a
DigitalOcean droplet, etc.). Persistent storage lives in Docker named volumes
on the host disk. TLS is automatic via Caddy. The only paid dependency is
OpenRouter; web search and fetch run on self-hosted SearXNG + Readability.

## What runs

| Service | Role | Stateful? |
|---|---|---|
| caddy | HTTPS reverse proxy (auto Let's Encrypt) | no |
| frontend | Next.js app | no |
| backend | Fastify API + agent workers + refresh scheduler | no |
| convex | Self-hosted Convex backend (the database engine) | **yes** (`convex_data`) |
| db | Postgres (Convex's store) | **yes** (`pgdata`) |
| searxng | Open-source metasearch | no |

The dev `mastra` Studio service is intentionally not in prod. The agents run
inside `backend`.

## 1. Provision

- A VPS with 2 vCPU / 4 GB RAM minimum (the agents run several subagents in
  parallel). Ubuntu 24.04.
- Open ports 80 and 443.
- Install Docker + the compose plugin:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```

## 2. DNS

Point four A records at the server IP:

```
app.<DOMAIN>          A   <server-ip>
api.<DOMAIN>          A   <server-ip>
convex.<DOMAIN>       A   <server-ip>
convex-site.<DOMAIN>  A   <server-ip>
```

Caddy needs these resolving before it can issue certificates.

## 3. Clone + configure

```bash
git clone https://github.com/Champ-Deep/ChampSet.git champset
cd champset
cp .env.prod.example .env
# Edit .env: DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD, OPENROUTER_API_KEY,
# and your Clerk PRODUCTION keys + issuer. Leave CONVEX_SELF_HOSTED_ADMIN_KEY blank.
```

Clerk: create a **production** instance in the Clerk dashboard, add your domain,
and create a JWT template named `convex` (audience `convex`). Keyless/dev does
not work on a real domain.

## 4. Bootstrap Convex (one time)

Convex needs an admin key, the Clerk issuer, and the schema before the app can
use it. Bring up the data layer first, generate the key, then deploy the schema.

```bash
# Start just the database engine.
docker compose -f docker-compose.prod.yml up -d db convex

# Wait ~20s, then generate the admin key and write it into .env:
KEY=$(docker compose -f docker-compose.prod.yml exec -T convex ./generate_admin_key.sh | grep '^convex-self-hosted|')
sed -i "s#^CONVEX_SELF_HOSTED_ADMIN_KEY=.*#CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY#" .env

# Deploy the schema + set the Clerk issuer. Run from the frontend dir using the
# host's bun/npx, targeting the convex container through Caddy once it's up, or
# temporarily publish the port:
docker compose -f docker-compose.prod.yml up -d caddy   # brings convex.<DOMAIN> online
cd frontend && bun install
ISSUER=$(grep '^CLERK_JWT_ISSUER_DOMAIN=' ../.env | cut -d= -f2-)
bunx convex env set CLERK_JWT_ISSUER_DOMAIN "$ISSUER" --url https://convex.<DOMAIN> --admin-key "$KEY"
bunx convex deploy --url https://convex.<DOMAIN> --admin-key "$KEY"
cd ..
```

> If `convex.<DOMAIN>` is not certificate-ready yet, you can instead add a
> temporary `ports: ["3210:3210"]` to the `convex` service, target
> `http://localhost:3210`, then remove it.

## 5. Build + start everything

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The frontend image bakes the `NEXT_PUBLIC_*` URLs at build time from `.env`, so
rebuild it whenever those change.

## 6. Seed the curated datasets (optional)

```bash
cd frontend && bunx convex run publicSeed:seedPublicDatasets --url https://convex.<DOMAIN> --admin-key "$KEY"
```

## 7. Verify

- `https://app.<DOMAIN>` loads, sign-in works, you can build a dataset.
- `https://api.<DOMAIN>/health` returns 200.
- `docker compose -f docker-compose.prod.yml logs -f backend` shows
  `[search_web] Searching SearXNG` during a populate.

## Backups

The only state is Postgres (`pgdata`) and the Convex volume (`convex_data`).

```bash
# Nightly Postgres dump (add to cron):
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U champset champset_internal | gzip > /var/backups/champset-$(date +\%F).sql.gz
```

Snapshot the host disk (or the two named volumes) on a schedule too.

## Updates

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
# If convex functions changed:
cd frontend && bunx convex deploy --url https://convex.<DOMAIN> --admin-key "$KEY"
```

## Notes

- Rotate the placeholder secret in `searxng/settings.yml` before going live.
- The `convex-dashboard` admin UI is omitted from prod; run it ad hoc over an
  SSH tunnel if you need to inspect data.
- Scaling: this fits comfortably on one box for a team. The first thing to feel
  load is the agent runs; bump CPU/RAM before splitting services.
