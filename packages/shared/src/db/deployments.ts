import crypto from 'node:crypto';
import { and, desc, eq, inArray, lt, ne } from 'drizzle-orm';
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

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const db = getDb();
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0] || null;
}

export async function setProjectCurrentDeployment(
  projectId: string,
  deploymentId: string
): Promise<ProjectRecord> {
  const db = getDb();
  const [updated] = await db
    .update(projects)
    .set({
      current_deployment_id: deploymentId,
    })
    .where(eq(projects.id, projectId))
    .returning();

  if (!updated) {
    throw new Error(`Project with id '${projectId}' not found`);
  }
  return updated;
}

export async function getProjectDeployments(projectId: string): Promise<DeploymentRecord[]> {
  const db = getDb();
  return await db
    .select()
    .from(deployments)
    .where(eq(deployments.project_id, projectId))
    .orderBy(desc(deployments.created_at));
}

export async function rollbackProjectDeployment(
  projectId: string,
  targetDeploymentId?: string
): Promise<{ project: ProjectRecord; deployment: DeploymentRecord }> {
  const db = getDb();
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project with id '${projectId}' not found`);
  }

  let targetDeployment: DeploymentRecord | null = null;

  if (targetDeploymentId) {
    targetDeployment = await getDeployment(targetDeploymentId);
    if (!targetDeployment || targetDeployment.project_id !== projectId) {
      throw new Error(
        `Target deployment '${targetDeploymentId}' does not belong to project '${projectId}'`
      );
    }
    if (targetDeployment.status !== DeploymentStatus.DEPLOYED) {
      throw new Error(
        `Target deployment '${targetDeploymentId}' is not in deployed status (current: ${targetDeployment.status})`
      );
    }
  } else {
    // Find the latest successfully deployed release other than the current one
    const eligibleDeployments = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.project_id, projectId),
          eq(deployments.status, DeploymentStatus.DEPLOYED),
          project.current_deployment_id
            ? ne(deployments.id, project.current_deployment_id)
            : undefined
        )
      )
      .orderBy(desc(deployments.finished_at), desc(deployments.created_at))
      .limit(1);

    if (eligibleDeployments.length === 0) {
      throw new Error(`No previous successful deployment found for project '${projectId}'`);
    }
    targetDeployment = eligibleDeployments[0];
  }

  const updatedProject = await setProjectCurrentDeployment(projectId, targetDeployment.id);
  return { project: updatedProject, deployment: targetDeployment };
}

export async function getStuckDeployments(maxAgeMs = 10 * 60 * 1000): Promise<DeploymentRecord[]> {
  const db = getDb();

  const statusCondition = inArray(deployments.status, [
    DeploymentStatus.CLONING,
    DeploymentStatus.BUILDING,
    DeploymentStatus.UPLOADING,
  ]);

  if (maxAgeMs <= 0) {
    return await db.select().from(deployments).where(statusCondition);
  }

  const cutoff = new Date(Date.now() - maxAgeMs);
  return await db
    .select()
    .from(deployments)
    .where(and(statusCondition, lt(deployments.created_at, cutoff)));
}
