# DeployService Architecture

## Overview

DeployService is an open-source, self-hosted deployment platform inspired by Vercel and Netlify. It accepts public Git repositories, builds them in isolated Docker containers, stores static build artifacts in an S3-compatible object store (MinIO), and serves them through a high-performance wildcard router.

```
       [ Client / Browser ]
          |            |
   REST / SSE       Subdomain Request (*.localhost:8080)
          |            |
          v            v
     [apps/api]   [apps/router]
       |     ^         |
 BullMQ|     |Redis    | S3 GetObject
 Enqueue     |Streams  |
       v     |         v
    [apps/worker]  [MinIO Storage]
       |         (deployments/<id>/*)
     Docker
    Container
   (Ephemeral)
```

## System Components

1. **API (`apps/api`)**:
   - Built with Fastify.
   - Enforces strict input validation on repo URLs (GitHub allowlist, SSRF protection).
   - Validates state machine transitions in Postgres.
   - Enqueues build jobs to BullMQ.
   - Streams live logs via Server-Sent Events (SSE) with `Last-Event-ID` resume.

2. **Worker (`apps/worker`)**:
   - BullMQ consumer running isolated builds.
   - In production sandbox: executes builds inside single-use Docker containers with CPU, memory, PID limits, dropped Linux capabilities, and read-only root filesystems.
   - Publishes stdout/stderr line-by-line to Redis Streams.
   - Atomically uploads build artifacts to MinIO.

3. **Router (`apps/router`)**:
   - Listens on port 8080.
   - Parses incoming `Host: <deployment-id>.localhost:8080` headers.
   - Verifies deployment state is `deployed`.
   - Streams files from MinIO with correct MIME types, caching headers, and SPA fallback (`index.html`).

4. **Web Dashboard (`apps/web`)**:
   - React + Vite + Tailwind dashboard.
   - Real-time build status tracking, terminal log viewer, and live deployment links.

5. **Shared Package (`packages/shared`)**:
   - Common TypeScript types, state machine transition enforcement (`assertTransition`), database models, storage client, and configuration loader.
