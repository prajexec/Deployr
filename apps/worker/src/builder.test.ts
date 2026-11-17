import { describe, expect, it } from 'vitest';
import { getMimeType } from './builder.js';

describe('Worker MIME Type Resolution', () => {
  it('correctly maps file extensions to HTTP Content-Type headers', () => {
    expect(getMimeType('index.html')).toBe('text/html; charset=utf-8');
    expect(getMimeType('styles.css')).toBe('text/css; charset=utf-8');
    expect(getMimeType('bundle.js')).toBe('application/javascript; charset=utf-8');
    expect(getMimeType('bundle.mjs')).toBe('application/javascript; charset=utf-8');
    expect(getMimeType('data.json')).toBe('application/json; charset=utf-8');
    expect(getMimeType('logo.svg')).toBe('image/svg+xml');
    expect(getMimeType('photo.webp')).toBe('image/webp');
    expect(getMimeType('unknown.customext')).toBe('application/octet-stream');
  });
});
