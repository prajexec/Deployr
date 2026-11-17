# Security Architecture & Threat Model

DeployService runs untrusted user-submitted code in strictly isolated, ephemeral Docker sandbox containers. This document details the defense-in-depth architecture, threat model, and honest known limitations.

---

## 1. Container Sandbox Isolation

Untrusted repository builds (`git clone`, `npm install`, `npm run build`) execute inside throwaway sibling containers created from an immutable, non-root builder image (`deployservice-builder:latest`).

### Immutable Security Constraints

Every build container is enforced with:

- **Memory & Swap Cgroup Limits**: Hard limit of `512 MB` RAM with `MemorySwap: 512 MB` (swap equals memory, ensuring swap is disabled). Memory exhaustion triggers the Linux kernel cgroup OOM killer (`state.OOMKilled`), immediately terminating the container and updating deployment status to `failed`.
- **CPU Quota**: `NanoCPUs: 1_000_000_000` (strictly capped at 1.0 vCPU core).
- **Process Table Limit**: `PidsLimit: 100` (fork bombs are trapped by the kernel process cgroup and fail with `Resource temporarily unavailable`, keeping the host unaffected).
- **Non-Root Execution**: Runs under unprivileged user `builduser` (UID `10001:10001`).
- **Capabilities Dropped**: `CapDrop: ["ALL"]` (drops all Linux capabilities including raw socket creation, sysadmin operations, and chown).
- **Privilege Escalation Blocked**: `SecurityOpt: ["no-new-privileges:true"]` prevents setuid/setgid binaries from acquiring elevated privileges.
- **Read-Only Root Filesystem**: `ReadonlyRootfs: true`. The container's system directories (`/etc`, `/usr`, `/bin`, `/lib`) are strictly read-only.
- **Storage Isolation**:
  - Ephemeral per-build disk volume (`deployservice-vol-<id>`) mounted at `/build`.
  - Zero host filesystem bind mounts.
  - Temporary in-memory `/tmp` filesystem mounted as `rw,noexec,nosuid,size=64m`.
- **Docker Socket Isolation**: `/var/run/docker.sock` is **NEVER** mounted inside build containers. Only the worker daemon receives the Docker socket.
- **Wall-Clock Timeout**: Enforces a strict 5-minute timeout. If exceeded, the worker forcefully kills the container and marks the deployment as `timed_out`.
- **Log Flood Protection**: Log output is buffered in memory up to a 2 MB ceiling. Subsequent bytes are drained and discarded with a truncation warning (`[logs truncated: exceeded 2MB limit]`), preventing stdout buffer deadlocks or memory exhaustion.

---

## 2. Network Isolation Architecture

- **Dedicated Build Bridge Network**: Build containers run on `deployservice-build-net`.
- **Internal Service Segregation**: Internal database and cache services (`postgres`, `redis`, `minio`) run on the compose network (`deployservice-network`). Containers on `deployservice-build-net` cannot resolve or reach these services by hostname (NXDOMAIN).
- **Loopback Interface Binding (127.0.0.1)**: Every published port across `docker-compose.yml` (API 3000, Router 8080, Web 5173) and `docker-compose.dev.yml` (Postgres 5432, Redis 6379, MinIO 9000/9001) is strictly bound to `127.0.0.1`. Without this explicit loopback constraint, Docker would bind ports to `0.0.0.0` by default, making these services reachable across the local area network (LAN).
- **Unpublished Internal Ports**: In the default `docker-compose.yml`, internal ports for `postgres`, `redis`, and `minio` are **NOT published** to the host interface. Development port mappings are confined to `docker-compose.dev.yml`.

---

## 3. Tar Extraction & Zip Slip Protection

Artifacts are extracted directly from the container's volume via Docker Engine API `container.getArchive({ path: '/build/output' })` and validated in memory before writing to storage:

- **Zip Slip & Path Traversal**: Rejects any entry whose name contains `..`, starts with `/`, contains null bytes, or resolves outside the root.
- **Type Whitelist**: Only regular files and directories are allowed. Symlinks, hardlinks, character/block devices, and FIFOs are strictly rejected.
- **Decompression Bomb Bounds**: Archives exceeding 100 MB total uncompressed size, 25 MB single file size, or 5,000 files are rejected.

---

## 4. Input & Parameter Injection Defense

- **Repository URL Allowlist**: Restricts input strictly to `https://github.com/<owner>/<repo>[.git]`. Custom schemes (`file://`, `ssh://`), ports, credentials, and non-GitHub hostnames are rejected with HTTP 400.
- **CLI Option Injection Defense**: `REPO_URL` is passed as an environment variable to a fixed shell script and cloned via `git clone --depth 1 -- "$REPO_URL"`. URLs starting with `-` (such as `--upload-pack`) are rejected before execution.

---

## 5. Router Path Traversal Protection

Static assets served via `http://<id>.localhost:8080` are protected against path traversal attacks (`..`, `%2e%2e`, null bytes):

- Raw request URLs are intercepted before framework normalization.
- Subdomains are validated against the 128-bit deployment ID format (`^d-[a-f0-9]{32}$`) or project ID format (`^prj_[a-f0-9]{12}$`).
- Path traversal sequences, encoded traversal attempts, and null bytes return HTTP 400 Bad Request.

---

## 6. Honest Known Limitations & Threat Model Analysis

1. **Builds Can Reach Published API, Router, and Internet**:
   - _Behavior_: Build containers connect to the public internet to fetch git repositories and npm dependencies. Under Docker Desktop (macOS) and standard Linux bridge networking, packets routed to the host gateway IP (`172.x.0.1` or host gateway) can reach host-published ports (`127.0.0.1:3000` API and `127.0.0.1:8080` Router).
   - _Mitigation_: The build container does not possess the `API_KEY`. Without `API_KEY`, requests to `POST /deployments`, `GET /deployments` (listing), cancellation, and rollback are rejected with 401 Unauthorized. A hostile build cannot enumerate or trigger deployments.
   - _Future Work_: Implement a dedicated forward egress proxy on an isolated internal network that enforces domain allowlisting (`github.com`, `registry.npmjs.org`) and drops all traffic directed at host/private IP ranges.

2. **Unauthenticated Capability URLs**:
   - _Behavior_: `GET /deployments/:id` (status) and `GET /deployments/:id/logs` (live/archived logs) are capability-based URLs that do not require an `API_KEY` header.
   - _Mitigation_: Deployment IDs are 128-bit lowercase hex values (`d-[a-f0-9]{32}`) generated via `crypto.randomBytes(16)`. With $2^{128}$ possible values, brute-force enumeration is mathematically infeasible. However, anyone who possesses the URL can inspect build logs.

3. **Best-Effort Log Redaction**:
   - _Behavior_: Build output is piped through a regex-based stream redactor before being published to Redis Streams. It masks common token formats (GitHub PATs `ghp_`, AWS access keys `AKIA`, GitLab tokens `glpat-`, Bearer tokens, RSA/EC private keys, and preconfigured secrets).
   - _Limitation_: Regex redaction is inherently best-effort. Custom tokens, arbitrary password strings, or fragmented secrets split across stream chunks cannot be guaranteed to be 100% redacted. Developers should never commit secrets to repositories built on the platform.

4. **Single-Worker Assumptions**:
   - _Behavior_: The worker crash recovery mechanism (`recoverStuckDeployments`) checks in-memory `activeDeployments` and BullMQ queue state to avoid reaping active builds.
   - _Limitation_: In a multi-worker setup across different machines, local memory sets are not shared. Distributed leases (e.g., Redlock or Postgres advisory row locks with worker heartbeats) would be required to prevent a worker from reaping builds running on a healthy peer.

5. **Docker Desktop Test Environment**:
   - _Behavior_: Audit tests and resource containment benchmarks were evaluated on macOS running Docker Desktop (using Apple Hypervisor and the LinuxKit VM).
   - _Observation_: Networking behavior (such as `host.docker.internal` resolution and host-gateway forwarding) exhibits slight differences compared to bare-metal Linux with native `iptables` and cgroups v2.
