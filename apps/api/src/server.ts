import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance } from 'fastify';
import {
  checkDbHealth,
  checkRedisHealth,
  checkStorageHealth,
  createDeployment,
  createOrGetProject,
  getDeployment,
  listDeployments,
  logger,
  validateRepoUrl,
} from '@deployservice/shared';
import { getDeploymentQueue } from './queue.js';

export function buildServer(): FastifyInstance {
  const fastify = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  fastify.register(cors, {
    origin: '*',
  });

  fastify.register(rateLimit, {
    global: false, // Apply selectively
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

  // POST /deployments with per-IP rate limit
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
      const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as { repoUrl?: string };
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

        logger.info(
          { deploymentId: deployment.id, repoUrl: sanitizedUrl },
          'Deployment enqueued'
        );

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

  // GET /deployments/:id
  fastify.get('/deployments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

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

  // GET /deployments
  fastify.get('/deployments', async (request, reply) => {
    try {
      const list = await listDeployments(50);
      return reply.status(200).send(list);
    } catch (err: any) {
      logger.error({ err }, 'Failed to list deployments');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  return fastify;
}
