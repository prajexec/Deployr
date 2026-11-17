import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { runMigrations } from './migrate.js';

describe('Database Migrator Concurrency', () => {
  it('prevents duplicate migration runs when executed concurrently using advisory locks', async () => {
    // Simulated database state
    let lockHolder: string | null = null;
    const lockWaiters: Array<() => void> = [];
    const appliedMigrations = new Set<string>();
    const executedSqlStatements: string[] = [];

    // Factory to create a simulated pg.Pool with 2 concurrent clients
    const createSimulatedClient = (clientId: string) => {
      let inTransaction = false;

      return {
        query: async (queryText: string, params?: any[]) => {
          const sql = queryText.trim();

          if (sql === 'BEGIN') {
            inTransaction = true;
            return { rows: [] };
          }

          if (sql === 'COMMIT') {
            inTransaction = false;
            if (lockHolder === clientId) {
              lockHolder = null;
              const nextWaiter = lockWaiters.shift();
              if (nextWaiter) nextWaiter();
            }
            return { rows: [] };
          }

          if (sql === 'ROLLBACK') {
            inTransaction = false;
            if (lockHolder === clientId) {
              lockHolder = null;
              const nextWaiter = lockWaiters.shift();
              if (nextWaiter) nextWaiter();
            }
            return { rows: [] };
          }

          // Advisory transaction lock
          if (sql.includes('pg_advisory_xact_lock')) {
            if (lockHolder !== null && lockHolder !== clientId) {
              // Wait for previous lock holder to release (on COMMIT/ROLLBACK)
              await new Promise<void>((resolve) => {
                lockWaiters.push(resolve);
              });
            }
            lockHolder = clientId;
            return { rows: [] };
          }

          // Schema migrations table creation
          if (sql.includes('CREATE TABLE IF NOT EXISTS __schema_migrations')) {
            return { rows: [] };
          }

          // Query applied migrations - occurs AFTER advisory lock is held
          if (sql.includes('SELECT name FROM __schema_migrations')) {
            return {
              rows: Array.from(appliedMigrations).map((name) => ({ name })),
            };
          }

          // Record migration insertion
          if (sql.includes('INSERT INTO __schema_migrations')) {
            const migrationName = params?.[0];
            if (migrationName) {
              appliedMigrations.add(migrationName);
            }
            return { rows: [] };
          }

          // DDL statement from migration file
          executedSqlStatements.push(`[${clientId}] ${sql}`);
          return { rows: [] };
        },
        release: () => {},
      };
    };

    let clientCounter = 0;
    const mockPool = {
      connect: async () => {
        clientCounter++;
        return createSimulatedClient(`client_${clientCounter}`) as unknown as pg.PoolClient;
      },
    } as unknown as pg.Pool;

    // Run two migrators simultaneously
    await Promise.all([runMigrations(mockPool), runMigrations(mockPool)]);

    // Migrations must only be applied once across both runners
    expect(appliedMigrations.has('0001_initial.sql')).toBe(true);
    expect(appliedMigrations.has('0002_atomic_publish_and_rollback.sql')).toBe(true);
    expect(appliedMigrations.size).toBe(2);

    // The actual migration DDL should only have been executed once, by whichever client acquired the lock first
    const ddlStatements = executedSqlStatements.filter((stmt) =>
      stmt.includes('CREATE TABLE IF NOT EXISTS projects')
    );
    expect(ddlStatements.length).toBe(1);
  });
});
