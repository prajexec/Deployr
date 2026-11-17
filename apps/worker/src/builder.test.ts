import { describe, expect, it, vi } from 'vitest';
import { BUILD_NETWORK_NAME, ensureBuildNetwork, getMimeType } from './builder.js';

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

describe('ensureBuildNetwork', () => {
  it('creates the bridge network if it does not already exist', async () => {
    const listNetworks = vi.fn().mockResolvedValue([]);
    const createNetwork = vi.fn().mockResolvedValue({});
    const mockDocker = { listNetworks, createNetwork } as any;

    await ensureBuildNetwork(mockDocker, 'deployservice-build-net');

    expect(listNetworks).toHaveBeenCalledWith({
      filters: { name: ['deployservice-build-net'] },
    });
    expect(createNetwork).toHaveBeenCalledWith({
      Name: 'deployservice-build-net',
      Driver: 'bridge',
      CheckDuplicate: true,
      Labels: {
        'deployservice.managed': 'true',
      },
    });
  });

  it('is a no-op if the network already exists', async () => {
    const listNetworks = vi.fn().mockResolvedValue([{ Name: 'deployservice-build-net' }]);
    const createNetwork = vi.fn();
    const mockDocker = { listNetworks, createNetwork } as any;

    await ensureBuildNetwork(mockDocker, 'deployservice-build-net');

    expect(listNetworks).toHaveBeenCalled();
    expect(createNetwork).not.toHaveBeenCalled();
  });

  it('safely handles 409 Conflict when creation races with another worker', async () => {
    const listNetworks = vi.fn().mockResolvedValue([]);
    const conflictError: any = new Error('network with name deployservice-build-net already exists');
    conflictError.statusCode = 409;
    const createNetwork = vi.fn().mockRejectedValue(conflictError);
    const mockDocker = { listNetworks, createNetwork } as any;

    await expect(ensureBuildNetwork(mockDocker, 'deployservice-build-net')).resolves.not.toThrow();
  });

  it('re-throws unexpected daemon errors', async () => {
    const listNetworks = vi.fn().mockResolvedValue([]);
    const daemonError = new Error('Docker daemon socket failure');
    const createNetwork = vi.fn().mockRejectedValue(daemonError);
    const mockDocker = { listNetworks, createNetwork } as any;

    await expect(ensureBuildNetwork(mockDocker, 'deployservice-build-net')).rejects.toThrow(
      'Docker daemon socket failure'
    );
  });
});
