import pino from 'pino';
import { getConfig } from './config.js';

const config = getConfig();

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createDeploymentLogger(deploymentId: string, extra: Record<string, unknown> = {}) {
  return logger.child({
    deploymentId,
    ...extra,
  });
}
