-- 0002_atomic_publish_and_rollback.sql: Add current_deployment_id to projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_deployment_id VARCHAR(64) REFERENCES deployments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_current_deployment_id ON projects(current_deployment_id);
