import fs from 'node:fs';
import path from 'node:path';

console.log('[build] Compiling mid-size frontend application...');
const outDir = path.resolve('dist');
const assetsDir = path.join(outDir, 'assets');

fs.mkdirSync(assetsDir, { recursive: true });

// Copy index.html
fs.copyFileSync('index.html', path.join(outDir, 'index.html'));

// Generate bundled JS
const jsContent = `
console.log('App initialized');
const components = ['Header', 'Sidebar', 'Dashboard', 'Metrics', 'Footer'];
components.forEach(c => console.log('Loaded ' + c));
`;
fs.writeFileSync(path.join(assetsDir, 'main.js'), jsContent);

// Generate styles
const cssContent = `
body { font-family: sans-serif; background: #0f172a; color: #f8fafc; }
.card { border-radius: 8px; padding: 16px; background: #1e293b; }
`;
fs.writeFileSync(path.join(assetsDir, 'styles.css'), cssContent);

// Generate SVG icon
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>`;
fs.writeFileSync(path.join(assetsDir, 'logo.svg'), svgContent);

console.log('[build] Build completed. Output generated in dist/');
