import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectFramework } from './detector.js';

describe('detectFramework', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects Vite project from package.json dependency', () => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^5.0.0' },
      })
    );

    const config = detectFramework(tempDir);
    expect(config.name).toBe('vite');
    expect(config.outputDir).toBe('dist');
    expect(config.buildCommand).toBe('npm run build');
  });

  it('detects Vite project from vite.config.ts file', () => {
    fs.writeFileSync(path.join(tempDir, 'vite.config.ts'), 'export default {}');

    const config = detectFramework(tempDir);
    expect(config.name).toBe('vite');
    expect(config.outputDir).toBe('dist');
  });

  it('detects Create React App project from react-scripts dependency', () => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { build: 'react-scripts build' },
        dependencies: { 'react-scripts': '^5.0.1' },
      })
    );

    const config = detectFramework(tempDir);
    expect(config.name).toBe('create-react-app');
    expect(config.outputDir).toBe('build');
    expect(config.buildCommand).toBe('npm run build');
  });

  it('detects plain static site with index.html', () => {
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<h1>Hello Static</h1>');

    const config = detectFramework(tempDir);
    expect(config.name).toBe('static');
    expect(config.outputDir).toBe('.');
    expect(config.buildCommand).toBeNull();
  });

  it('fails with descriptive error when project cannot be detected', () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# No code here');

    expect(() => detectFramework(tempDir)).toThrowError(/Unable to detect framework/);
  });
});
