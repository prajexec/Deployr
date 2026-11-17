export const DeploymentStatus = {
  QUEUED: 'queued',
  CLONING: 'cloning',
  BUILDING: 'building',
  UPLOADING: 'uploading',
  DEPLOYED: 'deployed',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
} as const;

export type DeploymentStatusType = (typeof DeploymentStatus)[keyof typeof DeploymentStatus];

export const TERMINAL_STATUSES: readonly DeploymentStatusType[] = [
  DeploymentStatus.DEPLOYED,
  DeploymentStatus.FAILED,
  DeploymentStatus.TIMED_OUT,
  DeploymentStatus.CANCELLED,
] as const;

export function isTerminalStatus(status: DeploymentStatusType): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface Project {
  id: string;
  name: string;
  repo_url: string;
  created_at: Date;
}

export interface Deployment {
  id: string;
  project_id: string;
  status: DeploymentStatusType;
  commit_sha: string | null;
  output_dir: string | null;
  error_message: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface LogMessage {
  id?: string;
  seq?: number;
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}
