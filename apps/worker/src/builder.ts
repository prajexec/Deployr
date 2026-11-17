import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import Docker from 'dockerode';
import tar from 'tar-stream';
import {
  DeploymentStatus,
  getConfig,
  getDeployment,
  getRedisClient,
  logger,
  setProjectCurrentDeployment,
  updateDeploymentStatus,
  uploadObject,
  UserBuildError,
} from '@deployservice/shared';
import { validateAndExtractTar } from './tar-extractor.js';
import { DeploymentLogWriter } from './stream-writer.js';

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

let dockerInstance: Docker | null = null;
export const activeDeployments = new Set<string>();
export const cancelledDeployments = new Set<string>();

export function getDockerClient(): Docker {
  if (!dockerInstance) {
    dockerInstance = new Docker({ socketPath: '/var/run/docker.sock' });
  }
  return dockerInstance;
}

export async function cancelActiveBuild(
  deploymentId: string,
  docker: Docker = getDockerClient()
): Promise<boolean> {
  cancelledDeployments.add(deploymentId);
  logger.info({ deploymentId }, 'Cancelling active build container');

  const containerName = `deployservice-build-${deploymentId}`;
  try {
    const ctr = docker.getContainer(containerName);
    await ctr.kill().catch(() => {});
    return true;
  } catch (err: any) {
    logger.warn({ deploymentId, err: err.message }, 'Failed killing container during cancel');
    return false;
  }
}

export function setDockerClient(client: Docker | null) {
  dockerInstance = client;
}

export const BUILD_NETWORK_NAME = 'deployservice-build-net';

/**
 * Idempotently ensures that the dedicated build bridge network exists.
 * If the network does not exist, it creates it with bridge driver and managed label.
 * If concurrent workers/tests attempt creation simultaneously, 409 Conflict is safely ignored.
 */
export async function ensureBuildNetwork(
  docker: Docker = getDockerClient(),
  networkName: string = BUILD_NETWORK_NAME
): Promise<void> {
  try {
    const networks = await docker.listNetworks({
      filters: { name: [networkName] },
    });
    const exists = networks.some((n: any) => n.Name === networkName);
    if (!exists) {
      await docker.createNetwork({
        Name: networkName,
        Driver: 'bridge',
        CheckDuplicate: true,
        Labels: {
          'deployservice.managed': 'true',
        },
      });
      logger.info({ networkName }, 'Created isolated build network');
    }
  } catch (err: any) {
    if (err.statusCode === 409 || err.message?.includes('already exists')) {
      return;
    }
    logger.error({ err: err.message, networkName }, 'Failed ensuring build network');
    throw err;
  }
}

export interface ReaperResult {
  containersReaped: number;
  volumesReaped: number;
}

/**
 * Startup reaper: forcefully removes any orphaned build containers and volumes
 * labeled with 'deployservice.managed=true' left over from previous crashes.
 * Scoped by age (> maxAgeMs, default 5m) or stopped state, and never kills
 * resources belonging to active deployments on this worker instance.
 */
export async function reapOrphanedContainers(
  docker: Docker = getDockerClient(),
  maxAgeMs: number = 300000
): Promise<ReaperResult> {
  let containersReaped = 0;
  let volumesReaped = 0;
  const now = Date.now();

  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ['deployservice.managed=true'] },
    });

    for (const info of containers) {
      try {
        const deploymentId = info.Labels?.['deployservice.deployment_id'];
        if (deploymentId && activeDeployments.has(deploymentId)) {
          continue; // Skip actively executing deployment on this worker
        }

        // Scope running containers: if recently created, do not touch (may belong to another worker)
        if (info.State === 'running' || info.State === 'restarting') {
          const createdAtStr = info.Labels?.['deployservice.created_at'];
          const createdAt = createdAtStr ? new Date(createdAtStr).getTime() : 0;
          if (createdAt && now - createdAt < maxAgeMs) {
            continue;
          }

          const ctr = docker.getContainer(info.Id);
          await ctr.kill().catch((err: any) => {
            logger.warn(
              { id: info.Id, err: err.message },
              'Failed killing orphaned container during reap'
            );
          });
        }

        const ctr = docker.getContainer(info.Id);
        await ctr.remove({ force: true }).catch((err: any) => {
          logger.warn(
            { id: info.Id, err: err.message },
            'Failed removing orphaned container during reap'
          );
        });
        containersReaped++;
      } catch (err: any) {
        logger.warn({ id: info.Id, err: err.message }, 'Failed to reap orphaned container');
      }
    }

    // Also reap any orphaned build volumes
    const { Volumes: volumes } = await docker.listVolumes({
      filters: { label: ['deployservice.managed=true'] },
    });

    if (volumes) {
      for (const vol of volumes) {
        try {
          const deploymentId = vol.Labels?.['deployservice.deployment_id'];
          if (deploymentId && activeDeployments.has(deploymentId)) {
            continue;
          }

          const createdAtStr = vol.Labels?.['deployservice.created_at'];
          const createdAt = createdAtStr ? new Date(createdAtStr).getTime() : 0;
          if (createdAt && now - createdAt < maxAgeMs) {
            continue;
          }

          const v = docker.getVolume(vol.Name);
          await v.remove({ force: true }).catch((err: any) => {
            logger.warn(
              { name: vol.Name, err: err.message },
              'Failed removing orphaned volume during reap'
            );
          });
          volumesReaped++;
        } catch (err: any) {
          logger.warn({ name: vol.Name, err: err.message }, 'Failed to reap orphaned volume');
        }
      }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed listing containers/volumes for startup reaping');
  }

  return { containersReaped, volumesReaped };
}

/**
 * Packs a local directory into a tar stream for staging into a test container.
 */
function packDirectoryToTar(srcDir: string): Readable {
  const pack = tar.pack();

  // Explicitly add 'repo' directory entry with full user permissions (UID/GID 10001)
  pack.entry({
    name: 'repo',
    type: 'directory',
    mode: 0o777,
    uid: 10001,
    gid: 10001,
    uname: 'builduser',
    gname: 'builduser',
  });

  function walk(currentDir: string, relativeDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.posix.join('repo', relativeDir, entry.name);

      if (entry.isDirectory()) {
        pack.entry({
          name: relPath,
          type: 'directory',
          mode: 0o777,
          uid: 10001,
          gid: 10001,
          uname: 'builduser',
          gname: 'builduser',
        });
        walk(fullPath, path.join(relativeDir, entry.name));
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath);
        pack.entry(
          {
            name: relPath,
            type: 'file',
            mode: 0o777,
            uid: 10001,
            gid: 10001,
            uname: 'builduser',
            gname: 'builduser',
          },
          content
        );
      }
    }
  }

  walk(srcDir, '');
  pack.finalize();
  return pack;
}

export interface BuildOptions {
  fixtureDir?: string;
  timeoutMs?: number;
  dockerClient?: Docker;
  maxLogBytes?: number;
  enableHostInternalForTest?: boolean;
}

/**
 * Executes a build inside an isolated Docker sandbox container.
 */
export async function executeBuild(
  deploymentId: string,
  repoUrl: string,
  options: BuildOptions = {}
): Promise<void> {
  const config = getConfig();
  const docker = options.dockerClient || getDockerClient();
  const timeoutMs = options.timeoutMs ?? config.BUILD_TIMEOUT_MS;
  const maxLogBytes = options.maxLogBytes ?? 2 * 1024 * 1024; // 2 MB cap

  const containerName = `deployservice-build-${deploymentId}`;
  const volumeName = `deployservice-vol-${deploymentId}`;

  activeDeployments.add(deploymentId);

  let container: Docker.Container | null = null;
  let volume: Docker.Volume | null = null;
  let logWriter: DeploymentLogWriter | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let isTimedOut = false;
  let waitResult: { StatusCode: number } = { StatusCode: 1 };
  let logBuffer = '';

  logger.info({ deploymentId, repoUrl }, 'Starting isolated container build...');

  try {
    // 1. Transition: queued -> cloning
    await updateDeploymentStatus(deploymentId, DeploymentStatus.CLONING, {
      started_at: new Date(),
    });

    // Ensure dedicated build network exists before container creation
    await ensureBuildNetwork(docker);

    // 2. Create isolated per-build volume
    await docker.createVolume({
      Name: volumeName,
      Labels: {
        'deployservice.managed': 'true',
        'deployservice.deployment_id': deploymentId,
        'deployservice.created_at': new Date().toISOString(),
      },
    });
    volume = docker.getVolume(volumeName);

    // 3. Create sandboxed sibling build container
    const createdContainer = (await docker.createContainer({
      name: containerName,
      Image: 'deployservice-builder:latest',
      Env: [`REPO_URL=${repoUrl}`],
      Labels: {
        'deployservice.managed': 'true',
        'deployservice.deployment_id': deploymentId,
        'deployservice.created_at': new Date().toISOString(),
      },
      HostConfig: {
        // Resource limits
        Memory: 512 * 1024 * 1024, // 512 MB hard RAM limit
        MemorySwap: 512 * 1024 * 1024, // Disables swap
        NanoCpus: 1_000_000_000, // 1 CPU core
        PidsLimit: 100, // Process limit

        // Security options
        CapDrop: ['ALL'], // Drop all capabilities
        SecurityOpt: ['no-new-privileges:true'], // Forbid setuid escalation
        ReadonlyRootfs: true, // Immutable root filesystem
        Privileged: false,

        // Network isolation: dedicated bridge network separate from compose network
        NetworkMode: 'deployservice-build-net',
        ...(options.enableHostInternalForTest
          ? { ExtraHosts: ['host.docker.internal:host-gateway'] }
          : {}),

        // Storage: dedicated per-build volume for /build and small tmpfs for /tmp
        Binds: [`${volumeName}:/build`],
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,size=64m',
        },
      },
    })) as Docker.Container;

    container = createdContainer;

    // If fixtureDir is provided (e.g. In tests), pre-stage fixture into /build/repo before start
    if (options.fixtureDir && fs.existsSync(options.fixtureDir)) {
      const fixtureTar = packDirectoryToTar(options.fixtureDir);
      await container.putArchive(fixtureTar, { path: '/build' });
    }

    // 4. Attach to stdout/stderr with 2 MB cap, real-time Redis streaming, and non-blocking draining
    const logStream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    const secretsToRedact = [
      process.env.POSTGRES_PASSWORD,
      process.env.S3_SECRET_ACCESS_KEY,
      process.env.API_KEY,
    ].filter(Boolean) as string[];

    logWriter = new DeploymentLogWriter(deploymentId, getRedisClient(), secretsToRedact);
    await logWriter.start();

    let logBytesCaptured = 0;
    let logTruncated = false;
    let transitionedToBuilding = false;

    const captureChunk = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf-8');

      // Check if build phase has started
      if (!transitionedToBuilding && text.includes('[builder] Detected framework:')) {
        transitionedToBuilding = true;
        updateDeploymentStatus(deploymentId, DeploymentStatus.BUILDING).catch(() => {});
      }

      logWriter?.writeChunk(stream, text);

      if (logBytesCaptured < maxLogBytes) {
        const remaining = maxLogBytes - logBytesCaptured;
        if (chunk.length <= remaining) {
          logBuffer += text;
          logBytesCaptured += chunk.length;
        } else {
          logBuffer += text.slice(0, remaining);
          logBytesCaptured += remaining;
          logBuffer += '\n[logs truncated: exceeded 2MB limit]\n';
          logTruncated = true;
          logWriter?.writeSystemNotice('\n[logs truncated: exceeded 2MB limit]\n');
        }
      }
    };

    const stdoutDrainer = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        captureChunk('stdout', chunk);
        callback();
      },
    });

    const stderrDrainer = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        captureChunk('stderr', chunk);
        callback();
      },
    });

    docker.modem.demuxStream(logStream, stdoutDrainer, stderrDrainer);

    // 5. Start container
    await container.start();

    // 6. Set wall-clock timeout
    timeoutTimer = setTimeout(async () => {
      isTimedOut = true;
      logger.warn(
        { deploymentId, timeoutMs },
        'Build exceeded wall-clock timeout. Force killing container...'
      );
      if (container) {
        await container.kill().catch((killErr: any) => {
          logger.warn({ deploymentId, err: killErr.message }, 'Failed killing timed-out container');
        });
      }
    }, timeoutMs);

    // 7. Wait for container to finish execution
    waitResult = await container.wait();
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }

    // 8. Inspect container for exit code and OOM detection
    const inspect = await container.inspect();
    const isOomKilled =
      inspect.State?.OOMKilled ||
      inspect.State?.ExitCode === 137 ||
      logBuffer.toLowerCase().includes('out of memory') ||
      logBuffer.toLowerCase().includes('allocation failed') ||
      logBuffer.toLowerCase().includes('invalid string length');

    if (isTimedOut) {
      throw new UserBuildError(`Build timed out after ${timeoutMs / 1000} seconds`);
    }

    if (isOomKilled) {
      throw new UserBuildError('Build exceeded memory limit (OOM killed)');
    }

    if (waitResult.StatusCode !== 0) {
      const tailLines = logBuffer.trim().split('\n').slice(-10).join('\n');
      throw new UserBuildError(
        tailLines || `Build container exited with non-zero code ${waitResult.StatusCode}`,
        waitResult.StatusCode
      );
    }

    // 9. Transition: building -> uploading
    await updateDeploymentStatus(deploymentId, DeploymentStatus.UPLOADING);

    // 10. Extract metadata
    let commitSha = 'unknown';
    let outputDir = 'dist';

    try {
      const metaStream = await container.getArchive({ path: '/build/.metadata.json' });
      const metaFiles = await validateAndExtractTar(metaStream as any);
      if (metaFiles.length > 0) {
        const meta = JSON.parse(metaFiles[0].content.toString('utf-8'));
        commitSha = meta.commitSha || commitSha;
        outputDir = meta.outputDir || outputDir;
      }
    } catch (err: any) {
      logger.warn(
        { deploymentId, err: err.message },
        'Could not read build metadata, proceeding with defaults'
      );
    }

    // 11. Extract output artifacts and validate tar stream
    const archiveStream = await container.getArchive({ path: '/build/output' });
    const extractedFiles = await validateAndExtractTar(archiveStream as any, {
      stripLeadingDir: 'output',
      maxTotalBytes: 100 * 1024 * 1024,
      maxFiles: 5000,
    });

    if (extractedFiles.length === 0) {
      throw new UserBuildError('Build completed but output directory contained zero files.');
    }

    // 12. Upload files to MinIO under deployments/<id>/
    const s3Prefix = `deployments/${deploymentId}`;
    logger.info(
      { deploymentId, fileCount: extractedFiles.length },
      'Uploading extracted files to storage...'
    );

    for (const file of extractedFiles) {
      const s3Key = `${s3Prefix}/${file.path}`;
      const contentType = getMimeType(file.path);
      await uploadObject(s3Key, file.content, contentType);
    }

    // 13. Upload complete log archive to MinIO at deployments/<id>/logs.txt
    try {
      await uploadObject(
        `deployments/${deploymentId}/logs.txt`,
        logBuffer,
        'text/plain; charset=utf-8'
      );
    } catch (archiveErr: any) {
      logger.warn(
        { deploymentId, err: archiveErr.message },
        'Failed uploading log archive to storage (archive unavailable)'
      );
    }

    // 14. Atomic transition: uploading -> deployed
    await updateDeploymentStatus(deploymentId, DeploymentStatus.DEPLOYED, {
      finished_at: new Date(),
      commit_sha: commitSha,
      output_dir: outputDir,
    });

    // Point project's current_deployment_id to this newly deployed release atomically
    try {
      const depRecord = await getDeployment(deploymentId);
      if (depRecord?.project_id) {
        await setProjectCurrentDeployment(depRecord.project_id, deploymentId);
        logger.info(
          { projectId: depRecord.project_id, deploymentId },
          'Atomically switched project current_deployment_id'
        );
      }
    } catch (publishErr: any) {
      logger.warn(
        { deploymentId, err: publishErr.message },
        'Non-fatal warning: failed to update project current_deployment_id pointer'
      );
    }

    // 15. Write terminal end marker to Redis stream
    await logWriter?.finish('deployed', waitResult.StatusCode);

    logger.info(
      { deploymentId, commitSha, fileCount: extractedFiles.length },
      'Deployment successfully published!'
    );
  } catch (err: any) {
    logger.error({ deploymentId, err: err.message }, 'Deployment build failed');

    const errorMessage = err.message || 'Build failed unexpectedly';
    const isTimeout = isTimedOut || errorMessage.toLowerCase().includes('timed out');
    const isCancelled = cancelledDeployments.has(deploymentId);

    const terminalStatus = isCancelled
      ? DeploymentStatus.CANCELLED
      : isTimeout
        ? DeploymentStatus.TIMED_OUT
        : DeploymentStatus.FAILED;

    // Best-effort failure log archive upload
    try {
      await uploadObject(
        `deployments/${deploymentId}/logs.txt`,
        logBuffer,
        'text/plain; charset=utf-8'
      );
    } catch {
      // ignore
    }

    try {
      await updateDeploymentStatus(deploymentId, terminalStatus, {
        error_message: isCancelled ? 'Deployment cancelled by user' : errorMessage,
        finished_at: new Date(),
      });
    } catch (updateErr: any) {
      logger.error(
        { deploymentId, updateErr: updateErr.message },
        'Failed updating deployment failure status'
      );
    }

    await logWriter?.finish(
      terminalStatus,
      isCancelled ? 130 : waitResult?.StatusCode ?? 1
    );

    if (isCancelled) {
      throw new UserBuildError('Deployment cancelled by user', 130);
    }

    throw err;
  } finally {
    activeDeployments.delete(deploymentId);
    cancelledDeployments.delete(deploymentId);

    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }

    // Always clean up container and volume in finally
    if (container) {
      await container.remove({ force: true }).catch((err: any) => {
        logger.warn(
          { deploymentId, err: err.message },
          'Failed removing build container during cleanup'
        );
      });
    }
    if (volume) {
      await volume.remove({ force: true }).catch((err: any) => {
        logger.warn(
          { deploymentId, err: err.message },
          'Failed removing build volume during cleanup'
        );
      });
    }
  }
}
