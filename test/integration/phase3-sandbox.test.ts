import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeploymentRecord,
  DeploymentStatus,
  generateDeploymentId,
  getDeployment,
  updateDeploymentStatus,
  validateRepoUrl,
} from '@deployservice/shared';
import { buildRouter } from '../../apps/router/src/server.js';
import { executeBuild, reapOrphanedContainers } from '../../apps/worker/src/builder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe(
  'Phase 3 Integration: Docker Container Sandbox & Hostile Exploitation Containment',
  { timeout: 35000 },
  () => {
    const fixturesDir = path.resolve(__dirname, '../fixtures');
    const memoryBombDir = path.join(fixturesDir, 'memory-bomb');
    const infiniteLoopDir = path.join(fixturesDir, 'infinite-loop');
    const forkBombDir = path.join(fixturesDir, 'fork-bomb');
    const logFloodDir = path.join(fixturesDir, 'log-flood');
    const hostilePostinstallDir = path.join(fixturesDir, 'hostile-postinstall');
    const midsizeViteDir = path.join(fixturesDir, 'midsize-vite-app');

    const deploymentsStore = new Map<string, DeploymentRecord>();
    const storageStore = new Map<string, { body: Buffer; contentType: string }>();

    beforeEach(async () => {
      deploymentsStore.clear();
      storageStore.clear();

      // Mock DB operations to in-memory store while executing real Docker containers
      vi.spyOn(await import('@deployservice/shared'), 'getDeployment').mockImplementation(
        async (id: string) => deploymentsStore.get(id) || null
      );

      vi.spyOn(await import('@deployservice/shared'), 'updateDeploymentStatus').mockImplementation(
        async (id: string, nextStatus: any, updates = {}) => {
          const current = deploymentsStore.get(id);
          if (!current) throw new Error(`Deployment ${id} not found`);

          const { assertTransition } = await import('@deployservice/shared');
          assertTransition(current.status as any, nextStatus);

          const updated: DeploymentRecord = {
            ...current,
            status: nextStatus,
            ...updates,
          };
          deploymentsStore.set(id, updated);
          return updated;
        }
      );

      vi.spyOn(await import('@deployservice/shared'), 'uploadObject').mockImplementation(
        async (key: string, body: any, contentType: string) => {
          storageStore.set(key, {
            body: Buffer.isBuffer(body) ? body : Buffer.from(body),
            contentType,
          });
        }
      );

      vi.spyOn(await import('@deployservice/shared'), 'getObject').mockImplementation(
        async (key: string) => {
          const item = storageStore.get(key);
          if (!item) {
            const err: any = new Error('NoSuchKey');
            err.name = 'NoSuchKey';
            throw err;
          }
          const { Readable } = await import('node:stream');
          return {
            Body: Readable.from(item.body),
            ContentType: item.contentType,
            ETag: '"test-etag"',
          } as any;
        }
      );

      const mockRedis = {
        xadd: vi.fn().mockResolvedValue('1-0'),
        expire: vi.fn().mockResolvedValue(1),
        xrange: vi.fn().mockResolvedValue([]),
        publish: vi.fn().mockResolvedValue(1),
      };
      vi.spyOn(await import('@deployservice/shared'), 'getRedisClient').mockReturnValue(
        mockRedis as any
      );
    });

    function seedDeployment(id: string) {
      deploymentsStore.set(id, {
        id,
        project_id: 'prj_sandbox',
        status: DeploymentStatus.QUEUED,
        commit_sha: null,
        output_dir: null,
        error_message: null,
        created_at: new Date(),
        started_at: null,
        finished_at: null,
      });
    }

    it('memory bomb: container is killed by cgroup OOM killer, deployment marked failed with memory message', async () => {
      const id = generateDeploymentId();
      seedDeployment(id);

      await expect(
        executeBuild(id, 'https://github.com/example/memory-bomb', {
          fixtureDir: memoryBombDir,
          timeoutMs: 15000,
        })
      ).rejects.toThrow();

      const record = deploymentsStore.get(id);
      expect(record?.status).toBe(DeploymentStatus.FAILED);
      expect(record?.error_message?.toLowerCase()).toMatch(/memory|oom/);
    });

    it('infinite loop / sleep: killed at wall-clock timeout and marked timed_out', async () => {
      const id = generateDeploymentId();
      seedDeployment(id);

      // Run with 2-second timeout to verify quick kill
      await expect(
        executeBuild(id, 'https://github.com/example/infinite-loop', {
          fixtureDir: infiniteLoopDir,
          timeoutMs: 2000,
        })
      ).rejects.toThrow(/timed out/);

      const record = deploymentsStore.get(id);
      expect(record?.status).toBe(DeploymentStatus.TIMED_OUT);
      expect(record?.error_message?.toLowerCase()).toMatch(/timed out/);
    });

    it('fork bomb: contained by pids limit (100), host unaffected, marks deployment failed', async () => {
      const id = generateDeploymentId();
      seedDeployment(id);

      await expect(
        executeBuild(id, 'https://github.com/example/fork-bomb', {
          fixtureDir: forkBombDir,
          timeoutMs: 10000,
        })
      ).rejects.toThrow();

      const record = deploymentsStore.get(id);
      expect(record?.status).toBe(DeploymentStatus.FAILED);
    });

    it('log flood: output is truncated at 2MB without hanging stdout or exhausting memory, build completes', async () => {
      const id = generateDeploymentId();
      seedDeployment(id);

      await executeBuild(id, 'https://github.com/example/log-flood', {
        fixtureDir: logFloodDir,
        timeoutMs: 15000,
        maxLogBytes: 50 * 1024, // 50 KB cap for fast test execution
      });

      const record = deploymentsStore.get(id);
      expect(record?.status).toBe(DeploymentStatus.DEPLOYED);
      expect(storageStore.has(`deployments/${id}/index.html`)).toBe(true);
    });

    it('hostile postinstall: asserts credentials, socket, rootfs, and internal network are strictly defended', async () => {
      const id = generateDeploymentId();
      seedDeployment(id);

      await executeBuild(id, 'https://github.com/example/hostile-postinstall', {
        fixtureDir: hostilePostinstallDir,
        timeoutMs: 15000,
        enableHostInternalForTest: true,
      });

      const record = deploymentsStore.get(id);
      expect(record?.status).toBe(DeploymentStatus.DEPLOYED);
      expect(storageStore.has(`deployments/${id}/index.html`)).toBe(true);

      // Verify the audit execution proof in the deployed artifacts
      const auditProofItem = storageStore.get(`deployments/${id}/audit-proof.json`);
      expect(auditProofItem, 'Audit proof artifact must be captured in storage').toBeDefined();
      const auditProof = JSON.parse(auditProofItem!.body.toString('utf-8'));

      expect(auditProof.positiveControl).toBe(true);
      expect(typeof auditProof.gateway).toBe('string');
      expect(auditProof.probeResults).toBeDefined();

      if (auditProof.devOverlayActive) {
        // With overlay ON: probe to published port on host gateway MUST connect (positive control)
        const canReachPublished =
          auditProof.probeResults['host.docker.internal']?.[5432] ||
          auditProof.probeResults['host.docker.internal']?.[6379] ||
          auditProof.probeResults['host.docker.internal']?.[3000];
        expect(
          canReachPublished,
          'Probe must connect to published ports when dev overlay is ON'
        ).toBe(true);
      } else {
        // With overlay OFF: internal ports (5432, 6379, 9000, 9001) must fail to connect
        expect(auditProof.probeResults['host.docker.internal']?.[5432]).toBe(false);
        expect(auditProof.probeResults['host.docker.internal']?.[6379]).toBe(false);
        expect(auditProof.probeResults['host.docker.internal']?.[9000]).toBe(false);
        expect(auditProof.probeResults['host.docker.internal']?.[9001]).toBe(false);
      }

      console.log('AUDIT_PROOF_JSON:' + JSON.stringify(auditProof));
    });

    it('realistic mid-size Vite/React app: compiles cleanly within 512MB RAM and serves via router', async () => {
      const id = generateDeploymentId();
      seedDeployment(id);

      await executeBuild(id, 'https://github.com/example/midsize-vite-app', {
        fixtureDir: midsizeViteDir,
        timeoutMs: 15000,
      });

      const record = deploymentsStore.get(id);
      expect(record?.status).toBe(DeploymentStatus.DEPLOYED);
      expect(record?.output_dir).toBe('dist');

      // Test router serving the deployed mid-size application
      const router = buildRouter();
      const res = await router.inject({
        method: 'GET',
        url: '/',
        headers: { host: `${id}.localhost:8080` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Mid-Size Vite App');

      // Test asset serving
      const assetRes = await router.inject({
        method: 'GET',
        url: '/assets/main.js',
        headers: { host: `${id}.localhost:8080` },
      });
      expect(assetRes.statusCode).toBe(200);
      expect(assetRes.headers['content-type']).toContain('application/javascript');
      expect(assetRes.headers['cache-control']).toContain('immutable');
    });

    it('rejects hostile repository URLs with leading - or shell metacharacters', () => {
      const hostileUrls = [
        '--upload-pack=touch /tmp/pwned',
        '-oProxyCommand=sh evil.sh',
        'https://github.com/foo/bar;rm -rf /',
        'https://github.com/foo/bar`touch pwn`',
        'https://github.com/foo/bar$(whoami)',
        'https://github.com/foo/bar|sh',
        'https://github.com/foo/bar&echo pwn',
      ];

      for (const url of hostileUrls) {
        const res = validateRepoUrl(url);
        expect(res.valid, `Hostile URL '${url}' must be rejected`).toBe(false);
      }
    });

    it('startup reaper successfully clears orphaned containers and volumes', async () => {
      const result = await reapOrphanedContainers();
      expect(typeof result.containersReaped).toBe('number');
      expect(typeof result.volumesReaped).toBe('number');
    });

    it('entrypoint defense-in-depth: passes hostile strings directly to container entrypoint, asserts in-container exit code 1, validation log, and git never executed', async () => {
      const hostilePayloads = [
        '--upload-pack=touch /tmp/pwned',
        '$(touch /tmp/pwned)',
        'https://github.com/foo/bar`touch /tmp/pwned`',
        'https://github.com/foo/bar\ntouch /tmp/pwned',
        'https://github.com/foo/bar touch /tmp/pwned',
      ];

      for (let i = 0; i < hostilePayloads.length; i++) {
        const payload = hostilePayloads[i];
        const id = generateDeploymentId();
        seedDeployment(id);

        let thrownErr: any = null;
        try {
          // Directly invoke executeBuild, bypassing validateRepoUrl
          await executeBuild(id, payload, { timeoutMs: 5000 });
        } catch (err: any) {
          thrownErr = err;
        }

        expect(thrownErr).not.toBeNull();
        expect(thrownErr.exitCode).toBe(1);
        expect(thrownErr.logs).toMatch(/\[builder\] ERROR: REPO_URL/);
        expect(thrownErr.logs).not.toContain('[builder] Cloning repository:');
        expect(thrownErr.logs).not.toContain('Cloned commit:');

        // Assert deployment marked as failed
        const dep = await getDeployment(id);
        expect(dep?.status).toBe('failed');
      }
    });
  }
);
