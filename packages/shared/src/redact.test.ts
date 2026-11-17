import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('replaces known secret literals with [REDACTED]', () => {
    const secrets = ['super-secret-password-123', 's3-key-xyz'];
    const log = 'Connecting with super-secret-password-123 to storage s3-key-xyz done';
    expect(redactSecrets(log, secrets)).toBe(
      'Connecting with [REDACTED] to storage [REDACTED] done'
    );
  });

  it('ignores empty or short strings to avoid over-redaction', () => {
    const secrets = ['', '   ', 'abc', undefined as any];
    const log = 'abc def ghi';
    expect(redactSecrets(log, secrets)).toBe('abc def ghi');
  });

  it('handles empty input cleanly', () => {
    expect(redactSecrets('', ['secret'])).toBe('');
  });
});
