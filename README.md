# DeployService

A self-hosted, production-grade deployment platform (Vercel/Netlify-style) built from scratch using TypeScript, Fastify, BullMQ, Redis, PostgreSQL, and MinIO (S3-compatible).

<!-- Demo GIF Placeholder -->
<!-- ![DeployService Demo](docs/assets/demo.gif) -->

> _Demo recording script available at [docs/DEMO.md](docs/DEMO.md)._

> [!NOTE]
> **Container Sandboxing:** Untrusted builds execute inside isolated Docker sandbox containers with hard cgroup memory limits (512MB, swap disabled), CPU quotas (1 core), process limits (100 PIDs), dropped capabilities (`CapDrop: ALL`), read-only root filesystems, and dedicated bridge network isolation. See [SECURITY.md](SECURITY.md) for full threat model and defense-in-depth analysis.

---

## Architecture Overview

- **`apps/api`**: Fastify REST API with API key authentication, rate limiting, strict SSRF/input validation, BullMQ job producer, and live Server-Sent Events (SSE) log streaming.
- **`apps/worker`**: BullMQ queue consumer running isolated Docker builds, live Redis log streaming, MinIO artifact uploads, atomic release pointer switches, cancellation listener, and supervisor crash recovery.
- **`apps/router`**: Wildcard reverse proxy routing `http://<deploymentId>.localhost:8080` (preview) and `http://<projectId>.localhost:8080` (production) to S3 static assets with LRU caching, MIME typing, SPA fallback, and path traversal protection.
- **`apps/web`**: React 18 + Vite + Tailwind CSS dashboard with deployments list, status badges, live console viewer, one-click cancellation, and instant rollback.
- **`packages/shared`**: Shared TypeScript types, state machine transitions, Postgres/Drizzle schemas and migrations, Redis client, S3 client, and validation utilities.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full architecture diagrams and workflows.

---

## Quickstart

### 1. Prerequisites

- Docker & Docker Compose
- Node.js 20+
- pnpm 9+
- `openssl` CLI

### 2. Fresh Clone Setup

Follow these exact steps from a clean clone:

```bash
# 1. Clone repository & enter workspace
git clone https://github.com/prajexec/Deployr.git && cd Deployr

# 2. Configure environment and generate secure API key
cp .env.example .env

# Generate API key (required: API refuses to start with missing, empty, or placeholder key):
export API_KEY=$(openssl rand -hex 32)
# Set API_KEY in .env (macOS / BSD):
sed -i '' "s|^API_KEY=.*|API_KEY=${API_KEY}|" .env
# (On Linux, use: sed -i "s|^API_KEY=.*|API_KEY=${API_KEY}|" .env)

# 3. Install workspace dependencies
pnpm install

# 4. Build and start all services via Docker Compose
docker compose up -d --build
```

`docker compose up -d --build` builds all application containers and the isolated sandbox builder image (`deployservice-builder:latest`). The worker automatically and idempotently creates the dedicated build bridge network (`deployservice-build-net`) on startup before processing any build jobs. No manual Docker commands are needed.

> [!TIP]
> **Web Dashboard Access**: Open `http://localhost:5173` in your browser. Enter your generated `API_KEY` into the top bar's **API Key** input (persisted in local storage) to view existing builds or trigger new deployments.

---

## Usage Guide

### 1. Deploy via Web Dashboard

1. Open `http://localhost:5173`.
2. Enter your `API_KEY` in the top navigation bar.
3. Paste a public GitHub URL (e.g. `https://github.com/octocat/Spoon-Knife`) and click **Deploy**.
4. The dashboard redirects to the deployment console with real-time SSE streaming logs.
5. Once complete, click **Preview URL** or **Production Release** to open the hosted static site.

### 2. Deploy via REST API (CLI)

```bash
# 1. Trigger a deployment
curl -s -X POST http://localhost:3000/deployments \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"repoUrl": "https://github.com/octocat/Spoon-Knife"}'

# Response:
# {"id":"d-...","status":"queued","projectId":"prj_...","repoUrl":"..."}
```

```bash
# 2. Stream live build logs in real time
curl -N http://localhost:3000/deployments/<id>/logs
```

```bash
# 3. Visit the deployed application once ready
# Preview build:
curl -H "Host: <id>.localhost:8080" http://127.0.0.1:8080/index.html

# Project production release:
curl -H "Host: <projectId>.localhost:8080" http://127.0.0.1:8080/index.html
```

```bash
# 4. Rollback project to an earlier deployment
curl -s -X POST http://localhost:3000/projects/<projectId>/rollback \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"targetDeploymentId": "<earlier-deployment-id>"}'
```

```bash
# 5. Cancel an active build
curl -s -X POST http://localhost:3000/deployments/<id>/cancel \
  -H "x-api-key: $API_KEY"
```

---

## Running Tests

All published host ports across `docker-compose.yml` (API `3000`, Router `8080`, Web `5173`) and `docker-compose.dev.yml` (Postgres `5432`, Redis `6379`, MinIO `9000/9001`) are bound to loopback `127.0.0.1` to prevent services from being exposed to the local network.

```bash
# Unit tests (14 test files, 99 tests - runs with zero Docker dependencies)
pnpm test

# Integration tests (runs against live Postgres, Redis, and MinIO via dev overlay)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
pnpm test:integration
```

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): Full system diagrams, component breakdown, and lifecycle workflows.
- [SECURITY.md](SECURITY.md): Threat model, sandbox constraints, and honest known limitations.
- [docs/DECISIONS.md](docs/DECISIONS.md): Architectural Decision Records (ADRs) for Phases 1 through 5.
- [docs/INTERVIEW.md](docs/INTERVIEW.md): Comprehensive system walkthrough, trade-off analyses, bug autopsies, and interview Q&A.
- [docs/DEMO.md](docs/DEMO.md): Step-by-step recording script for demonstration.
