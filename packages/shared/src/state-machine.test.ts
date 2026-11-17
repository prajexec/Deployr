import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, IllegalStateTransitionError } from './state-machine.js';
import { DeploymentStatus } from './types.js';

describe('Deployment Status State Machine', () => {
  it('allows valid progressive transitions', () => {
    expect(canTransition(DeploymentStatus.QUEUED, DeploymentStatus.CLONING)).toBe(true);
    expect(canTransition(DeploymentStatus.CLONING, DeploymentStatus.BUILDING)).toBe(true);
    expect(canTransition(DeploymentStatus.BUILDING, DeploymentStatus.UPLOADING)).toBe(true);
    expect(canTransition(DeploymentStatus.UPLOADING, DeploymentStatus.DEPLOYED)).toBe(true);
  });

  it('allows valid transitions to terminal failure states', () => {
    // From queued
    expect(canTransition(DeploymentStatus.QUEUED, DeploymentStatus.FAILED)).toBe(true);
    expect(canTransition(DeploymentStatus.QUEUED, DeploymentStatus.CANCELLED)).toBe(true);

    // From cloning
    expect(canTransition(DeploymentStatus.CLONING, DeploymentStatus.FAILED)).toBe(true);
    expect(canTransition(DeploymentStatus.CLONING, DeploymentStatus.TIMED_OUT)).toBe(true);
    expect(canTransition(DeploymentStatus.CLONING, DeploymentStatus.CANCELLED)).toBe(true);

    // From building
    expect(canTransition(DeploymentStatus.BUILDING, DeploymentStatus.FAILED)).toBe(true);
    expect(canTransition(DeploymentStatus.BUILDING, DeploymentStatus.TIMED_OUT)).toBe(true);
    expect(canTransition(DeploymentStatus.BUILDING, DeploymentStatus.CANCELLED)).toBe(true);

    // From uploading
    expect(canTransition(DeploymentStatus.UPLOADING, DeploymentStatus.FAILED)).toBe(true);
    expect(canTransition(DeploymentStatus.UPLOADING, DeploymentStatus.TIMED_OUT)).toBe(true);
    expect(canTransition(DeploymentStatus.UPLOADING, DeploymentStatus.CANCELLED)).toBe(true);
  });

  it('rejects invalid or backwards transitions', () => {
    expect(canTransition(DeploymentStatus.QUEUED, DeploymentStatus.BUILDING)).toBe(false);
    expect(canTransition(DeploymentStatus.QUEUED, DeploymentStatus.DEPLOYED)).toBe(false);
    expect(canTransition(DeploymentStatus.BUILDING, DeploymentStatus.CLONING)).toBe(false);
    expect(canTransition(DeploymentStatus.DEPLOYED, DeploymentStatus.BUILDING)).toBe(false);
    expect(canTransition(DeploymentStatus.FAILED, DeploymentStatus.QUEUED)).toBe(false);
  });

  it('rejects self-transitions', () => {
    expect(canTransition(DeploymentStatus.QUEUED, DeploymentStatus.QUEUED)).toBe(false);
    expect(canTransition(DeploymentStatus.BUILDING, DeploymentStatus.BUILDING)).toBe(false);
    expect(canTransition(DeploymentStatus.DEPLOYED, DeploymentStatus.DEPLOYED)).toBe(false);
  });

  it('disallows transitions from any terminal state', () => {
    const terminalStates = [
      DeploymentStatus.DEPLOYED,
      DeploymentStatus.FAILED,
      DeploymentStatus.TIMED_OUT,
      DeploymentStatus.CANCELLED,
    ];

    const allStates = Object.values(DeploymentStatus);

    for (const term of terminalStates) {
      for (const target of allStates) {
        expect(canTransition(term, target)).toBe(false);
        expect(() => assertTransition(term, target)).toThrow(IllegalStateTransitionError);
      }
    }
  });

  it('assertTransition throws IllegalStateTransitionError with readable message', () => {
    expect(() =>
      assertTransition(DeploymentStatus.QUEUED, DeploymentStatus.DEPLOYED)
    ).toThrowError("Illegal deployment status transition from 'queued' to 'deployed'");
  });
});
