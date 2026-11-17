import path from 'node:path';
import { Readable } from 'node:stream';
import Fastify, { FastifyInstance } from 'fastify';
import { LRUCache } from 'lru-cache';
import mime from 'mime-types';
import {
  DeploymentRecord,
  DeploymentStatus,
  getDeployment,
  getObject,
  getProject,
  isValidDeploymentId,
  isValidProjectId,
  logger,
} from '@deployservice/shared';

export interface RouterOptions {
  deploymentTtlMs?: number;
}

/**
 * Validates subdomains against the 128-bit deployment ID format (^d-[a-f0-9]{32}$)
 * or the project ID format (^prj_[a-f0-9]{12}$).
 */
export function extractAndValidateSubdomain(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;

  // Strip port if present: "d-...localhost:8080" -> "d-..."
  const hostWithoutPort = hostHeader.split(':')[0];

  // Split subdomain from domain: e.g. "d-...localhost" -> ["d-...", "localhost"]
  const parts = hostWithoutPort.split('.');
  if (parts.length < 2) return null;

  const subdomain = parts[0];
  if (!isValidDeploymentId(subdomain) && !isValidProjectId(subdomain)) {
    return null;
  }

  return subdomain;
}

/**
 * Checks for path traversal and forbidden characters.
 * Returns null if path is malicious.
 */
export function sanitizePath(rawUrlPath: string): string | null {
  // Reject null bytes, backslashes, and url-encoded variants
  if (
    rawUrlPath.includes('..') ||
    rawUrlPath.includes('\0') ||
    rawUrlPath.includes('\\') ||
    /%00/i.test(rawUrlPath) ||
    /%2e/i.test(rawUrlPath) ||
    /%2f/i.test(rawUrlPath) ||
    /%5c/i.test(rawUrlPath)
  ) {
    return null;
  }

  // Decode URI component safely
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawUrlPath);
  } catch {
    return null;
  }

  if (decodedPath.includes('..') || decodedPath.includes('\0') || decodedPath.includes('\\')) {
    return null;
  }

  // Normalize path using POSIX rules
  const normalized = path.posix.normalize(decodedPath);

  // Reject anything that traverses outside root
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    return null;
  }

  return normalized;
}

export function buildRouter(opts: RouterOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  type CachedDeployment = { found: true; record: DeploymentRecord } | { found: false };

  // Short-TTL LRU cache for deployment lookups
  const deploymentCache = new LRUCache<string, CachedDeployment>({
    max: 1000,
    ttl: opts.deploymentTtlMs ?? 10000, // 10 seconds default
  });

  // Early validation hook to intercept path traversal before routing
  app.addHook('onRequest', async (request, reply) => {
    const rawUrl = request.raw.url || request.url;
    const rawPathname = rawUrl.split('?')[0];

    if (sanitizePath(rawPathname) === null) {
      return reply.status(400).send({ error: 'Path traversal or invalid characters detected.' });
    }
  });

  // Healthcheck endpoint for router itself
  app.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok', service: 'router' });
  });

  // Catch-all handler for wildcard subdomain routing
  app.setNotFoundHandler(async (request, reply) => {
    const rawUrl = request.raw.url || request.url;
    const rawPathname = rawUrl.split('?')[0];
    if (sanitizePath(rawPathname) === null) {
      return reply.status(400).send({ error: 'Path traversal or invalid characters detected.' });
    }
    return reply.status(404).send('404 Not Found');
  });

  app.all('/*', async (request, reply) => {
    const hostHeader = request.headers.host;
    const identifier = extractAndValidateSubdomain(hostHeader);

    if (!identifier) {
      return reply.status(400).send({
        error: 'Invalid or missing subdomain. Format must be http://<id>.localhost:8080',
      });
    }

    let resolvedDeploymentId: string | null = null;

    if (isValidDeploymentId(identifier)) {
      resolvedDeploymentId = identifier;
    } else if (isValidProjectId(identifier)) {
      // Resolve project's active deployment pointer
      const project = await getProject(identifier);
      if (!project || !project.current_deployment_id) {
        return reply.status(404).send({
          error: `Project '${identifier}' has no active deployed release.`,
        });
      }
      resolvedDeploymentId = project.current_deployment_id;
    }

    if (!resolvedDeploymentId) {
      return reply.status(404).send({
        error: `Could not resolve active deployment for '${identifier}'.`,
      });
    }

    // Lookup deployment (cached)
    let cached = deploymentCache.get(resolvedDeploymentId);
    let deployment: DeploymentRecord | null = null;
    if (cached !== undefined) {
      deployment = cached.found ? cached.record : null;
    } else {
      deployment = await getDeployment(resolvedDeploymentId);
      deploymentCache.set(
        resolvedDeploymentId,
        deployment ? { found: true, record: deployment } : { found: false }
      );
    }

    // Only serve deployments in 'deployed' state
    if (!deployment || deployment.status !== DeploymentStatus.DEPLOYED) {
      return reply.status(404).send({
        error: `Site '${identifier}' is not found or has not been deployed yet.`,
      });
    }

    // Sanitize requested pathname (using raw URL from node request to preserve traversal tokens before framework normalization)
    const rawPathname = (request.raw.url || request.url).split('?')[0];
    const safePath = sanitizePath(rawPathname);

    if (safePath === null) {
      return reply.status(400).send({ error: 'Path traversal or invalid characters detected.' });
    }

    const s3Prefix = `deployments/${resolvedDeploymentId}`;

    // Helper to fetch S3 object
    async function fetchS3Object(s3Key: string) {
      try {
        const obj = await getObject(s3Key);
        return obj;
      } catch (err: any) {
        if (
          err.name === 'NoSuchKey' ||
          err.name === 'NotFound' ||
          err.$metadata?.httpStatusCode === 404
        ) {
          return null;
        }
        throw err;
      }
    }

    // Determine target S3 key
    let targetPath = safePath === '/' ? 'index.html' : safePath.replace(/^\/+/, '');
    const hasExtension = path.extname(targetPath) !== '';

    let s3Object = await fetchS3Object(`${s3Prefix}/${targetPath}`);

    // If not found and target is a directory without index.html
    if (!s3Object && !hasExtension) {
      s3Object = await fetchS3Object(`${s3Prefix}/${targetPath}/index.html`);
      if (s3Object) {
        targetPath = `${targetPath}/index.html`;
      }
    }

    // SPA fallback: for extensionless paths that don't match a static file, fallback to index.html
    let isSpaFallback = false;
    if (!s3Object && !hasExtension) {
      s3Object = await fetchS3Object(`${s3Prefix}/index.html`);
      if (s3Object) {
        isSpaFallback = true;
        targetPath = 'index.html';
      }
    }

    // If still not found, return 404 (assets with extensions always 404 here)
    if (!s3Object || !s3Object.Body) {
      return reply.status(404).send('404 Not Found');
    }

    // Set headers
    let contentType = s3Object.ContentType || mime.lookup(targetPath) || 'application/octet-stream';
    if (contentType.startsWith('text/') || contentType === 'application/javascript') {
      contentType = `${contentType}; charset=utf-8`;
    }
    reply.header('Content-Type', contentType);

    if (s3Object.ETag) {
      reply.header('ETag', s3Object.ETag);
    }

    // Cache-Control headers
    if (isSpaFallback || targetPath === 'index.html') {
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (targetPath.startsWith('assets/') || targetPath.includes('/assets/')) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      reply.header('Cache-Control', 'public, max-age=3600');
    }

    // Stream object body directly to client
    const stream = s3Object.Body as Readable;
    return reply.status(200).send(stream);
  });

  return app;
}
