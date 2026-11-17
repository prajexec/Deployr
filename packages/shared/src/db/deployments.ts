import crypto from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { assertTransition } from '../state-machine.js';
import { DeploymentStatus, DeploymentStatusType } from '../types.js';
import { getDb } from './index.js';
import { DeploymentRecord, deployments, ProjectRecord, projects } from './schema.js';

export function generateDeploymentId(): string {
  // Generates 34 chars: 'd-' + 32 lowercase hex characters (128-bit cryptographically secure entropy)
  return `d-${crypto.randomBytes(16).toString('hex')}`;
}

export function generateProjectId(): string {
  return `prj_${crypto.randomBytes(6).toString('hex')}`;
}

export async function createOrGetProject(name: string, repoUrl: string): Promise<ProjectRecord> {
  const db = getDb();
  const existing = await db.select().from(projects).where(eq(projects.repo_url, repoUrl)).limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const id = generateProjectId();
  const [created] = await db
    .insert(projects)
    .values({
      id,
      name,
      repo_url: repoUrl,
    })
    .returning();

  return created;
}

export async function createDeployment(
  projectId: string,
  customId?: string
): Promise<DeploymentRecord> {
  const db = getDb();
  const id = customId || generateDeploymentId();

  const [created] = await db
    .insert(deployments)
    .values({
      id,
      project_id: projectId,
      status: DeploymentStatus.QUEUED,
    })
    .returning();

  return created;
}

export async function getDeployment(id: string): Promise<DeploymentRecord | null> {
  const db = getDb();
  const rows = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);

  return rows[0] || null;
}

export async function listDeployments(limit = 50): Promise<DeploymentRecord[]> {
  const db = getDb();
  return await db.select().from(deployments).orderBy(desc(deployments.created_at)).limit(limit);
}

export async function updateDeploymentStatus(
  id: string,
  nextStatus: DeploymentStatusType,
  updates: Partial<Omit<DeploymentRecord, 'id' | 'status'>> = {}
): Promise<DeploymentRecord> {
  const db = getDb();
  const current = await getDeployment(id);
  if (!current) {
    throw new Error(`Deployment with id '${id}' not found`);
  }

  // Enforce transition in the single centralized state machine function
  assertTransition(current.status as DeploymentStatusType, nextStatus);

  const [updated] = await db
    .update(deployments)
    .set({
      status: nextStatus,
      ...updates,
    })
    .where(eq(deployments.id, id))
    .returning();

  return updated;
}
