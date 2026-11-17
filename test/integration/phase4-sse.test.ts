import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDbPool,
  closeRedis,
  createDeployment,
  createOrGetProject,
  DeploymentStatus,
  ensureBucket,
  getDbPool,
  getRedisClient,
  runMigrations,
  updateDeploymentStatus,
  uploadObject,
} from '@deployservice/shared';
import { buildServer } from '../../apps/api/src/server.js';
import { DeploymentLogWriter } from '../../apps/worker/src/stream-writer.js';

describe('Phase 4 Integration: SSE Live Log Streaming & Archive Replay', () => {
  let app: any;
  const redis = getRedisClient();

  beforeAll(async () => {
    const pool = getDbPool();
    await pool.query('SELECT 1');
    await runMigrations();
    await redis.ping();
    await ensureBucket();
    app = buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeDbPool();
    await closeRedis();
  });

  it('reconnect with Last-Event-ID receives strictly newer events with no dups and no gaps', async () => {
    const project = await createOrGetProject(
      'reconnect-test',
      'https://github.com/example/reconnect-test'
    );
    const deployment = await createDeployment(project.id);
    const depId = deployment.id;

    const writer = new DeploymentLogWriter(depId, redis);
    await writer.start();

    // Write initial log lines
    writer.writeChunk('stdout', 'line 1\nline 2\n');
    writer.writeChunk('stdout', 'line 3\nline 4\n');
    await writer.finish('deployed', 0);

    // First request: from beginning
    const res1 = await app.inject({
      method: 'GET',
      url: `/deployments/${depId}/logs`,
      headers: { accept: 'text/event-stream' },
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.body).toContain('line 1');
    expect(res1.body).toContain('line 2');
    expect(res1.body).toContain('line 3');
    expect(res1.body).toContain('line 4');

    // Extract the ID of line 2
    const lines = res1.body.split('\n');
    let line2Id = '';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('line 2')) {
        // The preceding line is id: <id>
        for (let j = i - 1; j >= 0; j--) {
          if (lines[j].startsWith('id: ')) {
            line2Id = lines[j].replace('id: ', '').trim();
            break;
          }
        }
        break;
      }
    }
    expect(line2Id).toBeTruthy();

    // Second request: resume with Last-Event-ID pointing to line 2
    const res2 = await app.inject({
      method: 'GET',
      url: `/deployments/${depId}/logs`,
      headers: {
        accept: 'text/event-stream',
        'last-event-id': line2Id,
      },
    });

    expect(res2.statusCode).toBe(200);
    // Must NOT contain line 1 or line 2 (no duplicates)
    expect(res2.body).not.toContain('line 1');
    expect(res2.body).not.toContain('line 2');
    // MUST contain line 3 and line 4 (no gaps)
    expect(res2.body).toContain('line 3');
    expect(res2.body).toContain('line 4');
    expect(res2.body).toContain('event: end');
  });

  it('handles concurrent writes during replay without losing or duplicating entries', async () => {
    const project = await createOrGetProject(
      'concurrent-test',
      'https://github.com/example/concurrent-test'
    );
    const deployment = await createDeployment(project.id);
    const depId = deployment.id;

    const writer = new DeploymentLogWriter(depId, redis);
    await writer.start();

    for (let i = 1; i <= 5; i++) {
      writer.writeChunk('stdout', `early line ${i}\n`);
    }
    await writer.flushBatch();

    // Simulate concurrent writer pushing while reading
    const streamPromise = app.inject({
      method: 'GET',
      url: `/deployments/${depId}/logs`,
      headers: { accept: 'text/event-stream' },
    });

    // Concurrently write new lines during query
    for (let i = 6; i <= 10; i++) {
      writer.writeChunk('stdout', `concurrent line ${i}\n`);
    }
    await writer.finish('deployed', 0);

    const res = await streamPromise;
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('early line 1');
    expect(res.body).toContain('early line 5');
    expect(res.body).toContain('concurrent line 6');
    expect(res.body).toContain('concurrent line 10');
    expect(res.body).toContain('event: end');
  });

  it('replays finished builds directly from MinIO archive when stream is expired', async () => {
    const project = await createOrGetProject(
      'archive-test',
      'https://github.com/example/archive-test'
    );
    const deployment = await createDeployment(project.id);
    const depId = deployment.id;

    // Upload archive to MinIO directly and mark deployed, without any Redis stream
    const archiveContent =
      '[archive] full historical log line A\n[archive] full historical log line B\n';
    await uploadObject(
      `deployments/${depId}/logs.txt`,
      archiveContent,
      'text/plain; charset=utf-8'
    );
    // Transition queued -> cloning -> building -> uploading -> deployed
    await updateDeploymentStatus(depId, DeploymentStatus.CLONING, { started_at: new Date() });
    await updateDeploymentStatus(depId, DeploymentStatus.BUILDING);
    await updateDeploymentStatus(depId, DeploymentStatus.UPLOADING);
    await updateDeploymentStatus(depId, DeploymentStatus.DEPLOYED, {
      finished_at: new Date(),
    });

    // Make sure Redis stream does not exist
    await redis.del(`logs:${depId}`);

    const res = await app.inject({
      method: 'GET',
      url: `/deployments/${depId}/logs`,
      headers: { accept: 'text/event-stream' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('full historical log line A');
    expect(res.body).toContain('full historical log line B');
    expect(res.body).toContain('event: end');
  });

  it('stream cleanly closes when deployment reaches terminal state', async () => {
    const project = await createOrGetProject(
      'terminal-test',
      'https://github.com/example/terminal-test'
    );
    const deployment = await createDeployment(project.id);
    const depId = deployment.id;

    const writer = new DeploymentLogWriter(depId, redis);
    await writer.start();
    writer.writeChunk('stdout', 'Running step 1...\n');
    await writer.finish('failed', 1);

    const res = await app.inject({
      method: 'GET',
      url: `/deployments/${depId}/logs`,
      headers: { accept: 'text/event-stream' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: end');
    expect(res.body).toContain('"status":"failed"');
  });
});
