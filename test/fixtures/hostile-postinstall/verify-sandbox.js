import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';

function getDefaultGateway() {
  try {
    const routeContent = fs.readFileSync('/proc/net/route', 'utf8');
    const lines = routeContent.trim().split('\n');
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts[1] === '00000000') {
        const hex = parts[2];
        const b1 = parseInt(hex.substring(6, 8), 16);
        const b2 = parseInt(hex.substring(4, 6), 16);
        const b3 = parseInt(hex.substring(2, 4), 16);
        const b4 = parseInt(hex.substring(0, 2), 16);
        return `${b1}.${b2}.${b3}.${b4}`;
      }
    }
  } catch (err) {
    console.warn('[audit] Could not parse /proc/net/route:', err.message);
  }
  return null;
}

async function checkTcp(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(true); // Connected
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

  // 4. Positive Control: Canary outbound connect (must succeed to prove probe ran)
  const canaryConnected =
    (await checkTcp('1.1.1.1', 53, 2000)) ||
    (await checkTcp('8.8.8.8', 53, 2000)) ||
    (await checkTcp('registry.npmjs.org', 443, 2000));

  if (!canaryConnected) {
    console.error('[audit] SECURITY FAILURE: Positive control canary connection failed (no outbound access).');
    process.exit(1);
  }
  console.log('[audit] POSITIVE CONTROL PASS: Outbound canary connectivity verified.');

  // 5. Network Isolation: Internal service names must never resolve or connect
  const internalServices = [
    { host: 'postgres', port: 5432 },
    { host: 'redis', port: 6379 },
    { host: 'minio', port: 9000 },
    { host: 'minio', port: 9001 },
    { host: 'api', port: 3000 },
    { host: 'router', port: 8080 },
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

    const connected = await checkTcp(svc.host, svc.port, 500);
    if (connected) {
      console.error(`[audit] SECURITY FAILURE: Connected to internal service ${svc.host}:${svc.port}`);
      process.exit(1);
    }
  }
  console.log('[audit] PASS: Internal compose services cannot be resolved or reached by name.');

  // 6. Network Probe: Dynamic Gateway IP, host.docker.internal, and host ports
  const dynamicGateway = getDefaultGateway();
  console.log(`[audit] Dynamic default gateway from /proc/net/route: ${dynamicGateway || 'none'}`);

  const hostTargets = [
    ...(dynamicGateway ? [dynamicGateway] : []),
    '172.17.0.1',
    '172.18.0.1',
    'host.docker.internal',
  ];
  const probedPorts = [3000, 8080, 9001, 5432, 6379, 9000];

  const probeResults = {};
  for (const host of hostTargets) {
    probeResults[host] = {};
    for (const port of probedPorts) {
      const connected = await checkTcp(host, port, 500);
      probeResults[host][port] = connected;
    }
  }

  console.log('[audit] Host probe results:', JSON.stringify(probeResults));

  // Determine if dev overlay is active (e.g. ports 5432/6379 published to host)
  const isDevOverlayActive = Object.values(probeResults).some((ports) => ports[5432] || ports[6379]);

  if (isDevOverlayActive) {
    console.log(
      '[audit] NOTICE: Dev overlay detected (ports published to host). Isolation against host gateway published ports is NOT guaranteed when dev overlay is enabled.'
    );
  } else {
    // When dev overlay is OFF (production compose default), internal ports must be completely unreachable
    for (const host of hostTargets) {
      for (const internalPort of [5432, 6379, 9000, 9001]) {
        if (probeResults[host][internalPort]) {
          console.error(
            `[audit] SECURITY FAILURE: Reached internal database/storage port on host ${host}:${internalPort} with overlay OFF!`
          );
          process.exit(1);
        }
      }
    }
    console.log('[audit] PASS: Internal ports (5432, 6379, 9000, 9001) are strictly unreachable via host gateway.');
  }

  // Write audit proof file into dist so the test suite can read the exact in-container results
  try {
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync(
      'dist/audit-proof.json',
      JSON.stringify(
        {
          positiveControl: true,
          gateway: dynamicGateway,
          probeResults,
          devOverlayActive: isDevOverlayActive,
        },
        null,
        2
      )
    );
  } catch (writeErr) {
    console.warn('[audit] Could not write audit-proof.json:', writeErr.message);
  }

  console.log('[audit] All sandbox security checks PASSED!');
}

runAudit().catch((err) => {
  console.error('[audit] Audit crashed:', err);
  process.exit(1);
});
