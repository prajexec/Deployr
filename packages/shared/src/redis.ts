import { Redis } from 'ioredis';
import { getConfig } from './config.js';

export { Redis };
export type RedisClient = Redis;

let redisInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisInstance) {
    const config = getConfig();
    redisInstance = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    });

    redisInstance.on('error', (err) => {
      console.error('[redis] Connection error:', err.message);
    });
  }
  return redisInstance;
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const client = getRedisClient();
    const res = await client.ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}
