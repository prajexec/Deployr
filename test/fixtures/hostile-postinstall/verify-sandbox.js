import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';

async function checkTcp(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(true); // Connected (leak!)
      }
    });

    socket.on('timeout', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false); // Timed out (contained)
      }
    });

    socket.on('error', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false); // Refused or unreachable (contained)
      }
    });

    try {
      socket.connect(port, host);
    } catch {
      resolve(false);
    }
  });
}

async function runAudit() {
  console.log('[audit] Starting hostile sandbox verification tests inside container...');

  // 1. Environment Variable Leak Check
  const sensitiveVars = [
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
    'POSTGRES_USER',
    'S3_SECRET_ACCESS_KEY',
    'S3_ACCESS_KEY_ID',
    'REDIS_URL',
    'API_KEY',
  ];

  for (const v of sensitiveVars) {
    if (process.env[v]) {
      console.error(`[audit] SECURITY FAILURE: Leaked sensitive environment variable: ${v}`);
      process.exit(1);
    }
  }
  console.log('[audit] PASS: No infrastructure credentials leaked into container environment.');

  // 2. Docker Socket Access Check
  if (fs.existsSync('/var/run/docker.sock')) {
    console.error('[audit] SECURITY FAILURE: /var/run/docker.sock is accessible inside build container!');
    process.exit(1);
  }
  console.log('[audit] PASS: Docker socket is NOT mounted inside build container.');

  // 3. Filesystem Write Check (Read-Only Rootfs)
  const forbiddenWriteTargets = ['/etc/evil.txt', '/usr/evil.txt', '/root/evil.txt'];
  for (const target of forbiddenWriteTargets) {
    try {
      fs.writeFileSync(target, 'malicious payload');
      console.error(`[audit] SECURITY FAILURE: Wrote to read-only rootfs path: ${target}`);
      process.exit(1);
    } catch (err) {
      // Expected EROFS or EACCES
    }
  }
  console.log('[audit] PASS: Root filesystem is strictly read-only.');

  // 4. Network Isolation: Internal service names
  const internalServices = [
    { host: 'postgres', port: 5432 },
    { host: 'redis', port: 6379 },
    { host: 'minio', port: 9000 },
  ];

  for (const svc of internalServices) {
    let resolved = false;
    try {
      await dns.lookup(svc.host);
      resolved = true;
    } catch {
      // Expected ENOTFOUND / EAI_AGAIN
    }

    if (resolved) {
      console.error(`[audit] SECURITY FAILURE: Resolved internal compose service hostname: ${svc.host}`);
      process.exit(1);
    }

    const connected = await checkTcp(svc.host, svc.port, 1000);
    if (connected) {
      console.error(`[audit] SECURITY FAILURE: Connected to internal service ${svc.host}:${svc.port}`);
      process.exit(1);
    }
  }
  console.log('[audit] PASS: Internal compose services cannot be resolved or reached by name.');

  // 5. Network Isolation: Docker host gateway IP and host.docker.internal
  const hostTargets = ['172.17.0.1', '172.18.0.1', 'host.docker.internal'];
  const internalPorts = [5432, 6379, 9000];

  for (const host of hostTargets) {
    for (const port of internalPorts) {
      const connected = await checkTcp(host, port, 1000);
      if (connected) {
        console.error(`[audit] SECURITY FAILURE: Reached internal database/storage port on host gateway: ${host}:${port}`);
        process.exit(1);
      }
    }
  }
  console.log('[audit] PASS: Internal ports (5432, 6379, 9000) are not reachable via host gateway.');

  console.log('[audit] All sandbox security checks PASSED!');
}

runAudit().catch((err) => {
  console.error('[audit] Audit crashed:', err);
  process.exit(1);
});
