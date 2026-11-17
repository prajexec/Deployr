import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  checkDbHealth,
  checkRedisHealth,
  checkStorageHealth,
  createDeployment,
  createOrGetProject,
  DeploymentStatus,
  getConfig,
  getDeployment,
  getObject,
  getProject,
  getRedisClient,
  isTerminalStatus,
  isValidDeploymentId,
  isValidProjectId,
  listDeployments,
  logger,
  Redis,
  rollbackProjectDeployment,
  updateDeploymentStatus,
  validateRepoUrl,
} from '@deployservice/shared';
import { getDeploymentQueue } from './queue.js';
import {
  compareStreamIds,
  LogStreamManager,
  parseStreamFields,
  StreamLogEntry,
} from './log-stream-manager.js';

// Connection tracking for SSE caps
const globalSseSockets = new Set<any>();
const deploymentSseSockets = new Map<string, Set<any>>();

const MAX_GLOBAL_SSE = 500;
const MAX_PER_DEPLOYMENT_SSE = 20;
const SLOW_CLIENT_BUFFER_LIMIT = 512 * 1024; // 512 KB

export function validateApiKeyConfig(apiKey?: string): string {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('API failed to start: API_KEY is required and cannot be empty.');
  }
  const trimmed = apiKey.trim();
  if (trimmed === 'dev-api-key') {
    throw new Error(
      'API failed to start: Insecure API_KEY "dev-api-key" is prohibited. Set a strong random API_KEY.'
    );
  }
  if (
    (trimmed.startsWith('<') && trimmed.endsWith('>')) ||
    trimmed.includes('GENERATE_API_KEY') ||
    trimmed === '<GENERATE_API_KEY_WITH_OPENSSL_RAND_HEX_32>'
  ) {
    throw new Error(
      `API failed to start: API_KEY is still set to placeholder value "${trimmed}". Generate a key using openssl rand -hex 32.`
    );
  }
  return trimmed;
}

function requireApiKey(request: FastifyRequest, reply: FastifyReply, expectedKey: string): boolean {
  const headerKey = request.headers['x-api-key'];
  const authHeader = request.headers['authorization'];
  const bearerKey =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const provided = headerKey || bearerKey;

  if (!provided || provided !== expectedKey) {
    reply.status(401).send({ error: 'Unauthorized: valid API key required' });
    return false;
  }
  return true;
}

export function buildServer(): FastifyInstance {
  const config = getConfig();
  const apiKey = validateApiKeyConfig(config.API_KEY || process.env.API_KEY);
  const fastify = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  const allowedOrigins = [config.FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'];

  fastify.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (e.g. curl) or matching allowed origins
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'Last-Event-ID'],
  });

  fastify.register(rateLimit, {
    global: false, // Apply selectively
  });

  // Dedicated Redis connection for LogStreamManager (XREAD BLOCK)
  const dedicatedRedis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  const logStreamManager = new LogStreamManager(dedicatedRedis);
  logStreamManager.start();

  fastify.addHook('onClose', async () => {
    await logStreamManager.stop();
  });

  // Healthcheck endpoint
  fastify.get('/healthz', async (_req, reply) => {
    const [pgOk, redisOk, storageOk] = await Promise.all([
      checkDbHealth().catch(() => false),
      checkRedisHealth().catch(() => false),
      checkStorageHealth().catch(() => false),
    ]);

    const isHealthy = pgOk && redisOk && storageOk;

    const payload = {
      status: isHealthy ? 'ok' : 'degraded',
      services: {
        postgres: pgOk ? 'healthy' : 'unhealthy',
        redis: redisOk ? 'healthy' : 'unhealthy',
        storage: storageOk ? 'healthy' : 'unhealthy',
      },
      timestamp: new Date().toISOString(),
    };

    return reply.status(isHealthy ? 200 : 503).send(payload);
  });

  // POST /deployments (Requires API Key & per-IP rate limit)
  fastify.post(
    '/deployments',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      if (!requireApiKey(request, reply, apiKey)) {
        return;
      }

      const contentType = request.headers['content-type'];
      if (!contentType || !contentType.includes('application/json')) {
        return reply.status(415).send({
          error: 'Unsupported Media Type: Content-Type must be application/json',
        });
      }

      const body = (
        typeof request.body === 'object' && request.body !== null ? request.body : {}
      ) as { repoUrl?: string };
      const repoUrl = body.repoUrl;

      const validation = validateRepoUrl(repoUrl || '');
      if (!validation.valid || !validation.owner || !validation.repo) {
        return reply.status(400).send({
          error: validation.error || 'Invalid repository URL',
        });
      }

      try {
        const projectName = `${validation.owner}/${validation.repo}`;
        const sanitizedUrl = `https://github.com/${validation.owner}/${validation.repo}`;

        const project = await createOrGetProject(projectName, sanitizedUrl);
        const deployment = await createDeployment(project.id);

        const queue = getDeploymentQueue();
        await queue.add('build', {
          deploymentId: deployment.id,
          repoUrl: sanitizedUrl,
        });

        logger.info({ deploymentId: deployment.id, repoUrl: sanitizedUrl }, 'Deployment enqueued');

        return reply.status(201).send({
          id: deployment.id,
          status: deployment.status,
          projectId: project.id,
          repoUrl: sanitizedUrl,
        });
      } catch (err: any) {
        logger.error({ err }, 'Failed to create deployment');
        return reply.status(500).send({
          error: 'Internal server error while creating deployment',
        });
      }
    }
  );

  // GET /deployments (List - Requires API Key)
  fastify.get('/deployments', async (request, reply) => {
    if (!requireApiKey(request, reply, apiKey)) {
      return;
    }

    try {
      const list = await listDeployments(50);
      return reply.status(200).send(list);
    } catch (err: any) {
      logger.error({ err }, 'Failed to list deployments');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /deployments/:id (Capability URL - Validates 128-bit ID format)
  fastify.get('/deployments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!isValidDeploymentId(id)) {
      return reply.status(400).send({
        error:
          "Invalid deployment ID format. Expected 'd-' followed by 32 lowercase hex characters.",
      });
    }

    try {
      const deployment = await getDeployment(id);
      if (!deployment) {
        return reply.status(404).send({ error: `Deployment '${id}' not found` });
      }

      return reply.status(200).send(deployment);
    } catch (err: any) {
      logger.error({ err, id }, 'Failed to fetch deployment');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /deployments/:id/cancel (Requires API Key)
  fastify.post('/deployments/:id/cancel', async (request, reply) => {
    if (!requireApiKey(request, reply, apiKey)) {
      return;
    }

    const { id } = request.params as { id: string };

    if (!isValidDeploymentId(id)) {
      return reply.status(400).send({
        error:
          "Invalid deployment ID format. Expected 'd-' followed by 32 lowercase hex characters.",
      });
    }

    try {
      const deployment = await getDeployment(id);
      if (!deployment) {
        return reply.status(404).send({ error: `Deployment '${id}' not found` });
      }

      // If already in a terminal state, reject with 409 Conflict
      if (isTerminalStatus(deployment.status as any)) {
        return reply.status(409).send({
          error: `Cannot cancel deployment '${id}': already in terminal state '${deployment.status}'`,
          status: deployment.status,
        });
      }

      // If queued, remove from BullMQ
      if (deployment.status === DeploymentStatus.QUEUED) {
        try {
          const queue = getDeploymentQueue();
          const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
          for (const job of jobs) {
            if (job.data?.deploymentId === id) {
              await job.remove();
            }
          }
        } catch (queueErr: any) {
          logger.warn({ id, err: queueErr.message }, 'Failed removing queued job from BullMQ');
        }
      } else {
        // Active build (cloning, building, uploading): publish cancel message to worker
        try {
          const redis = getRedisClient();
          await redis.publish('deployservice:cancel', id);
        } catch (pubErr: any) {
          logger.warn({ id, err: pubErr.message }, 'Failed publishing cancellation to Redis');
        }
      }

      // Transition deployment status in Postgres
      const updated = await updateDeploymentStatus(id, DeploymentStatus.CANCELLED, {
        error_message: 'Deployment cancelled by user',
        finished_at: new Date(),
      });

      // Emit terminal event to Redis stream
      try {
        const redis = getRedisClient();
        await redis.xadd(
          `deployservice:logs:${id}`,
          '*',
          'event',
          'end',
          'data',
          JSON.stringify({ status: 'cancelled', exitCode: 130 }),
          'stream',
          'system'
        );
      } catch {
        // best-effort
      }

      logger.info({ id }, 'Deployment successfully cancelled');
      return reply.status(200).send({
        id: updated.id,
        status: updated.status,
      });
    } catch (err: any) {
      logger.error({ id, err: err.message }, 'Failed to cancel deployment');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /projects/:id/rollback (Requires API Key)
  fastify.post('/projects/:id/rollback', async (request, reply) => {
    if (!requireApiKey(request, reply, apiKey)) {
      return;
    }

    const { id } = request.params as { id: string };

    if (!isValidProjectId(id)) {
      return reply.status(400).send({
        error:
          "Invalid project ID format. Expected 'prj_' followed by 12 lowercase hex characters.",
      });
    }

    const body = (
      typeof request.body === 'object' && request.body !== null ? request.body : {}
    ) as { targetDeploymentId?: string };

    const targetDeploymentId = body.targetDeploymentId;
    if (targetDeploymentId && !isValidDeploymentId(targetDeploymentId)) {
      return reply.status(400).send({
        error:
          "Invalid target deployment ID format. Expected 'd-' followed by 32 lowercase hex characters.",
      });
    }

    try {
      const result = await rollbackProjectDeployment(id, targetDeploymentId);
      logger.info(
        { projectId: id, currentDeploymentId: result.deployment.id },
        'Project deployment rolled back successfully'
      );

      return reply.status(200).send({
        success: true,
        projectId: result.project.id,
        currentDeploymentId: result.deployment.id,
        commitSha: result.deployment.commit_sha,
      });
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      return reply.status(400).send({ error: err.message });
    }
  });

  // GET /projects/:id (Requires API Key)
  fastify.get('/projects/:id', async (request, reply) => {
    if (!requireApiKey(request, reply, apiKey)) {
      return;
    }

    const { id } = request.params as { id: string };

    if (!isValidProjectId(id)) {
      return reply.status(400).send({
        error:
          "Invalid project ID format. Expected 'prj_' followed by 12 lowercase hex characters.",
      });
    }

    try {
      const project = await getProject(id);
      if (!project) {
        return reply.status(404).send({ error: `Project '${id}' not found` });
      }

      return reply.status(200).send(project);
    } catch (err: any) {
      logger.error({ err, id }, 'Failed to fetch project');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /deployments/:id/logs (Capability URL - SSE Live Streaming & Raw Logs)
  fastify.get('/deployments/:id/logs', async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!isValidDeploymentId(id)) {
      return reply.status(400).send({
        error:
          "Invalid deployment ID format. Expected 'd-' followed by 32 lowercase hex characters.",
      });
    }

    const deployment = await getDeployment(id);
    if (!deployment) {
      return reply.status(404).send({ error: `Deployment '${id}' not found` });
    }

    const acceptHeader = request.headers['accept'] || '';
    const query = request.query as Record<string, string | undefined>;
    const wantsRaw = acceptHeader.includes('text/plain') || query.format === 'raw';

    // Handler for raw/archived log text
    if (wantsRaw) {
      try {
        const archive = await getObject(`deployments/${id}/logs.txt`);
        return reply
          .type('text/plain; charset=utf-8')
          .header('Cache-Control', 'public, max-age=60')
          .send(archive.Body);
      } catch {
        // If archive is not in MinIO, fallback to Redis stream or unavailable notice
        const redis = getRedisClient();
        const entries: any = await redis.xrange(`logs:${id}`, '-', '+');
        if (entries && entries.length > 0) {
          let text = '';
          for (const [, fields] of entries) {
            const entry = parseStreamFields('', fields);
            if (entry.data) text += entry.data;
          }
          return reply.type('text/plain; charset=utf-8').send(text);
        }
        return reply.type('text/plain; charset=utf-8').send('[archive unavailable]\n');
      }
    }

    // SSE Connection Caps Check
    if (globalSseSockets.size >= MAX_GLOBAL_SSE) {
      return reply.status(429).send({ error: 'Global SSE connection limit reached' });
    }

    let depSockets = deploymentSseSockets.get(id);
    if (!depSockets) {
      depSockets = new Set();
      deploymentSseSockets.set(id, depSockets);
    }

    if (depSockets.size >= MAX_PER_DEPLOYMENT_SSE) {
      return reply.status(429).send({ error: 'Per-deployment SSE connection limit reached' });
    }

    // CORS & Transport Headers on raw response
    const origin = request.headers.origin;
    const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : null;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
      'Access-Control-Allow-Headers': 'Last-Event-ID, Content-Type, Authorization, x-api-key',
      Vary: 'Origin',
    });

    const socket = reply.raw;
    globalSseSockets.add(socket);
    depSockets.add(socket);

    let unsubscribe: (() => void) | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let isTerminated = false;

    const cleanup = () => {
      if (isTerminated) return;
      isTerminated = true;

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }

      globalSseSockets.delete(socket);
      const s = deploymentSseSockets.get(id);
      if (s) {
        s.delete(socket);
        if (s.size === 0) deploymentSseSockets.delete(id);
      }
    };

    request.raw.on('close', cleanup);

    // 15-second Heartbeat & Defensive Postgres Status Check
    heartbeatTimer = setInterval(async () => {
      if (socket.destroyed || isTerminated) {
        cleanup();
        return;
      }

      // Slow client backpressure check
      if (socket.writableLength > SLOW_CLIENT_BUFFER_LIMIT) {
        logger.warn({ id }, 'Terminating slow SSE client exceeding buffer limit');
        socket.destroy();
        cleanup();
        return;
      }

      try {
        socket.write(': ping\n\n');
      } catch {
        cleanup();
        return;
      }

      // Check Postgres status on heartbeat
      try {
        const current = await getDeployment(id);
        const isTerminal =
          current?.status === 'deployed' ||
          current?.status === 'failed' ||
          current?.status === 'timed_out' ||
          current?.status === 'cancelled';

        if (isTerminal) {
          // If terminal, emit end event and close
          socket.write(`event: end\ndata: ${JSON.stringify({ status: current?.status })}\n\n`);
          socket.end();
          cleanup();
        }
      } catch {
        // ignore
      }
    }, 15000);

    const redis = getRedisClient();
    const lastEventId = (request.headers['last-event-id'] as string) || query.lastEventId || '0-0';

    let maxReplayedId = lastEventId;

    // Start-marker check for trimmed stream notice
    try {
      const earliest: any = await redis.xrange(`logs:${id}`, '-', '+', 'COUNT', 1);
      if (lastEventId === '0-0' && earliest && earliest.length > 0 && earliest[0][1]) {
        const firstEntry = parseStreamFields(earliest[0][0], earliest[0][1]);
        if (firstEntry.name !== 'start') {
          socket.write(
            `event: log\ndata: ${JSON.stringify({
              stream: 'system',
              data: '[Notice: live log buffer trimmed early lines; complete log will be available in archive upon build completion]\n',
            })}\n\n`
          );
        }
      }
    } catch {
      // ignore
    }

    // Historical Replay via XRANGE
    try {
      const xrangeQuery = lastEventId === '0-0' ? '-' : `(${lastEventId}`;
      const historical: any = await redis.xrange(`logs:${id}`, xrangeQuery, '+');

      if (historical && Array.isArray(historical)) {
        for (const [entryId, fields] of historical) {
          if (compareStreamIds(entryId, maxReplayedId) > 0) {
            maxReplayedId = entryId;
          }

          const entry = parseStreamFields(entryId, fields);
          if (entry.type === 'marker' && entry.name === 'end') {
            socket.write(
              `id: ${entryId}\nevent: end\ndata: ${JSON.stringify({
                status: entry.status,
                exitCode: entry.exitCode,
              })}\n\n`
            );
            socket.end();
            cleanup();
            return;
          }

          if (entry.data) {
            socket.write(
              `id: ${entryId}\nevent: log\ndata: ${JSON.stringify({
                ts: entry.ts,
                stream: entry.stream || 'stdout',
                data: entry.data,
                cont: entry.cont,
              })}\n\n`
            );
          }
        }
      }
    } catch (err: any) {
      logger.warn({ id, err: err.message }, 'Failed during log catchup XRANGE query');
    }

    // Check if deployment already terminal and stream had zero entries (e.g. historical archive replay)
    const currentDep = await getDeployment(id);
    const isAlreadyFinished =
      currentDep?.status === 'deployed' ||
      currentDep?.status === 'failed' ||
      currentDep?.status === 'timed_out';

    if (isAlreadyFinished && maxReplayedId === lastEventId) {
      // Replay from MinIO archive if available
      try {
        const archive = await getObject(`deployments/${id}/logs.txt`);
        let bodyStr = '';
        if (archive.Body) {
          if (typeof (archive.Body as any).transformToString === 'function') {
            bodyStr = await (archive.Body as any).transformToString();
          } else if (Buffer.isBuffer(archive.Body)) {
            bodyStr = archive.Body.toString('utf-8');
          } else {
            bodyStr = String(archive.Body);
          }
        }
        socket.write(
          `event: log\ndata: ${JSON.stringify({
            stream: 'stdout',
            data: bodyStr || '[archive unavailable]\n',
          })}\n\n`
        );
      } catch {
        socket.write(
          `event: log\ndata: ${JSON.stringify({
            stream: 'system',
            data: '[archive unavailable]\n',
          })}\n\n`
        );
      }
      socket.write(`event: end\ndata: ${JSON.stringify({ status: currentDep?.status })}\n\n`);
      socket.end();
      cleanup();
      return;
    }

    // Subscribe to live updates via LogStreamManager (XREAD BLOCK)
    unsubscribe = logStreamManager.subscribe(
      id,
      (entry: StreamLogEntry) => {
        if (socket.destroyed || isTerminated) {
          cleanup();
          return;
        }

        // Deduplication: only emit entries strictly newer than maxReplayedId
        if (compareStreamIds(entry.id, maxReplayedId) <= 0) {
          return;
        }
        maxReplayedId = entry.id;

        // Slow client buffer check
        if (socket.writableLength > SLOW_CLIENT_BUFFER_LIMIT) {
          logger.warn({ id }, 'Terminating slow SSE client exceeding buffer limit');
          socket.destroy();
          cleanup();
          return;
        }

        if (entry.type === 'marker' && entry.name === 'end') {
          socket.write(
            `id: ${entry.id}\nevent: end\ndata: ${JSON.stringify({
              status: entry.status,
              exitCode: entry.exitCode,
            })}\n\n`
          );
          socket.end();
          cleanup();
          return;
        }

        if (entry.data) {
          socket.write(
            `id: ${entry.id}\nevent: log\ndata: ${JSON.stringify({
              ts: entry.ts,
              stream: entry.stream || 'stdout',
              data: entry.data,
              cont: entry.cont,
            })}\n\n`
          );
        }
      },
      maxReplayedId
    );
  });

  return fastify;
}
