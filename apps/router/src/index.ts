/**
 * PHASE 1 PLACEHOLDER: Wildcard Router Entrypoint
 *
 * In Phase 1, the router container runs a minimal HTTP listener for docker-compose healthchecks.
 * Real wildcard host parsing (`<id>.localhost:8080`), MinIO object streaming, SPA fallback,
 * and LRU caching will be implemented in Phase 2.
 */
import Fastify from 'fastify';
import { getConfig, logger } from '@deployservice/shared';

const config = getConfig();
const app = Fastify({ logger: false });

// Minimal healthcheck placeholder for Phase 1
app.get('/healthz', async (_req, reply) => {
  return reply.send({ status: 'ok', service: 'router', phase: 'phase-1-placeholder' });
});

try {
  await app.listen({ port: config.ROUTER_PORT, host: '0.0.0.0' });
  logger.info(`Router listening on port ${config.ROUTER_PORT} (Phase 1 placeholder)`);
} catch (err) {
  logger.fatal({ err }, 'Failed to start router');
  process.exit(1);
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
