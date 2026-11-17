import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDbPool,
  closeRedis,
  createDeployment,
  createOrGetProject,
  DeploymentStatus,
  ensureBucket,
  getDbPool,
  getDeployment,
  getProject,
  getRedisClient,
  resetConfig,
  rollbackProjectDeployment,
  runMigrations,
  updateDeploymentStatus,
  uploadObject,
} from '@deployservice/shared';
import { buildServer } from '../../apps/api/src/server.js';
import { buildRouter } from '../../apps/router/src/server.js';
import { recoverStuckDeployments } from '../../apps/worker/src/recovery.js';

describe('Phase 5 Integration: Robustness, Cancellation, and Atomic Rollback', () => {
  let apiApp: any;
  let routerApp: any;
  const redis = getRedisClient();
  const testApiKey = crypto.randomBytes(32).toString('hex');

  beforeAll(async () => {
    process.env.API_KEY = testApiKey;
    resetConfig();

    const pool = getDbPool();
    await pool.query('SELECT 1');
    await runMigrations();
    await redis.ping();
    await ensureBucket();

    apiApp = buildServer();
    routerApp = buildRouter({ deploymentTtlMs: 100 }); // Fast TTL for testing rollback cache
  });

  afterAll(async () => {
    if (apiApp) await apiApp.close();
    if (routerApp) await routerApp.close();
    await closeDbPool();
    await closeRedis();
  });

  it('cancels an active deployment, transitions state to cancelled, and emits end event', async () => {
    const project = await createOrGetProject(
      'cancel-integration-test',
      'https://github.com/example/cancel-test'
    );
    const deployment = await createDeployment(project.id);
    const depId = deployment.id;

    // Transition to building
    await updateDeploymentStatus(depId, DeploymentStatus.CLONING);
    await updateDeploymentStatus(depId, DeploymentStatus.BUILDING);

    // Call cancellation API
    const res = await apiApp.inject({
      method: 'POST',
      url: `/deployments/${depId}/cancel`,
      headers: { 'x-api-key': testApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(depId);
    expect(body.status).toBe('cancelled');

    // Verify DB record is terminal 'cancelled'
    const updated = await getDeployment(depId);
    expect(updated?.status).toBe('cancelled');
    expect(updated?.error_message).toMatch(/cancelled by user/i);

    // Verify terminal end event on Redis stream
    const entries = await redis.xrevrange(`deployservice:logs:${depId}`, '+', '-', 'COUNT', 1);
    expect(entries.length).toBeGreaterThan(0);
    const fields = entries[0][1];
    expect(fields).toContain('event');
    expect(fields).toContain('end');
    const dataIdx = fields.indexOf('data');
    const data = JSON.parse(fields[dataIdx + 1]);
    expect(data.status).toBe('cancelled');
  });

  it('recovers stuck deployment left in building state by supervisor', async () => {
    const project = await createOrGetProject(
      'recovery-integration-test',
      'https://github.com/example/recovery-test'
    );
    const deployment = await createDeployment(project.id);
    const depId = deployment.id;

    // Simulate worker crash during build
    await updateDeploymentStatus(depId, DeploymentStatus.CLONING);
    await updateDeploymentStatus(depId, DeploymentStatus.BUILDING);

    // Run recovery with includeAllOnStartup to simulate worker reboot
    const recoveryResult = await recoverStuckDeployments({
      includeAllOnStartup: true,
    });

    expect(recoveryResult.recoveredDeploymentIds).toContain(depId);

    // Verify status in DB transitioned to failed
    const recovered = await getDeployment(depId);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error_message).toMatch(/recovered by supervisor/i);
  });

  it('atomically publishes new releases to project subdomain and rolls back cleanly', async () => {
    const project = await createOrGetProject(
      'rollback-integration-test',
      'https://github.com/example/rollback-test'
    );
    const projId = project.id;

    // 1. Release V1
    const dep1 = await createDeployment(projId);
    await updateDeploymentStatus(dep1.id, DeploymentStatus.CLONING);
    await updateDeploymentStatus(dep1.id, DeploymentStatus.BUILDING);
    await updateDeploymentStatus(dep1.id, DeploymentStatus.UPLOADING);
    await uploadObject(
      `deployments/${dep1.id}/index.html`,
      '<h1>Version 1.0</h1>',
      'text/html; charset=utf-8'
    );
    await updateDeploymentStatus(dep1.id, DeploymentStatus.DEPLOYED, {
      commit_sha: 'v1.0.0-sha',
    });
    // Set project current deployment
    await apiApp.inject({
      method: 'POST',
      url: `/projects/${projId}/rollback`,
      headers: { 'x-api-key': testApiKey },
      payload: { targetDeploymentId: dep1.id },
    });

    // Verify router serves V1 from project domain
    const resV1 = await routerApp.inject({
      method: 'GET',
      url: '/index.html',
      headers: { host: `${projId}.localhost:8080` },
    });
    expect(resV1.statusCode).toBe(200);
    expect(resV1.body).toBe('<h1>Version 1.0</h1>');

    // 2. Release V2
    const dep2 = await createDeployment(projId);
    await updateDeploymentStatus(dep2.id, DeploymentStatus.CLONING);
    await updateDeploymentStatus(dep2.id, DeploymentStatus.BUILDING);
    await updateDeploymentStatus(dep2.id, DeploymentStatus.UPLOADING);
    await uploadObject(
      `deployments/${dep2.id}/index.html`,
      '<h1>Version 2.0</h1>',
      'text/html; charset=utf-8'
    );
    await updateDeploymentStatus(dep2.id, DeploymentStatus.DEPLOYED, {
      commit_sha: 'v2.0.0-sha',
    });
    // Point project to V2
    await apiApp.inject({
      method: 'POST',
      url: `/projects/${projId}/rollback`,
      headers: { 'x-api-key': testApiKey },
      payload: { targetDeploymentId: dep2.id },
    });

    // Wait a brief moment for LRU cache to expire
    await new Promise((r) => setTimeout(r, 150));

    // Verify router now serves V2
    const resV2 = await routerApp.inject({
      method: 'GET',
      url: '/index.html',
      headers: { host: `${projId}.localhost:8080` },
    });
    expect(resV2.statusCode).toBe(200);
    expect(resV2.body).toBe('<h1>Version 2.0</h1>');

    // 3. Rollback to V1 via API (without specifying targetDeploymentId - automatic rollback to previous)
    const rollbackRes = await apiApp.inject({
      method: 'POST',
      url: `/projects/${projId}/rollback`,
      headers: { 'x-api-key': testApiKey },
    });

    expect(rollbackRes.statusCode).toBe(200);
    const rollbackBody = JSON.parse(rollbackRes.body);
    expect(rollbackBody.success).toBe(true);
    expect(rollbackBody.currentDeploymentId).toBe(dep1.id);
    expect(rollbackBody.commitSha).toBe('v1.0.0-sha');

    // Verify Postgres project record
    const updatedProj = await getProject(projId);
    expect(updatedProj?.current_deployment_id).toBe(dep1.id);

    // Wait for cache expiry
    await new Promise((r) => setTimeout(r, 150));

    // Verify router instantly serves V1 again!
    const resRollback = await routerApp.inject({
      method: 'GET',
      url: '/index.html',
      headers: { host: `${projId}.localhost:8080` },
    });
    expect(resRollback.statusCode).toBe(200);
    expect(resRollback.body).toBe('<h1>Version 1.0</h1>');

    // Both immutable preview URLs remain intact
    const preview1 = await routerApp.inject({
      method: 'GET',
      url: '/index.html',
      headers: { host: `${dep1.id}.localhost:8080` },
    });
    expect(preview1.body).toBe('<h1>Version 1.0</h1>');

    const preview2 = await routerApp.inject({
      method: 'GET',
      url: '/index.html',
      headers: { host: `${dep2.id}.localhost:8080` },
    });
    expect(preview2.body).toBe('<h1>Version 2.0</h1>');
  });
});
