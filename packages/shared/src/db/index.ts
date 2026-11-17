import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getConfig } from '../config.js';
import * as schema from './schema.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDbPool(): pg.Pool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
    });
  }
  return pool;
}

export function getDb() {
  if (!dbInstance) {
    const pool = getDbPool();
    dbInstance = drizzle(pool, { schema });
  }
  return dbInstance;
}

export async function checkDbHealth(): Promise<boolean> {
  const p = getDbPool();
  try {
    const res = await p.query('SELECT 1 as healthy');
    return res.rows[0]?.healthy === 1;
  } catch (err) {
    return false;
  }
}

export async function closeDbPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    dbInstance = null;
  }
}
