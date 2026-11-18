#!/usr/bin/env node
import path from 'node:path';
import { createServer } from 'vite';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/runTsWithVite.mjs <script.ts>');
  process.exit(1);
}

const server = await createServer({
  server: { middlewareMode: true },
  logLevel: 'silent',
  optimizeDeps: { noDiscovery: true },
});

try {
  await server.ssrLoadModule(path.resolve(process.cwd(), target));
} finally {
  await server.close();
}
