import { pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

export const projects = pgTable('projects', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  repo_url: text('repo_url').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const deployments = pgTable('deployments', {
  id: varchar('id', { length: 64 }).primaryKey(),
  project_id: varchar('project_id', { length: 64 })
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 32 }).notNull().default('queued'),
  commit_sha: varchar('commit_sha', { length: 64 }),
  output_dir: text('output_dir'),
  error_message: text('error_message'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  started_at: timestamp('started_at', { withTimezone: true }),
  finished_at: timestamp('finished_at', { withTimezone: true }),
});

export type ProjectRecord = typeof projects.$inferSelect;
export type NewProjectRecord = typeof projects.$inferInsert;
export type DeploymentRecord = typeof deployments.$inferSelect;
export type NewDeploymentRecord = typeof deployments.$inferInsert;
