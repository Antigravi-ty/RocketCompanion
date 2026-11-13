#!/usr/bin/env node
/**
 * scripts/runMultiplayerTestMatrix.ts
 * Runs the MultiClientLoopbackSimulator automated test matrix and prints structured results.
 */

import { MultiClientLoopbackSimulator } from './MultiClientLoopbackSimulator.ts';

const sim = new MultiClientLoopbackSimulator();
const report = sim.runFullMatrix();

console.log('======================================================================');
console.log(' ROCKET COMPANION MULTIPLAYER LOOPBACK TEST MATRIX');
console.log('======================================================================');
for (const r of report.results) {
  const icon = r.passed ? 'PASS' : 'FAIL';
  console.log(` [${icon}] ${r.name} — ${r.detail}`);
}
console.log('----------------------------------------------------------------------');
console.log(` TOTAL: ${report.total} | PASSED: ${report.passed} | FAILED: ${report.failed}`);
console.log('======================================================================');

if (report.failed > 0) {
  process.exit(1);
}
