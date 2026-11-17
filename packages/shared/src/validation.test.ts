import { describe, expect, it } from 'vitest';
import { isValidSubdomain, validateRepoUrl } from './validation.js';

describe('validateRepoUrl', () => {
  it('accepts valid GitHub repository URLs', () => {
    const validUrls = [
      'https://github.com/facebook/react',
      'https://github.com/facebook/react.git',
      'https://github.com/vitejs/vite',
      'https://github.com/owner-123/my_repo-app.v2',
    ];

    for (const url of validUrls) {
      const res = validateRepoUrl(url);
      expect(res.valid, `Expected '${url}' to be valid`).toBe(true);
      expect(res.owner).toBeDefined();
      expect(res.repo).toBeDefined();
    }
  });

  it('rejects forbidden protocols (file, ssh, git, http)', () => {
    const invalidProtocols = [
      'file:///etc/passwd',
      'file://localhost/etc/shadow',
      'ssh://git@github.com/owner/repo.git',
      'git://github.com/owner/repo.git',
      'http://github.com/owner/repo',
      'ftp://github.com/owner/repo',
      'javascript:alert(1)',
    ];

    for (const url of invalidProtocols) {
      const res = validateRepoUrl(url);
      expect(res.valid, `Expected protocol rejection for '${url}'`).toBe(false);
    }
  });

  it('rejects IP literals and SSRF targets', () => {
    const ssrfUrls = [
      'http://169.254.169.254/latest/meta-data',
      'https://169.254.169.254/owner/repo',
      'http://127.0.0.1:5432',
      'https://127.0.0.1/owner/repo',
      'http://localhost:3000',
      'https://localhost/owner/repo',
      'http://0.0.0.0:80',
    ];

    for (const url of ssrfUrls) {
      const res = validateRepoUrl(url);
      expect(res.valid, `Expected SSRF rejection for '${url}'`).toBe(false);
    }
  });

  it('rejects hostnames that spoof or subvert github.com', () => {
    const spoofUrls = [
      'https://github.com.evil.com/owner/repo',
      'https://evil.github.com/owner/repo',
      'https://fakegithub.com/owner/repo',
      'https://not-github.com/owner/repo',
      'https://github.co/owner/repo',
    ];

    for (const url of spoofUrls) {
      const res = validateRepoUrl(url);
      expect(res.valid, `Expected domain spoof rejection for '${url}'`).toBe(false);
    }
  });

  it('rejects custom ports and credentials', () => {
    expect(validateRepoUrl('https://github.com:8443/owner/repo').valid).toBe(false);
    expect(validateRepoUrl('https://user:pass@github.com/owner/repo').valid).toBe(false);
  });

  it('rejects malformed paths', () => {
    expect(validateRepoUrl('https://github.com/').valid).toBe(false);
    expect(validateRepoUrl('https://github.com/only-owner').valid).toBe(false);
    expect(validateRepoUrl('https://github.com/owner/repo/extra/path').valid).toBe(false);
    expect(validateRepoUrl('https://github.com/../repo').valid).toBe(false);
  });

  it('rejects hostile inputs with shell metacharacters, newlines, spaces, and leading dashes', () => {
    const hostileInputs = [
      '--upload-pack=touch /tmp/pwned',
      '-oProxyCommand=sh evil.sh',
      'https://github.com/foo/bar;rm -rf /',
      'https://github.com/foo/bar`touch pwn`',
      'https://github.com/foo/bar$(whoami)',
      'https://github.com/foo/bar|sh',
      'https://github.com/foo/bar&echo pwn',
      'https://github.com/foo/bar\nrm -rf /',
      'https://github.com/foo/bar\r\necho pwn',
      'https://github.com/foo/bar repo',
      'https://github.com/foo/bar<input',
      'https://github.com/foo/bar>output',
      'https://github.com/foo/bar*glob',
      'https://github.com/foo/bar?param=1',
      'https://github.com/foo/bar\\escape',
      "https://github.com/foo/bar'quote",
      'https://github.com/foo/bar"dquote',
      'https://github.com/-owner/repo',
      'https://github.com/owner/-repo',
    ];

    for (const input of hostileInputs) {
      const res = validateRepoUrl(input);
      expect(res.valid, `Hostile input '${input}' must be rejected`).toBe(false);
    }
  });
});

describe('isValidSubdomain', () => {
  it('accepts valid RFC 1035 subdomains', () => {
    expect(isValidSubdomain('d-1234567890ab')).toBe(true);
    expect(isValidSubdomain('my-app')).toBe(true);
    expect(isValidSubdomain('a')).toBe(true);
    expect(isValidSubdomain('deploy-123-abc')).toBe(true);
  });

  it('rejects invalid subdomains', () => {
    expect(isValidSubdomain('')).toBe(false);
    expect(isValidSubdomain('-start-hyphen')).toBe(false);
    expect(isValidSubdomain('end-hyphen-')).toBe(false);
    expect(isValidSubdomain('UPPERCASE')).toBe(false);
    expect(isValidSubdomain('has_underscore')).toBe(false);
    expect(isValidSubdomain('has.dot')).toBe(false);
    expect(isValidSubdomain('a'.repeat(64))).toBe(false);
  });
});
