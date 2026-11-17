import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import {
  getDbPool,
  closeDbPool,
  getRedisClient,
  closeRedis,
  ensureBucket,
  uploadObject,
  getObject,
  createOrGetProject,
  createDeployment,
  getDeployment,
  updateDeploymentStatus,
  DeploymentStatus,
  runMigrations,
} from '@deployservice/shared';

describe('Phase 2 Integration: Live Docker Services (Postgres, Redis, MinIO)', { timeout: 5000 }, () => {
  beforeAll(async () => {
    // Fast-fail connection check to ensure Postgres, Redis, and MinIO are reachable
    const pool = getDbPool();
    await pool.query('SELECT 1');
    await runMigrations();

    const redis = getRedisClient();
    await redis.ping();

    await ensureBucket();
  });

  afterAll(async () => {
    await closeDbPool();
    await closeRedis();
  });

  it('connects to Postgres and performs atomic deployment state transitions', async () => {
    const project = await createOrGetProject('live-test', 'https://github.com/example/repo');
    const deployment = await createDeployment(project.id);

    expect(deployment.id).toBeDefined();
    expect(deployment.status).toBe(DeploymentStatus.QUEUED);

    const cloning = await updateDeploymentStatus(deployment.id, DeploymentStatus.CLONING, {
      started_at: new Date(),
    });
    expect(cloning.status).toBe(DeploymentStatus.CLONING);
    expect(cloning.started_at).toBeDefined();

    const building = await updateDeploymentStatus(deployment.id, DeploymentStatus.BUILDING);
    expect(building.status).toBe(DeploymentStatus.BUILDING);

    const uploading = await updateDeploymentStatus(deployment.id, DeploymentStatus.UPLOADING, {
      output_dir: 'dist',
      commit_sha: '1234567890abcdef',
    });
    expect(uploading.status).toBe(DeploymentStatus.UPLOADING);

    const deployed = await updateDeploymentStatus(deployment.id, DeploymentStatus.DEPLOYED, {
      finished_at: new Date(),
    });
    expect(deployed.status).toBe(DeploymentStatus.DEPLOYED);
    expect(deployed.commit_sha).toBe('1234567890abcdef');

    const fetched = await getDeployment(deployment.id);
    expect(fetched?.status).toBe(DeploymentStatus.DEPLOYED);
  });

  it('connects to Redis and can publish/read messages', async () => {
    const redis = getRedisClient();
    const testKey = `test:live:${Date.now()}`;
    await redis.set(testKey, 'phase2-ok', 'EX', 10);
    const val = await redis.get(testKey);
    expect(val).toBe('phase2-ok');
  });

  it('connects to MinIO and uploads and streams back objects', async () => {
    const testKey = `deployments/test-live-${Date.now()}/index.html`;
    const testContent = '<!DOCTYPE html><html><body><h1>Live MinIO</h1></body></html>';

    await uploadObject(testKey, testContent, 'text/html');

    const obj = await getObject(testKey);
    expect(obj.ContentType).toBe('text/html');

    // Read stream to string
    const stream = obj.Body as any;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const bodyStr = Buffer.concat(chunks).toString('utf-8');
    expect(bodyStr).toBe(testContent);
  });
});
