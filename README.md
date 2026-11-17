# DeployService

A self-hosted, zero-cost deployment platform (Vercel/Netlify-style) built from scratch using TypeScript, Fastify, BullMQ, Redis, PostgreSQL, and MinIO (S3-compatible).

> [!NOTE]
> **Container Sandboxing (Phase 3):** Untrusted builds execute inside isolated Docker sandbox containers with hard cgroup memory limits (512MB, swap disabled), CPU quotas (1 core), process limits (100 PIDs), dropped capabilities (`CapDrop: ALL`), read-only root filesystems, and dedicated bridge network isolation. See [SECURITY.md](SECURITY.md) for architecture details.

---

## Architecture Overview

- **`apps/api`**: Fastify REST API for repository validation, project creation, deployment queuing, and status inspection.
- **`apps/worker`**: BullMQ queue consumer that executes shallow git clones, framework detection (Vite, CRA, static HTML), builds, and uploads build artifacts to MinIO.
- **`apps/router`**: Wildcard reverse proxy routing `http://<deployment-id>.localhost:8080` to S3 static assets with caching headers, SPA routing fallback, and path traversal protection.
- **`packages/shared`**: Shared TypeScript types, state machine transitions, Postgres/Drizzle schemas and migrations, Redis client, S3 client, and validation utilities.

---

## Quickstart

### 1. Prerequisites

- Docker & Docker Compose
- Node.js 20+
- pnpm 9+

### 2. Fresh Clone Setup

To bootstrap a clean clone without running any manual Docker setup commands:

```bash
# 1. Clone repository & enter workspace
git clone https://github.com/prajexec/Deployr.git && cd Deployr

# 2. Configure environment (pre-configured with local dev defaults)
cp .env.example .env

# 3. Install dependencies
pnpm install

# 4. Build and start all services
docker compose up -d --build
```

`docker compose up -d --build` builds all application containers and the isolated sandbox builder image (`deployservice-builder:latest`). The worker automatically and idempotently creates the dedicated build bridge network (`deployservice-build-net`) on startup before processing any build jobs. No manual Docker network or image management is required.

### 3. Run Tests

```bash
# Unit tests (runs without Docker dependencies)
pnpm test

# Integration tests (runs against Docker Postgres, Redis, MinIO via dev port overlay)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
pnpm test:integration
```

### 4. Create a Deployment

```bash
curl -X POST http://localhost:3000/deployments \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/vitejs/vite"}'
```

Inspect deployment:

```bash
curl http://localhost:3000/deployments/<id>
```

Visit the deployed application once ready:

```
http://<id>.localhost:8080
```
