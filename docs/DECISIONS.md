# Architecture & Design Decisions

This document records architectural decisions made throughout the design and implementation of the self-hosted deployment platform. Each entry explains the context, decision, alternatives considered, justification, and trade-offs.

---

## 1. Monorepo Architecture and Package Management

- **Decision**: Use a single Git repository structured as a pnpm workspace with strict package boundaries (`apps/api`, `apps/worker`, `apps/router`, `apps/web`, and `packages/shared`).
- **Alternatives Considered**:
  1. *Polyrepo (separate Git repositories)*: Higher operational overhead for coordinated changes between API, worker, and router. Difficult to share typed interfaces and state machine logic without publishing private npm packages.
  2. *npm / yarn workspaces*: Slower symlinking and lacks pnpm's content-addressable storage and strict peer dependency isolation.
- **Why this one**: pnpm workspaces allow zero-overhead code sharing (`@deployservice/shared`) across Node microservices while keeping builds fast, deterministic, and isolated.
- **Trade-offs**: Requires building shared packages before running consumers, slightly more verbose Docker build multi-stage files.

---

## 2. Status State Machine Enforcement

- **Decision**: Enforce deployment lifecycle transitions exclusively through a single centralized function (`assertTransition(from, to)`) in `@deployservice/shared`.
- **Transitions**:
  - `queued -> cloning -> building -> uploading -> deployed`
  - Terminal failure states: `failed`, `timed_out`, `cancelled`
- **Alternatives Considered**:
  1. *Implicit transitions in application code*: Ad-hoc `status = '...'` updates scattered throughout worker and API routes.
  2. *Postgres triggers / CHECK constraints*: Harder to unit test, couples business logic to database dialect, and gives less descriptive error messages to the application layer.
- **Why this one**: Centralizing transition validation prevents invalid state jumps (e.g., `queued` directly to `deployed`, or modifying terminal states like `failed` to `deployed`), making the deployment lifecycle completely deterministic and easy to test in unit tests.
- **Trade-offs**: Every status update must pass through the state machine validation layer; any new lifecycle state requires updating the transition graph.

---

## 3. Log Persistence: Redis Streams (Transient) + MinIO Archive vs Postgres Rows

- **Decision**: Stream live build logs to Redis Streams during active execution, and write a single aggregated log archive to MinIO when the build concludes. The Postgres database retains only metadata (`deployments` and `projects`).
- **Alternatives Considered**:
  1. *Relational table (`deployment_logs(deployment_id, seq, ts, stream, line)`)*: Storing each stdout/stderr line as an individual relational row introduces high insert frequency, index maintenance overhead, and database table growth across hundreds of builds, even though log lines are append-only and read sequentially in bulk.
  2. *Redis only*: Storing logs indefinitely in Redis consumes expensive memory for historical deployments that are rarely accessed.
- **Why this one**:
  - Redis Streams (`XADD`, `XREAD`, `XRANGE`) provide low-latency append operations, monotonic sequential IDs (`<ms>-<seq>`), and cursoring ideal for Server-Sent Events (SSE) with `Last-Event-ID` resume.
  - S3/MinIO is designed for cost-effective, durable object storage. Archiving completed logs as a single compressed or plain object in MinIO keeps Postgres dedicated to relational metadata, while Redis memory can be freed via stream trimming (`XTRIM` / `XDEL`).
- **Trade-offs**: Requires the API to check Redis for active builds and MinIO for finished/terminal builds when serving historical logs.

---

## 4. Database Migrations via Transactional SQL Runner

- **Decision**: Store schema migrations as sequentially numbered SQL files (`0001_initial.sql`) and run them inside a single database transaction with a Postgres advisory lock (`pg_advisory_xact_lock`) tracking applied versions in `__schema_migrations`.
- **Alternatives Considered**:
  1. *drizzle-kit push*: Modifies database schema dynamically without immutable migration histories, making rollbacks and multi-container startup synchronization unreliable.
  2. *Heavy external migration CLI binaries*: Adds runtime container bloat and complex CLI wrapper invocations during automated tests.
- **Why this one**: Pure SQL migrations are completely transparent, reproducible across development and production containers, and atomic. The advisory lock prevents race conditions when multiple API or worker replicas boot up simultaneously.
- **Trade-offs**: Schema rollbacks require writing an explicit forward migration script rather than automated down-migrations.

---

## 5. Storage Client: MinIO with Path-Style S3 Addressing

- **Decision**: Use the official `@aws-sdk/client-s3` configured with `forcePathStyle: true` pointing to the local MinIO container.
- **Alternatives Considered**:
  1. *MinIO JavaScript SDK*: Good, but locks the codebase into MinIO-specific APIs instead of the universal AWS S3 standard SDK.
  2. *Local filesystem storage (`/var/data/sites`)*: Violates the twelve-factor app statelessness principle and prevents scaling workers or routers independently across multiple nodes or containers.
- **Why this one**: AWS SDK S3 client is the cloud-native industry standard. With `forcePathStyle: true`, the exact same client code is S3-compatible and works seamlessly with self-hosted MinIO locally and with other S3-compatible object stores in production without code changes.
- **Trade-offs**: Local MinIO requires an initialization step to guarantee bucket existence prior to the first upload.
- **Container Image Pinning**: The `minio/minio` image on Docker Hub returned `pull access denied` without authentication in our environment. We pinned an immutable digest from Chainguard (`cgr.dev/chainguard/minio@sha256:59953701f8f8d0de81aab456f0b0b6c0a1804119415559bf7ede79d944108879`) to guarantee reproducible, zero-cost, login-free local setup.

---

## 6. Phase 1 Placeholders for Worker and Router Services

- **Decision**: Keep the `worker` process alive via an interval timer and expose a minimal `/healthz` HTTP listener in `router` during Phase 1.
- **Alternatives Considered**:
  1. *Omit worker and router from docker-compose.yml during Phase 1*: Would fail the acceptance criteria that `docker compose up` brings all services up healthy.
  2. *Let worker and router run a single log statement and exit*: Containers would enter `Exited (0)` status, causing confusion as to whether services crashed or completed.
- **Why this one**: Provides stable, running containers that pass compose health checks and orchestration wiring in Phase 1, while clearly marking the boundaries where Phase 2 logic (BullMQ consumer in worker, wildcard request routing in router) will be implemented.
- **Trade-offs**: Temporary scaffolding code in `apps/worker/src/index.ts` and `apps/router/src/index.ts` that will be replaced in Phase 2.

---

## 7. Strict Repository URL Allowlist for SSRF Prevention

- **Decision**: Limit deployment input URLs strictly to HTTPS GitHub repositories matching `^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(\.git)?\/?$`. Reject all other schemes (`http://`, `file://`, `ssh://`), ports, IP literals, credentials, and non-GitHub hosts.
- **Alternatives Considered**:
  1. *Permit generic git URLs (`https://*` or `git@*`)*: Requires resolving DNS hostnames, checking private subnet IP ranges (RFC 1918, RFC 3927 link-local, AWS metadata endpoints `169.254.169.254`), and managing SSH known hosts / key authentication.
  2. *Allow any HTTP/HTTPS URL*: Exposes the host and worker to SSRF, local port scanning, and internal network probing.
- **Why this one**: A strict allowlist is immune to DNS rebinding, internal network scanning, and protocol injection attacks while completely fulfilling the user goal ("A user pastes a public Git repository URL").
- **Trade-offs**: Other public git providers (GitLab, Bitbucket, self-hosted Gitea) are currently disallowed without extending the validation allowlist.

---

## 8. Zero-Config Framework Detection and Build Output Resolution

- **Decision**: Detect build configuration heuristically from root files:
  - If `vite.config.*` is present: framework is `vite`, output directory is `dist`, commands: `npm install && npm run build`.
  - If `package.json` contains `react-scripts`: framework is `cra`, output directory is `build`, commands: `npm install && npm run build`.
  - If `index.html` exists at repo root: framework is `static`, output directory is `.` (root), zero build command needed.
  - Otherwise: reject with clear actionable error message.
- **Alternatives Considered**:
  1. *Require user to configure build command and output directory via API*: Adds cognitive friction for standard modern static sites.
  2. *Vercel build-output-api / Nixpacks*: Complex dependency footprint not needed for the core static hosting happy path.
- **Why this one**: Covers the vast majority of modern frontend repositories (Vite, CRA, plain static HTML) with zero configuration while failing fast and descriptively when an unsupported structure is provided.
- **Trade-offs**: Non-standard output directories or multi-package monorepos without root configs fail detection.

---

## 9. Subprocess Execution Environment Sanitization in Phase 2

- **Decision**: Execute `npm install` and `npm run build` as host child processes, but explicitly sanitize the environment (`process.env` is NEVER inherited). The child process environment contains only `PATH`, `HOME=workDir`, and `CI=true`.
- **Alternatives Considered**:
  1. *Inheriting `process.env`*: Exposes database credentials (`DATABASE_URL`), Redis passwords, and MinIO access/secret keys to any npm dependency or postinstall script.
  2. *Implementing full Docker containers immediately in Phase 2*: Violates the phased progression rules (Phase 2 is the happy path without sandbox; Phase 3 introduces Docker isolation).
- **Why this one**: Completely shields sensitive infrastructure credentials from untrusted build steps in Phase 2, while confining file modifications to the temporary directory.
- **Trade-offs**: Phase 2 still runs untrusted code under the host/container OS process table. Phase 3 replaces this with isolated throwaway Docker containers.

---

## 10. Wildcard Subdomain Routing, S3 Streaming, and SPA Fallback

- **Decision**:
  - Subdomains are validated against RFC 1035 (`^[a-z0-9-]{1,63}$`) and mapped to deployment records.
  - Deployment records are cached in a short-TTL in-memory LRU cache (10 seconds) to prevent database stampedes on high traffic.
  - Assets are streamed directly from MinIO using Node readable streams and AWS SDK `getObject`, with explicit MIME type resolution and caching headers (`no-cache` for HTML, 1-year immutable for hashed assets under `/assets/`).
  - SPA Fallback: If a requested path has no file extension (e.g. `/dashboard`, `/users/42`) and does not exist in storage, fall back to serving `/index.html` with HTTP 200. Assets with file extensions (e.g. `.js`, `.png`) return a genuine HTTP 404 if missing.
  - Path traversal sequences (`..`, encoded `%2e%2e`, null bytes) are intercepted and rejected early with HTTP 400.
- **Alternatives Considered**:
  1. *Path-based routing (`localhost:8080/sites/<id>/`)*: Breaks relative asset paths and SPA history routing for most frontend frameworks.
  2. *Buffering entire files in memory in the router*: Causes high memory pressure when serving large JS bundles or image assets.
- **Why this one**: Subdomain routing (`<id>.localhost:8080`) matches production deployment platforms (Vercel/Netlify), streaming provides high throughput with minimal memory footprint, and SPA fallback correctly powers client-side routing.
- **Trade-offs**: Requires `*.localhost` DNS resolution, which is standard in modern browsers and OS resolvers for loopback interfaces.
