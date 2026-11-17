import fs from 'node:fs';
import path from 'node:path';

export interface FrameworkConfig {
  name: 'vite' | 'create-react-app' | 'static';
  buildCommand: string | null;
  outputDir: string;
}

export function detectFramework(repoDir: string): FrameworkConfig {
  const packageJsonPath = path.join(repoDir, 'package.json');
  const indexPath = path.join(repoDir, 'index.html');

  let packageJson: any = null;
  if (fs.existsSync(packageJsonPath)) {
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    } catch {
      throw new Error("Invalid 'package.json' in repository root.");
    }
  }

  // Check 1: Vite
  const hasViteDep =
    Boolean(packageJson?.dependencies?.['vite']) ||
    Boolean(packageJson?.devDependencies?.['vite']);
  const hasViteConfig = [
    'vite.config.js',
    'vite.config.ts',
    'vite.config.mjs',
    'vite.config.cjs',
  ].some((file) => fs.existsSync(path.join(repoDir, file)));

  if (hasViteDep || hasViteConfig) {
    return {
      name: 'vite',
      buildCommand: packageJson?.scripts?.build ? 'npm run build' : 'npx vite build',
      outputDir: 'dist',
    };
  }

  // Check 2: Create React App
  const hasCraDep =
    Boolean(packageJson?.dependencies?.['react-scripts']) ||
    Boolean(packageJson?.devDependencies?.['react-scripts']);

  if (hasCraDep) {
    return {
      name: 'create-react-app',
      buildCommand: packageJson?.scripts?.build ? 'npm run build' : 'npx react-scripts build',
      outputDir: 'build',
    };
  }

  // Check 3: Plain static with index.html
  if (fs.existsSync(indexPath)) {
    return {
      name: 'static',
      buildCommand: null,
      outputDir: '.',
    };
  }

  throw new Error(
    'Unable to detect framework: repository must be a Vite project, Create React App project, or contain an index.html file in the root directory.'
  );
}
