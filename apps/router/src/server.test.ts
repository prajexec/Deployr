import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import * as shared from '@deployservice/shared';
import { buildRouter, extractAndValidateSubdomain, sanitizePath } from './server.js';

describe('extractAndValidateSubdomain', () => {
  it('extracts valid subdomains', () => {
    expect(extractAndValidateSubdomain('d-0123456789abcdef0123456789abcdef.localhost:8080')).toBe(
      'd-0123456789abcdef0123456789abcdef'
    );
    expect(extractAndValidateSubdomain('d-ffffffffffffffffffffffffffffffff.example.com')).toBe(
      'd-ffffffffffffffffffffffffffffffff'
    );
    expect(extractAndValidateSubdomain('prj_0123456789ab.localhost:8080')).toBe('prj_0123456789ab');
  });

  it('rejects invalid or missing subdomains', () => {
    expect(extractAndValidateSubdomain(undefined)).toBeNull();
    expect(extractAndValidateSubdomain('localhost:8080')).toBeNull();
    expect(extractAndValidateSubdomain('d-short.localhost')).toBeNull();
    expect(extractAndValidateSubdomain('-invalid.localhost')).toBeNull();
    expect(extractAndValidateSubdomain('invalid-.localhost')).toBeNull();
    expect(extractAndValidateSubdomain('UPPER.localhost')).toBeNull();
    expect(extractAndValidateSubdomain('bad_char.localhost')).toBeNull();
  });
});

describe('sanitizePath (Path Traversal Protection)', () => {
  it('allows safe relative paths', () => {
    expect(sanitizePath('/')).toBe('/');
    expect(sanitizePath('/index.html')).toBe('/index.html');
    expect(sanitizePath('/assets/app.js')).toBe('/assets/app.js');
    expect(sanitizePath('/nested/folder/page')).toBe('/nested/folder/page');
  });

  it('rejects directory traversal and encoded variants', () => {
    expect(sanitizePath('/../etc/passwd')).toBeNull();
    expect(sanitizePath('/assets/../../secret')).toBeNull();
    expect(sanitizePath('/%2e%2e/etc/passwd')).toBeNull();
    expect(sanitizePath('/%2e%2e%2fetc/passwd')).toBeNull();
    expect(sanitizePath('/..%2f')).toBeNull();
  });

  it('rejects null bytes and backslashes', () => {
    expect(sanitizePath('/file\0.txt')).toBeNull();
    expect(sanitizePath('/file%00.txt')).toBeNull();
    expect(sanitizePath('/folder\\file.js')).toBeNull();
    expect(sanitizePath('/folder%5cfile.js')).toBeNull();
  });
});

describe('Router Server Request Routing', () => {
  it('returns 400 when host header lacks valid subdomain', async () => {
    const app = buildRouter();
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'localhost:8080' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid or missing subdomain/);
    await app.close();
  });

  it('returns 404 when deployment is not deployed', async () => {
    vi.spyOn(shared, 'getDeployment').mockResolvedValue({
      id: 'd-0123456789abcdef0123456789abcdef',
      project_id: 'prj_test',
      status: 'building',
      commit_sha: null,
      output_dir: null,
      error_message: null,
      created_at: new Date(),
      started_at: new Date(),
      finished_at: null,
    });

    const app = buildRouter();
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'd-0123456789abcdef0123456789abcdef.localhost:8080' },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('serves static file and sets correct headers', async () => {
    vi.spyOn(shared, 'getDeployment').mockResolvedValue({
      id: 'd-0123456789abcdef0123456789abcdef',
      project_id: 'prj_test',
      status: 'deployed',
      commit_sha: 'sha123',
      output_dir: 'dist',
      error_message: null,
      created_at: new Date(),
      started_at: new Date(),
      finished_at: new Date(),
    });

    vi.spyOn(shared, 'getObject').mockResolvedValue({
      Body: Readable.from(['console.log("hello");']),
      ContentType: 'application/javascript',
      ETag: '"etag-123"',
    } as any);

    const app = buildRouter();
    const res = await app.inject({
      method: 'GET',
      url: '/assets/app-hash123.js',
      headers: { host: 'd-0123456789abcdef0123456789abcdef.localhost:8080' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.body).toBe('console.log("hello");');
    await app.close();
  });

  it('provides SPA fallback to index.html for extensionless paths', async () => {
    vi.spyOn(shared, 'getDeployment').mockResolvedValue({
      id: 'd-0123456789abcdef0123456789abcdef',
      project_id: 'prj_test',
      status: 'deployed',
      commit_sha: 'sha123',
      output_dir: 'dist',
      error_message: null,
      created_at: new Date(),
      started_at: new Date(),
      finished_at: new Date(),
    });

    vi.spyOn(shared, 'getObject').mockImplementation(async (key: string) => {
      if (key === 'deployments/d-0123456789abcdef0123456789abcdef/index.html') {
        return {
          Body: Readable.from(['<!DOCTYPE html><html><body>SPA Root</body></html>']),
          ContentType: 'text/html',
        } as any;
      }
      const err: any = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      throw err;
    });

    const app = buildRouter();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/settings',
      headers: { host: 'd-0123456789abcdef0123456789abcdef.localhost:8080' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(res.body).toContain('SPA Root');
    await app.close();
  });

  it('returns real 404 for missing asset files (with extensions)', async () => {
    vi.spyOn(shared, 'getDeployment').mockResolvedValue({
      id: 'd-0123456789abcdef0123456789abcdef',
      project_id: 'prj_test',
      status: 'deployed',
      commit_sha: 'sha123',
      output_dir: 'dist',
      error_message: null,
      created_at: new Date(),
      started_at: new Date(),
      finished_at: new Date(),
    });

    vi.spyOn(shared, 'getObject').mockImplementation(async () => {
      const err: any = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      throw err;
    });

    const app = buildRouter();
    const res = await app.inject({
      method: 'GET',
      url: '/assets/missing-asset.png',
      headers: { host: 'd-0123456789abcdef0123456789abcdef.localhost:8080' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('404 Not Found');
    await app.close();
  });

  it('rejects path traversal attempts with 400', async () => {
    vi.spyOn(shared, 'getDeployment').mockResolvedValue({
      id: 'd-0123456789abcdef0123456789abcdef',
      project_id: 'prj_test',
      status: 'deployed',
      commit_sha: 'sha123',
      output_dir: 'dist',
      error_message: null,
      created_at: new Date(),
      started_at: new Date(),
      finished_at: new Date(),
    });

    const app = buildRouter();
    const res = await app.inject({
      method: 'GET',
      url: '/file%00.txt',
      headers: { host: 'd-0123456789abcdef0123456789abcdef.localhost:8080' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('serves site via project subdomain pointing to current_deployment_id', async () => {
    const PROJECT_ID = 'prj_0123456789ab';
    const DEPLOYMENT_ID = 'd-0123456789abcdef0123456789abcdef';

    vi.spyOn(shared, 'getProject').mockResolvedValue({
      id: PROJECT_ID,
      name: 'facebook/react',
      repo_url: 'https://github.com/facebook/react',
      current_deployment_id: DEPLOYMENT_ID,
      created_at: new Date(),
    });

    vi.spyOn(shared, 'getDeployment').mockResolvedValue({
      id: DEPLOYMENT_ID,
      project_id: PROJECT_ID,
      status: 'deployed',
      commit_sha: 'sha123',
      output_dir: 'dist',
      error_message: null,
      created_at: new Date(),
      started_at: new Date(),
      finished_at: new Date(),
    });

    vi.spyOn(shared, 'getObject').mockResolvedValue({
      Body: Readable.from(['<h1>Production Project Site</h1>']),
      ContentType: 'text/html; charset=utf-8',
      ETag: '"etag-proj"',
    } as any);

    const app = buildRouter();
    const res = await app.inject({
      method: 'GET',
      url: '/index.html',
      headers: { host: `${PROJECT_ID}.localhost:8080` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>Production Project Site</h1>');
    await app.close();
  });

  it('returns 404 when project has no active deployed release', async () => {
    const PROJECT_ID = 'prj_0123456789ab';

    vi.spyOn(shared, 'getProject').mockResolvedValue({
      id: PROJECT_ID,
      name: 'facebook/react',
      repo_url: 'https://github.com/facebook/react',
      current_deployment_id: null,
      created_at: new Date(),
    });

    const app = buildRouter();
    const res = await app.inject({
      method: 'GET',
      url: '/index.html',
      headers: { host: `${PROJECT_ID}.localhost:8080` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/has no active deployed release/);
    await app.close();
  });
});
