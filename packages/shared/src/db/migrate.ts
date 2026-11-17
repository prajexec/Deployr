import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { getDbPool } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(customPool?: pg.Pool): Promise<void> {
  const pool = customPool || getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Advisory lock to ensure single migration runner across instances
    await client.query('SELECT pg_advisory_xact_lock(987654321)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS __schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Look for migrations in dist/db/migrations or src/db/migrations or alongside this file
    const possibleDirs = [
      path.join(__dirname, 'migrations'),
      path.join(__dirname, '..', '..', 'src', 'db', 'migrations'),
      path.join(__dirname, '..', 'src', 'db', 'migrations'),
      path.join(__dirname, '..', 'db', 'migrations'),
    ];

    const migrationsDir = possibleDirs.find((d) => fs.existsSync(d));
    if (!migrationsDir) {
      throw new Error(`Migrations directory not found in ${possibleDirs.join(', ')}`);
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    // Query applied migrations AFTER obtaining the advisory lock.
    // If a concurrent runner completed first, its committed records are visible here.
    const { rows: appliedRows } = await client.query<{ name: string }>(
      'SELECT name FROM __schema_migrations'
    );
    const appliedSet = new Set(appliedRows.map((r) => r.name));

    for (const file of files) {
      if (!appliedSet.has(file)) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');
        await client.query(sql);
        await client.query('INSERT INTO __schema_migrations (name) VALUES ($1)', [file]);
        console.log(`[migrate] Applied migration: ${file}`);
      }
    }

    await client.query('COMMIT');
    console.log('[migrate] All migrations up to date.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[migrate] Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Allow standalone execution: `node dist/db/migrate.js`
if (process.argv[1] === __filename) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
