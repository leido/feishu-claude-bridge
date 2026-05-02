import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: [
    // SDK must stay external — it spawns a CLI subprocess and resolves
    // dist/cli.js relative to its own package location.
    '@anthropic-ai/claude-agent-sdk',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire } from 'module'; import { fileURLToPath } from 'url'; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = require('path').dirname(__filename);" },
});

console.log('Built dist/daemon.mjs');
