/**
 * Validates public Git repository URLs.
 *
 * Rules:
 * - Only HTTPS scheme is permitted (no file://, ssh://, git://, http://).
 * - Only github.com domain is permitted (rejects arbitrary domains, subdomains like github.com.evil.com, and IP literals).
 * - Path must follow /<owner>/<repo> (with optional .git suffix).
 * - Owner and repo must match valid GitHub naming conventions (alphanumeric, hyphens, underscores).
 */
export function validateRepoUrl(urlStr: string): {
  valid: boolean;
  error?: string;
  owner?: string;
  repo?: string;
} {
  if (!urlStr || typeof urlStr !== 'string') {
    return { valid: false, error: 'Repository URL is required and must be a string' };
  }

  const trimmed = urlStr.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Scheme must strictly be https:
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: `Protocol '${parsed.protocol}' is not allowed. Only HTTPS is supported.`,
    };
  }

  // Host must strictly be github.com (exact match, case-insensitive)
  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com') {
    return { valid: false, error: `Host '${host}' is not allowed. Only github.com is supported.` };
  }

  // Reject port specifications, usernames, passwords, query parameters, and hashes
  if (parsed.port) {
    return { valid: false, error: 'Custom ports are not allowed in repository URLs.' };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Credentials in repository URLs are not allowed.' };
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, error: 'Query parameters and URL hashes are not allowed.' };
  }

  // Pathname must be /<owner>/<repo>[.git]
  // GitHub usernames: 1-39 alphanumeric/hyphens, cannot start with hyphen
  // GitHub repo names: 1-100 alphanumeric, hyphens, underscores, dots, cannot start with hyphen
  const pathRegex =
    /^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})\/([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99})(\.git)?$/;
  const match = parsed.pathname.match(pathRegex);

  if (!match) {
    return {
      valid: false,
      error: 'Repository path must match https://github.com/<owner>/<repo>[.git]',
    };
  }

  const owner = match[1];
  let repo = match[2];
  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }

  // Reject path traversal tokens or invalid repo names
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return { valid: false, error: 'Invalid repository or owner name.' };
  }

  return { valid: true, owner, repo };
}

/**
 * Validates and sanitizes a deployment ID for use as a subdomain.
 * Subdomains must be 1-63 chars, lowercase alphanumeric + hyphens, not starting or ending with hyphen.
 */
export function isValidSubdomain(subdomain: string): boolean {
  if (!subdomain || typeof subdomain !== 'string') return false;
  if (subdomain.length > 63) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain);
}
