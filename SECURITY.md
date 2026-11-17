# Security Architecture & Threat Model

DeployService runs untrusted user-submitted code in strictly isolated, ephemeral Docker sandbox containers. This document details the defense-in-depth architecture, threat model, and known limitations.

---

## 1. Container Sandbox Isolation (Phase 3)

Untrusted repository builds (`git clone`, `npm install`, `npm run build`) execute inside throwaway sibling containers created from an immutable, non-root builder image (`deployservice-builder:latest`).

### Immutable Security Constraints

Every build container is enforced with:

- **Memory & Swap Cgroup Limits**: Hard limit of `512 MB` RAM with `MemorySwap: 512 MB` (swap equals memory, ensuring swap is disabled). Memory bombs are terminated by the Linux kernel cgroup OOM killer (`state.OOMKilled`).
- **CPU Quota**: `NanoCPUs: 1_000_000_000` (capped at 1 CPU core).
- **Process Table Limit**: `PidsLimit: 100` (fork bombs are trapped and fail with `Resource temporarily unavailable`, keeping the host unaffected).
- **Non-Root Execution**: Runs under unprivileged user `builduser` (UID `10001:10001`).
- **Capabilities Dropped**: `CapDrop: ["ALL"]` (drops all Linux capabilities including raw socket creation, sysadmin operations, and chown).
- **Privilege Escalation Blocked**: `SecurityOpt: ["no-new-privileges:true"]` prevents setuid/setgid binaries from acquiring elevated privileges.
- **Read-Only Root Filesystem**: `ReadonlyRootfs: true`. The container's system directories (`/etc`, `/usr`, `/bin`, `/lib`) are strictly read-only.
- **Storage Isolation**:
  - Ephemeral per-build disk volume (`deployservice-vol-<id>`) mounted at `/build`.
  - Zero host filesystem bind mounts.
  - Temporary in-memory `/tmp` filesystem mounted as `rw,noexec,nosuid,size=64m`.
- **Docker Socket Isolation**: `/var/run/docker.sock` is **NEVER** mounted inside build containers. Only the internal worker service has Docker socket access.
- **Wall-Clock Timeout**: Enforces a strict 5-minute timeout. If exceeded, the worker forcefully kills the container and marks the deployment as `timed_out`.
- **Log Flood Protection**: Log output is buffered in memory up to a 2 MB ceiling. Subsequent bytes are drained and discarded with a truncation warning (`[logs truncated: exceeded 2MB limit]`), preventing stdout buffer deadlocks or memory exhaustion.

---

## 2. Network Isolation Architecture

- **Dedicated Build Bridge Network**: Build containers run on `deployservice-build-net`.
- **Internal Service Segregation**: Internal database and cache services (`postgres`, `redis`, `minio`) run on the compose network (`deployservice-network`). Containers on `deployservice-build-net` cannot resolve or reach these services by hostname (NXDOMAIN).
- **Unpublished Internal Ports**: In the default `docker-compose.yml`, internal ports for `postgres` (5432), `redis` (6379), and `minio` (9000, 9001) are **NOT published** to the host interface. Development port mappings are moved to `docker-compose.dev.yml`.

### Known Network Limitations

1. **Outbound Internet Egress**: Build containers require outbound internet access to fetch public git repositories from `github.com` and npm dependencies from `registry.npmjs.org`.
2. **Host Gateway Reachability**: Standard Docker bridge networking routes packets to the Docker host's gateway interface (`172.17.0.1` or host IP).
3. **Published Ports Reachable from Containers**: Ports published on the host by `docker-compose.yml` (specifically the API server on port `3000` and the Router on port `8080`) are reachable by build containers via the host gateway IP. The internal services (`postgres:5432`, `redis:6379`, `minio:9000`) are NOT published and are unreachable.

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
- Subdomains are validated against RFC 1035 (`^[a-z0-9-]{1,63}$`).
- Path traversal sequences, encoded traversal attempts, and null bytes return HTTP 400 Bad Request.
