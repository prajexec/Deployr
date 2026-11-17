import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeploymentRecord,
  DeploymentStatus,
  generateDeploymentId,
  getDeployment,
  updateDeploymentStatus,
} from '@deployservice/shared';
import { buildRouter } from '../../apps/router/src/server.js';
import { executeBuild } from '../../apps/worker/src/builder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Phase 2 Integration: End-to-End Build and Router Flow', { timeout: 60000 }, () => {
  const viteFixturePath = path.resolve(__dirname, '../fixtures/vite-app');
  const failingFixturePath = path.resolve(__dirname, '../fixtures/failing-app');

  // Simulated in-memory deployment store for integration test
  const deploymentsStore = new Map<string, DeploymentRecord>();
  const storageStore = new Map<string, { body: Buffer; contentType: string }>();

  beforeEach(async () => {
    deploymentsStore.clear();
    storageStore.clear();

    // Mock DB operations to operate on in-memory store while exercising real state machine and builder
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

    // Mock storage upload / get to operate on in-memory storage store
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
  });

  it('successfully builds fixture repo, publishes to storage, and serves via router', async () => {
    const deploymentId = generateDeploymentId();

    // Seed deployment in 'queued' state
    deploymentsStore.set(deploymentId, {
      id: deploymentId,
      project_id: 'prj_test',
      status: DeploymentStatus.QUEUED,
      commit_sha: null,
      output_dir: null,
      error_message: null,
      created_at: new Date(),
      started_at: null,
      finished_at: null,
    });

    // 1. Run builder against local fixture
    await executeBuild(deploymentId, 'https://github.com/example/vite-app', {
      fixtureDir: viteFixturePath,
    });

    // 2. Verify deployment state is 'deployed'
    const finalDeployment = deploymentsStore.get(deploymentId);
    expect(finalDeployment?.status).toBe(DeploymentStatus.DEPLOYED);
    expect(finalDeployment?.output_dir).toBe('dist');
    expect(finalDeployment?.finished_at).toBeDefined();

    // 3. Verify files uploaded to storage
    expect(storageStore.has(`deployments/${deploymentId}/index.html`)).toBe(true);
    expect(storageStore.has(`deployments/${deploymentId}/assets/app.js`)).toBe(true);
    expect(storageStore.has(`deployments/${deploymentId}/assets/style.css`)).toBe(true);

    // 4. Test router serving deployed site
    const router = buildRouter();

    // Query root -> serves index.html
    const rootRes = await router.inject({
      method: 'GET',
      url: '/',
      headers: { host: `${deploymentId}.localhost:8080` },
    });
    expect(rootRes.statusCode).toBe(200);
    expect(rootRes.headers['content-type']).toContain('text/html');
    expect(rootRes.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(rootRes.body).toContain('Hello from Fixture Vite App!');

    // Query static asset -> serves with immutable long cache
    const assetRes = await router.inject({
      method: 'GET',
      url: '/assets/app.js',
      headers: { host: `${deploymentId}.localhost:8080` },
    });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers['content-type']).toContain('application/javascript');
    expect(assetRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(assetRes.body).toContain('vite asset');

    // Query extensionless path -> SPA fallback returns index.html
    const spaRes = await router.inject({
      method: 'GET',
      url: '/user/profile',
      headers: { host: `${deploymentId}.localhost:8080` },
    });
    expect(spaRes.statusCode).toBe(200);
    expect(spaRes.headers['content-type']).toContain('text/html');
    expect(spaRes.body).toContain('Hello from Fixture Vite App!');

    // Query missing asset (with file extension) -> returns real 404
    const missingAssetRes = await router.inject({
      method: 'GET',
      url: '/assets/missing-chunk.js',
      headers: { host: `${deploymentId}.localhost:8080` },
    });
    expect(missingAssetRes.statusCode).toBe(404);
    expect(missingAssetRes.body).toBe('404 Not Found');

    await router.close();
  });

  it('marks deployment as failed on build failure and router refuses to serve it', async () => {
    const deploymentId = generateDeploymentId();

    deploymentsStore.set(deploymentId, {
      id: deploymentId,
      project_id: 'prj_test',
      status: DeploymentStatus.QUEUED,
      commit_sha: null,
      output_dir: null,
      error_message: null,
      created_at: new Date(),
      started_at: null,
      finished_at: null,
    });

    // Builder should fail and throw
    await expect(
      executeBuild(deploymentId, 'https://github.com/example/failing-app', {
        fixtureDir: failingFixturePath,
      })
    ).rejects.toThrow();

    // Verify terminal status is 'failed' and error_message is saved
    const finalDeployment = deploymentsStore.get(deploymentId);
    expect(finalDeployment?.status).toBe(DeploymentStatus.FAILED);
    expect(finalDeployment?.error_message).toContain('Syntax error');
    expect(finalDeployment?.finished_at).toBeDefined();

    // Router must return 404 for non-deployed sites
    const router = buildRouter();
    const res = await router.inject({
      method: 'GET',
      url: '/',
      headers: { host: `${deploymentId}.localhost:8080` },
    });

    expect(res.statusCode).toBe(404);
    await router.close();
  });
});
