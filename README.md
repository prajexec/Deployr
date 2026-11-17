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

### 2. Start Infrastructure
```bash
docker compose up -d
```

### 3. Run Tests
```bash
# Unit tests (runs without Docker dependencies)
pnpm test

# Integration tests (runs against Docker Postgres, Redis, MinIO)
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

