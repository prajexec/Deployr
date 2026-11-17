# Security Architecture & Limitations

## Security Notice: Phase 2 Current Status

> **WARNING**: Until Phase 3 (Docker Sandbox Isolation) is implemented, this platform executes build commands (`npm install`, `npm run build`) as a subprocess. **ONLY DEPLOY TRUSTED REPOSITORIES.** Do not deploy repositories from untrusted third parties on host environments.

---

## Threat Model & Mitigations (Phase 2)

### 1. Host Subprocess Environment Isolation (Phase 2 Limitation)
- **Current Limitation**: In Phase 2, the worker executes `npm install` and `npm run build` as a child process using Node's `child_process.spawn`. Although run from a temporary directory, untrusted scripts (such as `preinstall` or `postinstall` lifecycle hooks) execute under the worker's user permissions.
- **Implemented Mitigations in Phase 2**:
  - **Explicit Environment Sanitization**: The subprocess **never** inherits `process.env`. It is launched with a strictly minimal allowlist:
    - `PATH`: System binary path (`/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` or host `PATH`) needed to find `git`, `npm`, `node`.
    - `HOME`: Set strictly to the temporary build working directory (`/tmp/deploy-<id>`) to prevent writing to or reading from the user's real home directory (`~/.ssh`, `~/.npmrc`, `~/.aws`).
    - `CI`: Set to `'true'`.
  - **Credential Leakage Prevention**: Secrets such as `DATABASE_URL`, `REDIS_URL`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` are kept inside the worker process and are never exposed to the child process environment.
  - **Execution Timeouts**: Child processes are wrapped with an abort controller timeout (default 5 minutes) to prevent infinite loops or denial of service.
  - **Isolated Working Directories**: Each build clones into a dedicated temporary directory (`/tmp/deploy-<id>`) that is guaranteed to be deleted in a `finally` block regardless of build success or failure.

### 2. Phase 3 Containerization Roadmap
Phase 3 removes host subprocess execution completely by running every build in an isolated throwaway Docker container:
- Single-use throwaway containers per build.
- Strict resource constraints (CPU, memory, disk quotas).
- Controlled network egress.
- Non-root container user execution.
- Drop all capabilities (`--cap-drop=ALL`).

---

### 3. Repository URL Allowlist Validation
To prevent Server-Side Request Forgery (SSRF) and malicious scheme execution (e.g. `file://`, `ssh://`, internal IPs):
- Only `https://` URLs pointing to `github.com` matching the regex `^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(\.git)?\/?$` are permitted.
- Custom ports, credentials in URLs (`user:pass@`), IP literals (`127.0.0.1`, `169.254.169.254`), and alternative domains are rejected with `400 Bad Request`.

---

### 4. Router Path Traversal Protection
Static assets served via the router (`<id>.localhost:8080`) are protected against path traversal attacks (`../`, `%2e%2e/`, null bytes):
- Raw request URLs are intercepted before framework normalization.
- Subdomains are validated against RFC 1035 (`^[a-z0-9-]{1,63}$`).
- Path traversal sequences, encoded traversal attempts, and null bytes are rejected immediately with `400 Bad Request`.
