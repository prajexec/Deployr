# DeployService

A self-hosted, zero-cost deployment platform (Vercel/Netlify-style) built from scratch using TypeScript, Fastify, BullMQ, Redis, PostgreSQL, and MinIO (S3-compatible).

> [!WARNING]
> **SECURITY NOTICE (Phase 2):** Build execution in Phase 2 runs as a host subprocess with a sanitized environment (`HOME` set to tempdir, credentials stripped). However, full container-based sandboxing is introduced in Phase 3. **ONLY DEPLOY TRUSTED REPOSITORIES** until Phase 3 is completed. See [SECURITY.md](SECURITY.md) for details.

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

