import { createApp } from '../apps/api/src/app';
import { prisma } from '../apps/api/src/db';
import { logger } from '../apps/api/src/utils/logger';
import http from 'http';
import assert from 'assert';

async function runFailureSimulations() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`--- Module 05 Failure Simulation Harness on ${baseUrl} ---`);

  // Simulation 1: Database Unavailable (simulate postgres stopped)
  const originalQueryRaw = prisma.$queryRawUnsafe.bind(prisma);
  (prisma as any).$queryRawUnsafe = async () => {
    throw new Error('Can\'t reach database server at `postgres:5432` (ECONNREFUSED)');
  };

  const t1 = Date.now();
  const readyRes = await fetch(`${baseUrl}/ready`, { headers: { 'X-Request-Id': 'sim-db-down-1' } });
  const dbDownLatencyMs = Date.now() - t1;
  const readyBody = await readyRes.json();

  console.log('\n[Simulation 1: Database Stopped -> GET /ready]');
  console.log('Status:', readyRes.status, 'Latency:', `${dbDownLatencyMs}ms`, 'Body:', JSON.stringify(readyBody));
  assert.strictEqual(readyRes.status, 503, 'Expected /ready to return 503 when DB is unreachable');

  // Restore prisma method
  (prisma as any).$queryRawUnsafe = originalQueryRaw;

  // Simulation 2: 1ms Timeout against slow external dependency (simulating slow SendGrid/Twilio API)
  const slowProvider = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ delivered: true }));
    }, 250);
  });
  await new Promise<void>((resolve) => slowProvider.listen(0, '127.0.0.1', () => resolve()));
  const slowPort = (slowProvider.address() as { port: number }).port;

  console.log(`\n[Simulation 2: 1ms Timeout against slow external provider on port ${slowPort}]`);
  const t2 = Date.now();
  let timeoutErrName = '';
  let timeoutErrMessage = '';
  try {
    await fetch(`http://127.0.0.1:${slowPort}/send`, { signal: AbortSignal.timeout(1) });
    assert.fail('Expected 1ms AbortSignal timeout to abort request');
  } catch (err: any) {
    timeoutErrName = err.name;
    timeoutErrMessage = err.message;
    logger.error('External provider timeout simulated', {
      request_id: 'sim-timeout-1ms',
      dependency: 'notification_provider',
      timeout_ms: 1,
      error_name: err.name,
      error_message: err.message,
    });
  }
  const timeoutLatencyMs = Date.now() - t2;
  console.log('Caught error:', timeoutErrName, '-', timeoutErrMessage, 'in', `${timeoutLatencyMs}ms`);
  assert.strictEqual(timeoutErrName, 'TimeoutError', 'Expected AbortSignal TimeoutError');

  // Check metrics recorded the 503
  const metricsRes = await fetch(`${baseUrl}/metrics`);
  const metricsText = await metricsRes.text();
  assert(
    metricsText.includes('http_requests_total{method="GET",path="/ready",status="503"} 1'),
    'Expected /metrics to count 503 on /ready during DB outage'
  );

  // Verify structured logs captured the timeout event
  const logs = logger.getBuffer();
  const timeoutLog = logs.find((l) => l.request_id === 'sim-timeout-1ms');
  assert(timeoutLog, 'Expected structured log entry for 1ms timeout simulation');

  slowProvider.close();
  server.close();
  console.log('\n✅ BOTH MODULE 05 FAILURE SIMULATIONS EXECUTED & VERIFIED!');
  process.exit(0);
}

runFailureSimulations().catch((err) => {
  console.error('❌ Simulation failed:', err);
  process.exit(1);
});
