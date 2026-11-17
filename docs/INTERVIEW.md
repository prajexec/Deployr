# Technical Interview Guide: DeployService Deep Dive

This document is a technical walkthrough of DeployService. It covers the end-to-end architecture, the engineering trade-offs behind each design decision, post-mortems of bugs caught and fixed during development, and anticipated system design interview questions with honest, production-grounded answers.

---

## 1. Architecture Walkthrough

DeployService is a self-hosted static site deployment platform designed to run untrusted third-party code safely and serve production web applications at scale.

```
       [ Client / Dashboard / Browser ]
           │                         │
     REST / SSE (:3000)         Host: <id>.localhost:8080
           │                         │
           ▼                         ▼
      [apps/api]                [apps/router]
       (Fastify)                 (Reverse Proxy)
           │                         │
      BullMQ Enqueue                 │ S3 Stream
           │                         ▼
           ▼                  [MinIO Object Store]
     [apps/worker]            (deployments/<id>/*)
           │
     Docker Socket (Engine API)
           │
           ▼
    [Sibling Container] ───(git clone & npm build)───> [Public Internet]
   (cgroups, non-root,
    read-only rootfs)
```

### Request Lifecycle

1. **Intake & Validation**: User calls `POST /deployments` with a GitHub repository URL and `x-api-key`. The API runs strict validation (GitHub domain allowlist, SSRF checks, CLI flag defense), creates an immutable deployment record in PostgreSQL (`queued`), and pushes a job to BullMQ.
2. **Worker Dequeue**: A worker process pulls the job. It marks the state `cloning` in PostgreSQL and contacts the local Docker daemon over the Unix domain socket `/var/run/docker.sock` to launch an isolated sibling build container.
3. **Isolated Build**: The container mounts an ephemeral per-build volume at `/build`. Running as an unprivileged user (`builduser`, UID 10001) on a read-only rootfs with all Linux capabilities dropped, it shallow-clones the repo, detects the project framework (Vite, Next.js, CRA, Astro, or static HTML), executes `npm install` and `npm run build`, and stages outputs in `/build/output`.
4. **Log Streaming**: Throughout the build, stdout and stderr are demuxed, capped at 2MB, scanned with regex token redactors, and pushed to a deployment-specific Redis Stream (`deployservice:logs:<id>`). Clients receive live updates via Server-Sent Events (SSE).
5. **Artifact Extraction & Storage**: The worker pulls the output directory via Docker Engine's `container.getArchive()` API, validates tar headers against Zip Slip path traversal and decompression bombs in memory, and uploads the files to MinIO S3 storage under `deployments/<id>/*`.
6. **Atomic Release & Dual Routing**: Once all files are written, the deployment transitions to `deployed` in PostgreSQL, and `projects.current_deployment_id` is updated atomically. The edge router immediately serves the build on `http://<deploymentId>.localhost:8080` (preview) and `http://<projectId>.localhost:8080` (production).

---

## 2. Key Design Decisions & Trade-Offs

### 2.1 Sibling Build Containers vs. Docker-in-Docker (DinD) vs. MicroVMs

- **Decision**: Worker mounts the host Docker socket `/var/run/docker.sock` and spawns sibling build containers. The build containers themselves _never_ receive the Docker socket.
- **Why Not DinD**: Docker-in-Docker requires the parent container to run with `--privileged`, disabling kernel namespace boundaries on the host. If an attacker breaches the worker, privileged DinD allows instant host compromise. Sibling containers allow unprivileged build execution.
- **Why Not Firecracker/gVisor**: MicroVMs provide superior hypervisor-level isolation but introduce virtualization overhead and lack out-of-the-box support for standard local developer workflows across platforms (e.g., macOS Docker Desktop).
- **Trade-off**: The worker itself has Docker socket access (root-equivalent on the host). To protect it, the worker runs inside an internal network, accepts only validated queue payloads, and never evaluates user shell strings.

### 2.2 Redis Streams vs. Redis Pub/Sub for Live Logs

- **Decision**: Single source of truth using Redis Streams (`XADD` + `XREAD BLOCK` + `XRANGE`).
- **Trade-off**:
  - _Pub/Sub_: Fire-and-forget. If a client connects 2 seconds after the build begins, or temporarily reconnects due to a network hiccup, all previous log lines are permanently lost unless dual-written to an in-memory buffer or database.
  - _Redis Streams_: Provides persistent, ordered log entries with microsecond-precise IDs `(ms, seq)`. Clients can join midway, provide `Last-Event-ID` on reconnect, and receive all intermediate lines without gaps or duplicates. Streams are assigned a 24-hour TTL (`EXPIRE 86400`) during post-build cleanup.

### 2.3 Failure Classification: Unrecoverable User Errors vs. BullMQ Retries

- **Decision**: Differentiate `UserBuildError` from `InfrastructureError`. User errors throw BullMQ's `UnrecoverableError`.
- **Trade-off**:
  - Without this, BullMQ's default retry policy (3 attempts with exponential backoff) would retry syntax errors, failing unit tests, missing `dist/` directories, and cgroup OOM kills 3 times. Retrying deterministic user errors wastes CPU/RAM, floods logs, and delays developer feedback.
  - Infrastructure errors (MinIO network drops, Docker socket connection failures, Postgres connection timeouts) legitimately benefit from exponential backoff retries.

### 2.4 Atomic Release via Database Pointer vs. S3 Directory Copy

- **Decision**: The `projects` table stores `current_deployment_id`. Rollbacks and releases atomically update this single PostgreSQL row.
- **Trade-off**:
  - Copying files in S3 (`s3://deployments/<id>/*` to `s3://projects/<id>/live/*`) is non-atomic, slow for large sites, duplicates storage, and risks partial reads if visitors request files mid-copy.
  - A database pointer switch is an instantaneous $O(1)$ transaction. The reverse router resolves the pointer with a 5-second LRU cache, enabling zero-downtime deploys and instant rollbacks.

### 2.5 In-Memory Zip Slip and Archive Safety Bounds

- **Decision**: Validate tar streams entirely in memory before disk extraction or storage upload.
- **Trade-off**:
  - Attackers can craft malicious tarballs with symlinks pointing to `/etc/passwd`, entries with `../../../../tmp/evil`, or 10GB gzip decompression bombs (zip bombs).
  - Enforced strict limits: 100MB max total uncompressed size, 25MB max single file, 5,000 files max, and hard rejection of any symlinks, hardlinks, character devices, or directory traversal markers (`..`, leading `/`, null bytes).

---

## 3. Bugs Found & Fixed During Development

### 1. The Substring & Userinfo SSRF Bypass

- **Bug**: An early regex validator `^https:\/\/github\.com\/.*` allowed hostile URLs like `https://github.com.evil.com/x/y` and userinfo-based routing `https://github.com@evil.com/x/y`.
- **Fix**: Replaced naive regex with standard Node.js `new URL()` parsing: verified `protocol === 'https:'`, `hostname === 'github.com'`, `port === ''`, `username === ''`, `password === ''`, and validated pathname strictly against `^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\.git)?$`.

### 2. The Nested Docker Migrations Duplication Bug

- **Bug**: On fresh `docker compose up -d --build`, Postgres migrations failed to apply migration `0002_atomic_publish_and_rollback.sql`. The database threw: `column "current_deployment_id" does not exist`.
- **Root Cause**: The shared package build script ran `cp -r src/db/migrations dist/db/migrations`. Because `dist/` was present on the host from earlier local builds and not ignored, Docker copied `dist/` into the build context. Subsequent `cp -r` copied `src/db/migrations` _inside_ `dist/db/migrations`, creating a nested `dist/db/migrations/migrations/` hierarchy that the migrator never traversed.
- **Fix**: Created a root `.dockerignore` ignoring `dist` and `node_modules`, and made the build script idempotent: `rm -rf dist/db/migrations && cp -r src/db/migrations dist/db/migrations`.

### 3. Log Flood Memory Deadlock

- **Bug**: A hostile repo executing `yes "flood" | head -n 10000000` flooded Docker stdout, causing node process memory spikes and buffer exhaustion.
- **Fix**: Added a strict 2MB memory ceiling to container log buffering. Bytes exceeding 2MB are drained and discarded with an inline marker: `[logs truncated: exceeded 2MB limit]`. The build completes cleanly without worker starvation.

### 4. Docker Desktop Host-Gateway Egress Nuance

- **Bug**: Build containers on bridge network `deployservice-build-net` were able to reach `host.docker.internal` and the Docker host gateway IP (`172.x.0.1`), allowing TCP connections to published host ports (`3000` API, `8080` Router).
- **Fix**: Added loopback interface binding (`127.0.0.1:<port>:<port>`) across all compose files so published ports are inaccessible from external interfaces. Added constant-time `API_KEY` authentication on all mutating endpoints (`POST /deployments`, `POST /cancel`, `POST /rollback`), ensuring unauthenticated containers cannot trigger builds or extract deployment lists.

---

## 4. Likely Interview Questions & Honest Answers

### Q1: How do you prevent untrusted npm packages from compromising the worker or the host?

**Answer**: Defense-in-depth across 5 layers:

1. _Process Isolation_: Builds run in dedicated Alpine containers, not on the worker node.
2. _Filesystem Isolation_: The container has a read-only rootfs (`ReadonlyRootfs: true`). It cannot modify binaries or install backdoors. Storage is an isolated disk volume mounted at `/build`, with `/tmp` mounted as an unexecutable `tmpfs` (`noexec,nosuid`).
3. _Privilege Stripping_: Runs as unprivileged user `builduser` (UID 10001). Drops all Linux capabilities (`CapDrop: ["ALL"]`) and blocks privilege escalation (`no-new-privileges: true`).
4. _Resource Cgroups_: Hard 512MB RAM cap with swap disabled. Kernel cgroup OOM killer terminates memory bombs. Process table capped at 100 PIDs (`PidsLimit: 100`) to neuter fork bombs. CPU capped at 1 core.
5. _Socket Boundary_: The Docker socket is never mounted into the build container.

### Q2: Can a build container reach internal infrastructure like PostgreSQL or Redis?

**Answer**:
In production (`docker-compose.yml`), internal databases (`postgres:5432`, `redis:6379`, `minio:9000`) run on `deployservice-network`. Build containers run on a separate bridge network (`deployservice-build-net`). They cannot resolve these services by hostname (NXDOMAIN) and their ports are not published to the host.
However, because containers need outbound internet access to fetch npm packages, packets can reach the Docker host gateway IP. If an operator runs `docker-compose.dev.yml` (which maps database ports to host `127.0.0.1`), host routing may allow connecting to the gateway IP. We explicitly document this in `SECURITY.md` and enforce that production never runs the dev overlay. Future work will introduce an internal forward egress proxy.

### Q3: Why use Server-Sent Events (SSE) instead of WebSockets for live build logs?

**Answer**:
Build logs are strictly unidirectional (server-to-client). WebSockets introduce protocol overhead, connection state tracking, and ping/pong framing that are unnecessary for read-only streams. SSE operates over standard HTTP/1.1 or HTTP/2, traverses enterprise firewalls and corporate proxies cleanly, and natively supports the `Last-Event-ID` header, enabling seamless browser reconnection without client-side replay bookkeeping.

### Q4: How does your system handle worker crashes mid-build?

**Answer**:
Through supervisor crash recovery (`recoverStuckDeployments`):

1. On worker startup and periodically every 60 seconds, the worker queries PostgreSQL for deployments in non-terminal states (`cloning`, `building`, `uploading`).
2. It cross-references active memory (`activeDeployments`), the BullMQ queue (`queue.getJobs(['waiting', 'active', 'delayed', 'prioritized'])`), and the deployment's elapsed time against `BUILD_TIMEOUT_MS`.
3. If a build is orphaned (not in memory, not queued in BullMQ, and older than the timeout), the supervisor forcefully kills its container (`deployservice-build-<id>`), removes its per-build volume (`deployservice-vol-<id>`), marks the deployment `failed` in Postgres with `Build worker terminated unexpectedly (recovered by supervisor)`, and emits a terminal `end` event to the Redis stream.

### Q5: What are the scaling bottlenecks of this architecture?

**Answer**:

1. _Single Docker Host_: Sibling container creation is constrained by the host's CPU, disk I/O, and Docker daemon lock contention. A production system would scale out by deploying workers across multiple nodes using Kubernetes Job objects or Nomad task groups.
2. _Single-Worker Assumption in Memory_: `activeDeployments` is stored in process memory. In a distributed multi-worker setup, workers would use Redis distributed locks (Redlock) or database row locks with worker heartbeats to negotiate ownership of stuck builds.
3. _Redis Stream Memory_: High-frequency builds accumulate stream entries in Redis. While we enforce a 24-hour expiration (`EXPIRE 86400`) and cap stream lengths, a high-throughput multi-tenant platform would archive logs to S3 cold storage and evict Redis streams immediately after build completion.
