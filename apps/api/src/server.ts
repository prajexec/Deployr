import cors from '@fastify/cors';
import Fastify, { FastifyInstance } from 'fastify';
import {
  checkDbHealth,
  checkRedisHealth,
  checkStorageHealth,
  logger,
} from '@deployservice/shared';

export function buildServer(): FastifyInstance {
  const fastify = Fastify({
    logger: false, // We use shared pino logger
    disableRequestLogging: true,
  });

  fastify.register(cors, {
    origin: '*',
  });

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

    if (isHealthy) {
      return reply.status(200).send(payload);
    } else {
      return reply.status(503).send(payload);
    }
  });

  return fastify;
}
