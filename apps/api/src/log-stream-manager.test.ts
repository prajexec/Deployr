import { describe, expect, it } from 'vitest';
import { compareStreamIds, parseStreamFields } from './log-stream-manager.js';

describe('LogStreamManager Stream ID Comparison', () => {
  it('correctly compares Redis stream IDs numerically with BigInt', () => {
    expect(compareStreamIds('100-0', '100-0')).toBe(0);
    expect(compareStreamIds('100-1', '100-2')).toBe(-1);
    expect(compareStreamIds('100-10', '100-2')).toBe(1);
    expect(compareStreamIds('200-0', '100-999')).toBe(1);
    expect(compareStreamIds('100-9', '100-10')).toBe(-1); // Crucial: '100-9' > '100-10' in string sort!
    expect(compareStreamIds('1731844800000-0', '1731844800000-1')).toBe(-1);
  });
});

describe('parseStreamFields', () => {
  it('parses stream fields correctly', () => {
    const fields = [
      'type',
      'log',
      'ts',
      '2026-11-17T12:00:00.000Z',
      'stream',
      'stdout',
      'data',
      'Building app...',
      'cont',
      '1',
    ];
    const parsed = parseStreamFields('1000-1', fields);
    expect(parsed.id).toBe('1000-1');
    expect(parsed.type).toBe('log');
    expect(parsed.ts).toBe('2026-11-17T12:00:00.000Z');
    expect(parsed.stream).toBe('stdout');
    expect(parsed.data).toBe('Building app...');
    expect(parsed.cont).toBe(true);
  });

  it('parses end marker fields', () => {
    const fields = ['type', 'marker', 'name', 'end', 'status', 'deployed', 'exitCode', '0'];
    const parsed = parseStreamFields('1000-2', fields);
    expect(parsed.type).toBe('marker');
    expect(parsed.name).toBe('end');
    expect(parsed.status).toBe('deployed');
    expect(parsed.exitCode).toBe(0);
  });
});
