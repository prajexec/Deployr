import { DeploymentStatus, DeploymentStatusType, isTerminalStatus } from './types.js';

export class IllegalStateTransitionError extends Error {
  constructor(
    public readonly from: DeploymentStatusType,
    public readonly to: DeploymentStatusType
  ) {
    super(`Illegal deployment status transition from '${from}' to '${to}'`);
    this.name = 'IllegalStateTransitionError';
  }
}

const VALID_TRANSITIONS: Record<DeploymentStatusType, readonly DeploymentStatusType[]> = {
  [DeploymentStatus.QUEUED]: [
    DeploymentStatus.CLONING,
    DeploymentStatus.FAILED,
    DeploymentStatus.CANCELLED,
  ],
  [DeploymentStatus.CLONING]: [
    DeploymentStatus.BUILDING,
    DeploymentStatus.FAILED,
    DeploymentStatus.TIMED_OUT,
    DeploymentStatus.CANCELLED,
  ],
  [DeploymentStatus.BUILDING]: [
    DeploymentStatus.UPLOADING,
    DeploymentStatus.FAILED,
    DeploymentStatus.TIMED_OUT,
    DeploymentStatus.CANCELLED,
  ],
  [DeploymentStatus.UPLOADING]: [
    DeploymentStatus.DEPLOYED,
    DeploymentStatus.FAILED,
    DeploymentStatus.TIMED_OUT,
    DeploymentStatus.CANCELLED,
  ],
  // Terminal states cannot transition to anything
  [DeploymentStatus.DEPLOYED]: [],
  [DeploymentStatus.FAILED]: [],
  [DeploymentStatus.TIMED_OUT]: [],
  [DeploymentStatus.CANCELLED]: [],
};

/**
 * Checks if transitioning from currentStatus to nextStatus is valid.
 */
export function canTransition(
  currentStatus: DeploymentStatusType,
  nextStatus: DeploymentStatusType
): boolean {
  if (currentStatus === nextStatus) {
    return false;
  }
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed) {
    return false;
  }
  return allowed.includes(nextStatus);
}

/**
 * Single function to enforce transitions; throws IllegalStateTransitionError if illegal.
 */
export function assertTransition(
  currentStatus: DeploymentStatusType,
  nextStatus: DeploymentStatusType
): void {
  if (!canTransition(currentStatus, nextStatus)) {
    throw new IllegalStateTransitionError(currentStatus, nextStatus);
  }
}
