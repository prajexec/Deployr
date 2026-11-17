import { describe, expect, it } from 'vitest';
import { createSanitizedEnv } from './builder.js';

describe('Build Environment Sanitization', () => {
  it('does NOT inherit sensitive variables from process.env', () => {
    // Inject mock sensitive secrets into current process.env
    process.env.DATABASE_URL = 'postgresql://postgres:secretpassword@localhost:5432/db';
    process.env.POSTGRES_PASSWORD = 'supersecretpassword';
    process.env.S3_SECRET_ACCESS_KEY = 'minioadminsecret';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.API_KEY = 'secret-api-key';

    const tempDir = '/tmp/deploy-test-workdir';
    const env = createSanitizedEnv(tempDir);

    // Explicitly verify secrets are NOT leaked to the build subprocess
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
    expect(env.S3_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.API_KEY).toBeUndefined();

    // Verify allowed / required keys
    expect(env.HOME).toBe(tempDir);
    expect(env.CI).toBe('true');
    expect(env.NODE_ENV).toBe('production');
    expect(env.TMPDIR).toBe(tempDir);
    expect(env.PATH).toBeDefined();
  });
});
