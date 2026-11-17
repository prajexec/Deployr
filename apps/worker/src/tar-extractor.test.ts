import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { TarSecurityError, validateAndExtractTar } from './tar-extractor.js';

function createTarStream(
  entries: Array<{ header: tar.Headers; content?: string | Buffer }>
): Readable {
  const pack = tar.pack();
  for (const entry of entries) {
    pack.entry(entry.header, entry.content || '');
  }
  pack.finalize();
  return pack;
}

describe('Tar Extractor Security & Bounds Validation', () => {
  it('successfully extracts safe files and strips leading directory if requested', async () => {
    const stream = createTarStream([
      { header: { name: 'output/', type: 'directory' } },
      { header: { name: 'output/index.html', type: 'file' }, content: '<h1>Home</h1>' },
      { header: { name: 'output/assets/main.js', type: 'file' }, content: 'console.log(1)' },
    ]);

    const files = await validateAndExtractTar(stream, { stripLeadingDir: 'output' });
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('index.html');
    expect(files[0].content.toString()).toBe('<h1>Home</h1>');
    expect(files[1].path).toBe('assets/main.js');
    expect(files[1].content.toString()).toBe('console.log(1)');
  });

  it('rejects tar entry containing symlink', async () => {
    const stream = createTarStream([
      {
        header: {
          name: 'malicious-link',
          type: 'symlink',
          linkname: '/etc/passwd',
        },
      },
    ]);

    await expect(validateAndExtractTar(stream)).rejects.toThrow(
      /Illegal tar entry type 'symlink'/
    );
  });

  it('rejects path traversal with ..', async () => {
    const stream = createTarStream([
      { header: { name: 'dist/../../etc/passwd', type: 'file' }, content: 'root:x:0:0' },
    ]);

    await expect(validateAndExtractTar(stream)).rejects.toThrow(/Directory traversal/);
  });

  it('rejects absolute paths', async () => {
    const stream = createTarStream([
      { header: { name: '/etc/shadow', type: 'file' }, content: 'secret' },
    ]);

    await expect(validateAndExtractTar(stream)).rejects.toThrow(/Absolute path forbidden/);
  });

  it('rejects null byte in filename', async () => {
    const pack = tar.pack();
    pack.entry(
      {
        name: 'safe.txt',
        type: 'file',
        pax: { path: 'evil\0file.txt' },
      },
      'payload'
    );
    pack.finalize();

    await expect(validateAndExtractTar(pack)).rejects.toThrow(/Null byte/);
  });

  it('rejects archives exceeding file count limit', async () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      header: { name: `file_${i}.txt`, type: 'file' as const },
      content: 'data',
    }));
    const stream = createTarStream(entries);

    await expect(validateAndExtractTar(stream, { maxFiles: 10 })).rejects.toThrow(
      /maximum allowed file count/
    );
  });

  it('rejects archives exceeding total uncompressed size limit', async () => {
    const stream = createTarStream([
      { header: { name: 'large.bin', type: 'file' }, content: Buffer.alloc(2000) },
    ]);

    await expect(validateAndExtractTar(stream, { maxTotalBytes: 1000 })).rejects.toThrow(
      /maximum uncompressed size/
    );
  });
});
