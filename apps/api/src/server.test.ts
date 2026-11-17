import { describe, expect, it, vi } from 'vitest';
import * as shared from '@deployservice/shared';
import { buildServer } from './server.js';

describe('API Server /healthz', () => {
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
