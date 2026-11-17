import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().default(3000),
  ROUTER_PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/deployservice'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().default('minioadmin'),
  S3_SECRET_ACCESS_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('deployments'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('true'),
  MAX_CONCURRENT_BUILDS: z.coerce.number().default(2),
  BUILD_TIMEOUT_MS: z.coerce.number().default(300000),
  MAX_LOG_BYTES: z.coerce.number().default(5242880),
  MAX_REPO_SIZE_MB: z.coerce.number().default(100),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

let cachedConfig: Config | null = null;

export function resetConfig(): void {
  cachedConfig = null;
}

export function getConfig(): Config {
  if (!cachedConfig) {
    const result = configSchema.safeParse(process.env);
    if (!result.success) {
      console.error('Invalid environment configuration:', result.error.format());
      throw new Error('Invalid environment configuration');
    }
    cachedConfig = result.data;
  }
  return cachedConfig;
}
