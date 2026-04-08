#!/usr/bin/env node
/**
 * Docker build script.
 * Bundles most deps into dist/ — only express/cors/node builtins are external.
 * Uses tsc for type-checking, vite for the widget HTML, esbuild for server bundle.
 */
import { execSync } from 'child_process';
import { renameSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function run(cmd, env = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

rmSync(join(root, 'dist'), { recursive: true, force: true });

// 1. Type-check
run('tsc --noEmit');

// 2. Vite build (singlefile HTML widget)
run('vite build');

// 3. Move the HTML output to dist root
const htmlSrc = join(root, 'dist', 'src', 'mcp-app.html');
const htmlDst = join(root, 'dist', 'mcp-app.html');
if (existsSync(htmlSrc)) {
  renameSync(htmlSrc, htmlDst);
  rmSync(join(root, 'dist', 'src'), { recursive: true, force: true });
}

// 4. Build server types
run('tsc -p tsconfig.server.json');

// CJS packages (express ecosystem) must stay external when bundling as ESM.
// They're small and get installed via `pnpm install --prod` in the runtime stage.
const cjsExternals = ['express', 'cors', 'ioredis'].map((p) => `--external:${p}`).join(' ');

// 5. Bundle server + entry into dist/
run(
  `npx esbuild src/main.ts --bundle --platform=node --format=esm --outfile=dist/index.js --banner:js="#!/usr/bin/env node" --external:node:* ${cjsExternals}`,
);
run(
  `npx esbuild src/server.ts --bundle --platform=node --format=esm --outfile=dist/server.js --external:node:* ${cjsExternals}`,
);

console.log('Build complete: dist/server.js, dist/index.js');
