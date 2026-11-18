import { createApp } from '../apps/api/src/app';
import { prisma } from '../apps/api/src/db';
import { exec } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import assert from 'assert';

const execAsync = promisify(exec);

async function testRunbookCommands() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`--- Testing HighErrorRate Runbook Verbatim on ${baseUrl} ---`);

  // Inject failure: 500 errors + simulated DB outage
  const origQuery = prisma.$queryRawUnsafe.bind(prisma);
  (prisma as any).$queryRawUnsafe = async () => {
    throw new Error('ECONNREFUSED postgres:5432');
  };

  for (let i = 0; i < 3; i++) {
    await fetch(`${baseUrl}/debug/simulate-error`);
  }

  // Test Runbook Diagnosis Step 1 verbatim (curl.exe /ready)
  const { stdout: step1Out } = await execAsync(`curl.exe -sS -w "\\nhttp_code=%{http_code}\\n" ${baseUrl}/ready`);
  console.log('[Diagnosis Step 1 Output]:\n' + step1Out.trim());
  assert(step1Out.includes('http_code=503'), 'Step 1 should show http_code=503');
  assert(step1Out.includes('Database dependency unavailable'), 'Step 1 should show Database dependency unavailable');

  // Test Runbook Diagnosis Step 2 (check metrics 5xx filtering)
  const { stdout: metricsRaw } = await execAsync(`curl.exe -sS ${baseUrl}/metrics`);
  const fiveXxLines = metricsRaw
    .split('\n')
    .filter((l) => l.startsWith('http_requests_total{') && /status="5\d\d"/.test(l));
  console.log('[Diagnosis Step 2 5xx Lines]:\n' + fiveXxLines.join('\n'));
  assert(fiveXxLines.length >= 2, 'Expected both /debug/simulate-error 500 and /ready 503 counters');

  // Simulate Fix: Restore DB
  (prisma as any).$queryRawUnsafe = origQuery;

  // Test Runbook Verification Step 1 (curl.exe /live)
  const { stdout: verifyLive } = await execAsync(`curl.exe -sS -w "\\nhttp_code=%{http_code}\\n" ${baseUrl}/live`);
  console.log('[Verification /live Output]:\n' + verifyLive.trim());
  assert(verifyLive.includes('http_code=200'));
  assert(verifyLive.includes('"status":"healthy"'));

  server.close();
  console.log('✅ RUNBOOK LIVE EXECUTION TEST PASSED!');
  process.exit(0);
}

testRunbookCommands().catch((err) => {
  console.error('❌ Runbook test failed:', err);
  process.exit(1);
});
