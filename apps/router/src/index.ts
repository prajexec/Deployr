import Fastify from 'fastify';
import { getConfig, logger } from '@deployservice/shared';

const config = getConfig();
const app = Fastify({ logger: false });

app.get('/healthz', async (_req, reply) => {
  return reply.send({ status: 'ok', service: 'router' });
});

try {
  await app.listen({ port: config.ROUTER_PORT, host: '0.0.0.0' });
  logger.info(`Router listening on port ${config.ROUTER_PORT}`);
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
