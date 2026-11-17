import { describe, expect, it, vi } from 'vitest';
import * as shared from '@deployservice/shared';
import * as queueModule from './queue.js';
import { buildServer } from './server.js';

describe('API Server', () => {
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
        created_at: new Date(),
      });

      vi.spyOn(shared, 'createDeployment').mockResolvedValue({
        id: 'd-1234567890ab',
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
        payload: { repoUrl: 'https://github.com/facebook/react' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('d-1234567890ab');
      expect(body.status).toBe('queued');
      expect(mockQueueAdd).toHaveBeenCalledWith('build', {
        deploymentId: 'd-1234567890ab',
        repoUrl: 'https://github.com/facebook/react',
      });

      await app.close();
    });
  });

  describe('GET /deployments/:id', () => {
    it('returns deployment when found', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue({
        id: 'd-abc123456789',
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
        url: '/deployments/d-abc123456789',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('d-abc123456789');
      expect(body.status).toBe('deployed');

      await app.close();
    });

    it('returns 404 when deployment is not found', async () => {
      vi.spyOn(shared, 'getDeployment').mockResolvedValue(null);

      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/deployments/nonexistent-id',
      });

      expect(res.statusCode).toBe(404);
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

    it('allows requests with no Origin header (CLI / internal)', async () => {
      vi.spyOn(shared, 'checkDbHealth').mockResolvedValue(true);
      vi.spyOn(shared, 'checkRedisHealth').mockResolvedValue(true);
      vi.spyOn(shared, 'checkStorageHealth').mockResolvedValue(true);

      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      await app.close();
    });
  });
});
