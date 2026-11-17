import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DeploymentStatus,
  getConfig,
  logger,
  updateDeploymentStatus,
  uploadObject,
} from '@deployservice/shared';
import { detectFramework } from './detector.js';

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

const execPromise = promisify(exec);
const execFilePromise = promisify(execFile);

/**
 * Creates a minimal, explicit environment for running untrusted build scripts on the host.
 * Crucially, it does NOT inherit process.env (so database passwords, AWS credentials, etc. are not leaked).
 */
export function createSanitizedEnv(tempDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: tempDir,
    CI: 'true',
    NODE_ENV: 'production',
    TMPDIR: tempDir,
    LANG: 'en_US.UTF-8',
  };
}

/**
 * Recursively uploads all files from a directory to MinIO under the specified key prefix.
 */
export async function uploadDirectoryToStorage(localDir: string, s3Prefix: string): Promise<number> {
  let fileCount = 0;

  async function walk(dir: string, baseDir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath, baseDir);
      } else if (entry.isFile()) {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const s3Key = path.posix.join(s3Prefix, relativePath);

        const content = fs.readFileSync(fullPath);
        const contentType = getMimeType(fullPath);

        await uploadObject(s3Key, content, contentType);
        fileCount++;
      }
    }
  }

  await walk(localDir, localDir);
  return fileCount;
}

/**
 * Core build executor for Phase 2.
 */
export async function executeBuild(deploymentId: string, repoUrl: string): Promise<void> {
  const config = getConfig();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `deploy-${deploymentId}-`));
  const startTime = new Date();

  logger.info({ deploymentId, workDir, repoUrl }, 'Starting build job');

  try {
    // 1. Transition: queued -> cloning
    await updateDeploymentStatus(deploymentId, DeploymentStatus.CLONING, {
      started_at: startTime,
    });

    let commitSha = 'unknown';

    // 2. Clone repository (or copy fixture if local file/path)
    if (repoUrl.startsWith('https://') || repoUrl.startsWith('git@') || repoUrl.endsWith('.git')) {
      logger.info({ deploymentId, repoUrl }, 'Cloning Git repository...');
      const cloneTimeout = 60000; // 60s clone timeout

      await execFilePromise('git', ['clone', '--depth', '1', repoUrl, workDir], {
        timeout: cloneTimeout,
      });

      try {
        const { stdout } = await execFilePromise('git', ['rev-parse', 'HEAD'], {
          cwd: workDir,
        });
        commitSha = stdout.trim();
      } catch {
        commitSha = 'unknown';
      }
    } else if (fs.existsSync(repoUrl)) {
      // Local fixture directory for tests
      logger.info({ deploymentId, fixture: repoUrl }, 'Copying local test fixture...');
      fs.cpSync(repoUrl, workDir, { recursive: true });
      commitSha = 'fixture-commit-sha';
    } else {
      throw new Error(`Invalid repository source: ${repoUrl}`);
    }

    // Check repository size limit
    const repoSizeMB = getDirectorySizeMB(workDir);
    if (repoSizeMB > config.MAX_REPO_SIZE_MB) {
      throw new Error(
        `Repository size (${repoSizeMB.toFixed(1)}MB) exceeds maximum limit of ${config.MAX_REPO_SIZE_MB}MB.`
      );
    }

    // 3. Detect framework
    const framework = detectFramework(workDir);
    logger.info({ deploymentId, framework: framework.name }, 'Framework detected');

    // 4. Transition: cloning -> building
    await updateDeploymentStatus(deploymentId, DeploymentStatus.BUILDING, {
      commit_sha: commitSha,
    });

    // 5. Execute build subprocess with sanitized environment
    if (framework.buildCommand) {
      logger.info({ deploymentId, command: framework.buildCommand }, 'Executing build command...');
      const sanitizedEnv = createSanitizedEnv(workDir);

      await execPromise(framework.buildCommand, {
        cwd: workDir,
        env: sanitizedEnv,
        timeout: config.BUILD_TIMEOUT_MS,
      });
    }

    // 6. Verify output directory exists
    const resolvedOutputDir =
      framework.outputDir === '.'
        ? workDir
        : path.join(workDir, framework.outputDir);

    if (!fs.existsSync(resolvedOutputDir)) {
      throw new Error(
        `Build finished but expected output directory '${framework.outputDir}' was not found.`
      );
    }

    // 7. Transition: building -> uploading
    await updateDeploymentStatus(deploymentId, DeploymentStatus.UPLOADING, {
      output_dir: framework.outputDir,
    });

    // 8. Upload files to MinIO under deployments/<id>/
    const s3Prefix = `deployments/${deploymentId}`;
    logger.info({ deploymentId, s3Prefix, resolvedOutputDir }, 'Uploading files to MinIO...');
    const uploadedFiles = await uploadDirectoryToStorage(resolvedOutputDir, s3Prefix);

    if (uploadedFiles === 0) {
      throw new Error('Build output directory was empty. No files to deploy.');
    }

    // 9. Atomic publish: transition uploading -> deployed only after upload succeeds
    await updateDeploymentStatus(deploymentId, DeploymentStatus.DEPLOYED, {
      finished_at: new Date(),
    });

    logger.info({ deploymentId, uploadedFiles }, 'Deployment successfully published!');
  } catch (err: any) {
    logger.error({ deploymentId, err: err.message }, 'Build failed');

    const errorMessage = err.message || 'Build failed unexpectedly';
    const isTimeout =
      err.killed ||
      err.signal === 'SIGTERM' ||
      errorMessage.toLowerCase().includes('timed out');

    try {
      await updateDeploymentStatus(
        deploymentId,
        isTimeout ? DeploymentStatus.TIMED_OUT : DeploymentStatus.FAILED,
        {
          error_message: errorMessage,
          finished_at: new Date(),
        }
      );
    } catch (statusErr: any) {
      logger.error({ deploymentId, statusErr }, 'Failed to record failure status');
    }

    throw err;
  } finally {
    // 10. Always clean up temporary work directory
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
        logger.info({ deploymentId, workDir }, 'Cleaned up work directory');
      }
    } catch (cleanupErr: any) {
      logger.warn({ deploymentId, cleanupErr }, 'Failed to clean up work directory');
    }
  }
}

function getDirectorySizeMB(dirPath: string): number {
  let totalBytes = 0;
  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          totalBytes += fs.statSync(fullPath).size;
        } catch {}
      }
    }
  }
  walk(dirPath);
  return totalBytes / (1024 * 1024);
}
