import { Readable } from 'node:stream';
import tar from 'tar-stream';

export interface ExtractedFile {
  path: string;
  content: Buffer;
  size: number;
}

export interface TarExtractOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileSizeBytes?: number;
  stripLeadingDir?: string;
}

export class TarSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarSecurityError';
  }
}

/**
 * Validates a tar archive stream in memory entry-by-entry.
 * Enforces strict Zip Slip protection, symlink rejection, and decompression bomb bounds.
 */
export async function validateAndExtractTar(
  tarStream: Readable,
  options: TarExtractOptions = {}
): Promise<ExtractedFile[]> {
  const maxFiles = options.maxFiles ?? 5000;
  const maxTotalBytes = options.maxTotalBytes ?? 100 * 1024 * 1024; // 100 MB
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 25 * 1024 * 1024; // 25 MB

  const extract = tar.extract();
  const files: ExtractedFile[] = [];

  let fileCount = 0;
  let totalBytes = 0;

  return new Promise((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      let rawName = header.name;

      // Reject non-whitelisted types (symlinks, hardlinks, devices, fifos)
      if (header.type !== 'file' && header.type !== 'directory') {
        stream.resume();
        return reject(
          new TarSecurityError(
            `Illegal tar entry type '${header.type}' for '${rawName}'. Symlinks, hardlinks, and special files are forbidden.`
          )
        );
      }

      // Check path safety
      if (rawName.includes('\0')) {
        stream.resume();
        return reject(new TarSecurityError(`Null byte detected in tar entry path '${rawName}'.`));
      }

      if (rawName.startsWith('/') || rawName.startsWith('\\') || /^[a-zA-Z]:/.test(rawName)) {
        stream.resume();
        return reject(new TarSecurityError(`Absolute path forbidden in tar entry '${rawName}'.`));
      }

      // Normalize path parts and verify no path traversal
      const parts = rawName.split(/[\/\\]+/).filter(Boolean);
      if (parts.some((p) => p === '..')) {
        stream.resume();
        return reject(new TarSecurityError(`Directory traversal ('..') forbidden in tar entry '${rawName}'.`));
      }

      // If directory, nothing to buffer, proceed
      if (header.type === 'directory') {
        stream.resume();
        return next();
      }

      // If stripLeadingDir is configured (e.g. Docker getArchive wraps in target dir name)
      let normalizedPath = parts.join('/');
      if (options.stripLeadingDir) {
        const prefix = options.stripLeadingDir.replace(/^\/+|\/+$/g, '') + '/';
        if (normalizedPath.startsWith(prefix)) {
          normalizedPath = normalizedPath.slice(prefix.length);
        }
      }

      fileCount++;
      if (fileCount > maxFiles) {
        stream.resume();
        return reject(
          new TarSecurityError(`Tar archive exceeded maximum allowed file count of ${maxFiles}.`)
        );
      }

      const chunks: Buffer[] = [];
      let entryBytes = 0;

      stream.on('data', (chunk: Buffer) => {
        entryBytes += chunk.length;
        totalBytes += chunk.length;

        if (entryBytes > maxFileSizeBytes) {
          return reject(
            new TarSecurityError(
              `Tar entry '${rawName}' exceeded maximum allowed file size of ${maxFileSizeBytes} bytes.`
            )
          );
        }

        if (totalBytes > maxTotalBytes) {
          return reject(
            new TarSecurityError(
              `Tar archive exceeded maximum uncompressed size of ${maxTotalBytes} bytes.`
            )
          );
        }

        chunks.push(chunk);
      });

      stream.on('end', () => {
        files.push({
          path: normalizedPath,
          content: Buffer.concat(chunks),
          size: entryBytes,
        });
        next();
      });

      stream.on('error', (err) => {
        reject(err);
      });
    });

    extract.on('finish', () => {
      resolve(files);
    });

    extract.on('error', (err) => {
      reject(err);
    });

    tarStream.pipe(extract);
  });
}
