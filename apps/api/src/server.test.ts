import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as shared from '@deployservice/shared';
import * as queueModule from './queue.js';
import { buildServer, validateApiKeyConfig } from './server.js';

const VALID_ID = 'd-0123456789abcdef0123456789abcdef';
const VALID_ID_2 = 'd-ffffffffffffffffffffffffffffffff';

const testApiKey = crypto.randomBytes(32).toString('hex');
process.env.API_KEY = testApiKey;

describe('API Server', () => {
  beforeEach(() => {
    process.env.API_KEY = testApiKey;
    shared.resetConfig();
  });
  describe('GET /healthz', () => {
    it('returns 200 and ok status when all dependencies are healthy', async () => {
      vi.spyOn(shared, 'checkDbHealth').mockResolvedValue(true);
      vi.spyOn(shared, 'checkRedisHealth').mockResolvedValue(true);
      vi.spyOn(shared, 'checkStorageHealth').mockResolvedValue(true);

      const app = buildServer();
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.services.postgres).toBe('healthy');
      expect(body.services.redis).toBe('healthy');
      expect(body.services.storage).toBe('healthy');
      await app.close();
    });

    it('returns 503 and degraded status when a dependency is down', async () => {
      vi.spyOn(shared, 'checkDbHealth').mockResolvedValue(false);
      vi.spyOn(shared, 'checkRedisHealth').mockResolvedValue(true);
      vi.spyOn(shared, 'checkStorageHealth').mockResolvedValue(true);

      const app = buildServer();
      const response = await app.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('degraded');
      expect(body.services.postgres).toBe('unhealthy');
      expect(body.services.redis).toBe('healthy');
      expect(body.services.storage).toBe('healthy');
      await app.close();
    });
  });

  describe('API Key Startup Validation', () => {
    it('refuses to start when API_KEY is missing or empty', () => {
      delete process.env.API_KEY;
      shared.resetConfig();
      expect(() => buildServer()).toThrow(/API_KEY is required and cannot be empty/);

      process.env.API_KEY = '   ';
      shared.resetConfig();
      expect(() => buildServer()).toThrow(/API_KEY is required and cannot be empty/);
    });

    it('refuses to start when API_KEY is insecure "dev-api-key"', () => {
      process.env.API_KEY = 'dev-api-key';
      shared.resetConfig();
      expect(() => buildServer()).toThrow(/Insecure API_KEY "dev-api-key" is prohibited/);
    });

    it('refuses to start when API_KEY is set to placeholder value', () => {
      process.env.API_KEY = '<GENERATE_API_KEY_WITH_OPENSSL_RAND_HEX_32>';
      shared.resetConfig();
      expect(() => buildServer()).toThrow(/placeholder value/);

      process.env.API_KEY = '<SOME_OTHER_PLACEHOLDER>';
      shared.resetConfig();
      expect(() => buildServer()).toThrow(/placeholder value/);
    });

    it('accepts strong random API_KEY', () => {
      const key = crypto.randomBytes(32).toString('hex');
      process.env.API_KEY = key;
      shared.resetConfig();
      const app = buildServer();
      expect(app).toBeDefined();
    });
  });

  describe('API Key Authentication', () => {
    it('rejects POST /deployments with 401 when API key is missing or invalid', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: '/deployments',
        payload: { repoUrl: 'https://github.com/facebook/react' },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toMatch(/Unauthorized/);

      const resBadKey = await app.inject({
        method: 'POST',
        url: '/deployments',
        headers: { 'x-api-key': 'wrong-key' },
        payload: { repoUrl: 'https://github.com/facebook/react' },
      });
      expect(resBadKey.statusCode).toBe(401);
      await app.close();
    });

    it('rejects GET /deployments (list) with 401 when API key is missing or invalid', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/deployments',
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('accepts valid API key via x-api-key or Bearer token', async () => {
      vi.spyOn(shared, 'listDeployments').mockResolvedValue([]);
      const app = buildServer();

      const resHeader = await app.inject({
        method: 'GET',
        url: '/deployments',
        headers: { 'x-api-key': testApiKey },
      });
      expect(resHeader.statusCode).toBe(200);

      const resBearer = await app.inject({
        method: 'GET',
        url: '/deployments',
        headers: { authorization: `Bearer ${testApiKey}` },
      });
      expect(resBearer.statusCode).toBe(200);
      await app.close();
    });
  });

  describe('POST /deployments', () => {
    it('rejects invalid or malicious repository URLs with 400', async () => {
      const app = buildServer();

      const invalidPayloads = [
        {},
        { repoUrl: '' },
        { repoUrl: 'file:///etc/passwd' },
        { repoUrl: 'http://169.254.169.254/latest/meta-data' },
        { repoUrl: 'https://github.com.evil.com/owner/repo' },
        { repoUrl: 'ssh://git@github.com/owner/repo.git' },
      ];

      for (const payload of invalidPayloads) {
        const res = await app.inject({
          method: 'POST',
          url: '/deployments',
          headers: { 'x-api-key': testApiKey },
          payload,
        });

        expect(res.statusCode, `Expected 400 for ${JSON.stringify(payload)}`).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBeDefined();
      }

      await app.close();
    });

    it('accepts valid GitHub URL and enqueues job with 201', async () => {
      vi.spyOn(shared, 'createOrGetProject').mockResolvedValue({
        id: 'prj_test123',
        name: 'facebook/react',
        repo_url: 'https://github.com/facebook/react',
        current_deployment_id: null,
        created_at: new Date(),
      });

      vi.spyOn(shared, 'createDeployment').mockResolvedValue({
        id: VALID_ID,
        project_id: 'prj_test123',
        status: 'queued',
        commit_sha: null,
        output_dir: null,
        error_message: null,
        created_at: new Date(),
        started_at: null,
        finished_at: null,
      });

      const mockQueueAdd = vi.fn().mockResolvedValue({});
      vi.spyOn(queueModule, 'getDeploymentQueue').mockReturnValue({
        add: mockQueueAdd,
      } as any);

      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: '/deployments',
        headers: { 'x-api-key': testApiKey },
        payload: { repoUrl: 'https://github.com/facebook/react' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(VALID_ID);
      expect(body.status).toBe('queued');
      expect(mockQueueAdd).toHaveBeenCalledWith('build', {
        deploymentId: VALID_ID,
        repoUrl: 'https://github.com/facebook/react',
      });

      await app.close();
    });

    it('rejects requests with non-JSON Content-Type', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: '/deployments',
        headers: {
          'x-api-key': testApiKey,
          'content-type': 'text/plain',
        },
        payload: 'https://github.com/facebook/react',
      });

      expect(res.statusCode).toBe(415);
      await app.close();
    });
  });

  describe('GET /deployments/:id', () => {
    it('validates 128-bit deployment ID format and rejects malformed IDs with 400', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/deployments/d-invalid-short',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/Invalid deployment ID format/);
      await app.close();
    });

    it('returns deployment when found without requiring API key', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue({
        id: VALID_ID,
        project_id: 'prj_test123',
        status: 'deployed',
        commit_sha: 'a1b2c3d4e5f6',
        output_dir: 'dist',
        error_message: null,
        created_at: new Date(),
        started_at: new Date(),
        finished_at: new Date(),
      });

      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: `/deployments/${VALID_ID}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(VALID_ID);
      expect(body.status).toBe('deployed');

      await app.close();
    });

    it('returns 404 when deployment is not found', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue(null);

      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: `/deployments/${VALID_ID_2}`,
      });

      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe('POST /deployments/:id/cancel', () => {
    it('requires API key authentication', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: `/deployments/${VALID_ID}/cancel`,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('rejects malformed deployment IDs with 400', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: '/deployments/d-invalid/cancel',
        headers: { 'x-api-key': testApiKey },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('returns 404 when deployment does not exist', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue(null);
      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: `/deployments/${VALID_ID}/cancel`,
        headers: { 'x-api-key': testApiKey },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('returns 409 Conflict when deployment is already in terminal state', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue({
        id: VALID_ID,
        project_id: 'prj_test',
        status: 'deployed',
      } as any);

      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: `/deployments/${VALID_ID}/cancel`,
        headers: { 'x-api-key': testApiKey },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toMatch(/already in terminal state/);
      await app.close();
    });

    it('cancels a queued deployment and removes it from BullMQ', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue({
        id: VALID_ID,
        project_id: 'prj_test',
        status: 'queued',
      } as any);

      const mockJob = {
        data: { deploymentId: VALID_ID },
        remove: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(queueModule, 'getDeploymentQueue').mockReturnValue({
        getJobs: vi.fn().mockResolvedValue([mockJob]),
      } as any);

      const mockRedis = {
        publish: vi.fn().mockResolvedValue(1),
        xadd: vi.fn().mockResolvedValue('1-0'),
      };
      vi.spyOn(shared, 'getRedisClient').mockReturnValue(mockRedis as any);

      vi.spyOn(shared, 'updateDeploymentStatus').mockResolvedValue({
        id: VALID_ID,
        status: 'cancelled',
      } as any);

      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: `/deployments/${VALID_ID}/cancel`,
        headers: { 'x-api-key': testApiKey },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(VALID_ID);
      expect(body.status).toBe('cancelled');
      expect(mockJob.remove).toHaveBeenCalled();
      await app.close();
    });
  });

  describe('POST /projects/:id/rollback', () => {
    const VALID_PROJECT_ID = 'prj_0123456789ab';

    it('requires API key authentication', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${VALID_PROJECT_ID}/rollback`,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('rejects malformed project ID with 400', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: '/projects/invalid-id/rollback',
        headers: { 'x-api-key': testApiKey },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/Invalid project ID format/);
      await app.close();
    });

    it('rejects malformed target deployment ID with 400', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${VALID_PROJECT_ID}/rollback`,
        headers: { 'x-api-key': testApiKey },
        payload: { targetDeploymentId: 'd-invalid' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/Invalid target deployment ID format/);
      await app.close();
    });

    it('returns 404 when project not found', async () => {
      vi.spyOn(shared, 'rollbackProjectDeployment').mockRejectedValue(
        new Error(`Project with id '${VALID_PROJECT_ID}' not found`)
      );

      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${VALID_PROJECT_ID}/rollback`,
        headers: { 'x-api-key': testApiKey },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('successfully rolls back project deployment', async () => {
      vi.spyOn(shared, 'rollbackProjectDeployment').mockResolvedValue({
        project: {
          id: VALID_PROJECT_ID,
          name: 'facebook/react',
          repo_url: 'https://github.com/facebook/react',
          current_deployment_id: VALID_ID,
          created_at: new Date(),
        },
        deployment: {
          id: VALID_ID,
          project_id: VALID_PROJECT_ID,
          status: 'deployed',
          commit_sha: 'commit123',
          output_dir: 'dist',
          error_message: null,
          created_at: new Date(),
          started_at: new Date(),
          finished_at: new Date(),
        },
      });

      const app = buildServer();
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${VALID_PROJECT_ID}/rollback`,
        headers: { 'x-api-key': testApiKey },
        payload: { targetDeploymentId: VALID_ID },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.projectId).toBe(VALID_PROJECT_ID);
      expect(body.currentDeploymentId).toBe(VALID_ID);
      expect(body.commitSha).toBe('commit123');
      await app.close();
    });
  });

  describe('GET /projects/:id', () => {
    const VALID_PROJECT_ID = 'prj_0123456789ab';

    it('requires API key authentication', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: `/projects/${VALID_PROJECT_ID}`,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('rejects malformed project ID with 400', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/projects/invalid-id',
        headers: { 'x-api-key': testApiKey },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('returns 404 when project not found', async () => {
      vi.spyOn(shared, 'getProject').mockResolvedValue(null);
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: `/projects/${VALID_PROJECT_ID}`,
        headers: { 'x-api-key': testApiKey },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('returns project details when found', async () => {
      vi.spyOn(shared, 'getProject').mockResolvedValue({
        id: VALID_PROJECT_ID,
        name: 'facebook/react',
        repo_url: 'https://github.com/facebook/react',
        current_deployment_id: VALID_ID,
        created_at: new Date(),
      });
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: `/projects/${VALID_PROJECT_ID}`,
        headers: { 'x-api-key': testApiKey },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(VALID_PROJECT_ID);
      expect(body.current_deployment_id).toBe(VALID_ID);
      await app.close();
    });
  });

  describe('GET /deployments/:id/logs (SSE & Historical Logs)', () => {
    it('rejects malformed deployment IDs with 400', async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/deployments/d-short/logs',
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('returns 404 if deployment does not exist', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue(null);
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: `/deployments/${VALID_ID}/logs`,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('serves raw text log when Accept: text/plain or format=raw', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue({
        id: VALID_ID,
        project_id: 'prj_test',
        status: 'deployed',
        commit_sha: null,
        output_dir: null,
        error_message: null,
        created_at: new Date(),
        started_at: null,
        finished_at: null,
      });

      vi.spyOn(shared, 'getObject').mockResolvedValue({
        Body: Buffer.from('[builder] Build complete\n'),
        ContentType: 'text/plain',
      } as any);

      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: `/deployments/${VALID_ID}/logs?format=raw`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('[builder] Build complete');
      await app.close();
    });

    it('serves SSE stream with correct headers, Vary: Origin, and CORS allowlist', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue({
        id: VALID_ID,
        project_id: 'prj_test',
        status: 'deployed',
        commit_sha: null,
        output_dir: null,
        error_message: null,
        created_at: new Date(),
        started_at: null,
        finished_at: new Date(),
      });

      vi.spyOn(shared, 'getObject').mockResolvedValue({
        Body: Buffer.from('Archived build logs\n'),
        ContentType: 'text/plain',
      } as any);

      const mockRedis = {
        xrange: vi.fn().mockResolvedValue([]),
      };
      vi.spyOn(shared, 'getRedisClient').mockReturnValue(mockRedis as any);

      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: `/deployments/${VALID_ID}/logs`,
        headers: {
          accept: 'text/event-stream',
          origin: 'http://localhost:5173',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(res.headers['vary']).toBe('Origin');
      expect(res.body).toContain('event: log');
      expect(res.body).toContain('Archived build logs');
      expect(res.body).toContain('event: end');
      await app.close();
    });
  });

  describe('CORS policy', () => {
    it('sets Access-Control-Allow-Origin for the configured FRONTEND_URL', async () => {
      vi.spyOn(shared, 'checkDbHealth').mockResolvedValue(true);
      vi.spyOn(shared, 'checkRedisHealth').mockResolvedValue(true);
      vi.spyOn(shared, 'checkStorageHealth').mockResolvedValue(true);

      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: {
          origin: 'http://localhost:5173',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      await app.close();
    });

    it('rejects cross-origin requests from untrusted origins', async () => {
      vi.spyOn(shared, 'checkDbHealth').mockResolvedValue(true);
      vi.spyOn(shared, 'checkRedisHealth').mockResolvedValue(true);
      vi.spyOn(shared, 'checkStorageHealth').mockResolvedValue(true);

      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: {
          origin: 'http://evil.com',
        },
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });
  });
});
