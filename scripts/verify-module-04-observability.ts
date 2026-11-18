import { createApp } from '../apps/api/src/app';
import { logger } from '../apps/api/src/utils/logger';
import http from 'http';
import fs from 'fs';
import assert from 'assert';

async function runDrill() {
  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  console.log(`Observability verification server listening on ${baseUrl}`);

  // 1. Send 10 mixed requests
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${baseUrl}/live`, { headers: { 'X-Request-Id': `req-live-${i}` } });
    assert.strictEqual(r.status, 200);
  }
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${baseUrl}/health`, { headers: { 'X-Request-Id': `req-health-${i}` } });
    assert.strictEqual(r.status, 200);
  }
  const notFound = await fetch(`${baseUrl}/unknown-route`, { headers: { 'X-Request-Id': 'req-404-1' } });
  assert.strictEqual(notFound.status, 404);

  // 2. Trigger 500 error
  const errRes = await fetch(`${baseUrl}/debug/simulate-error`, {
    headers: { 'X-Request-Id': 'req-500-drill' },
  });
  assert.strictEqual(errRes.status, 500);

  // 3. Verify GET /metrics
  const metricsRes = await fetch(`${baseUrl}/metrics`);
  assert.strictEqual(metricsRes.status, 200);
  const metricsText = await metricsRes.text();

  assert(metricsText.includes('http_requests_total'), 'Missing http_requests_total metric');
  assert(
    metricsText.includes('http_requests_total{method="GET",path="/live",status="200"} 6'),
    'Expected 6 GET /live 200 requests in http_requests_total'
  );
  assert(
    metricsText.includes('http_requests_total{method="GET",path="/debug/simulate-error",status="500"} 1'),
    'Expected 1 GET /debug/simulate-error 500 request in http_requests_total'
  );
  assert(
    metricsText.includes('http_request_duration_seconds_bucket'),
    'Missing http_request_duration_seconds histogram buckets'
  );
  assert(
    metricsText.includes('http_requests_in_flight'),
    'Missing http_requests_in_flight gauge'
  );
  assert(
    metricsText.includes('notification_queue_depth{channel="email"} 0'),
    'Missing notification_queue_depth business gauge'
  );

  // 4. Verify structured logs in memory buffer
  const logs = logger.getBuffer();
  const errorLog = logs.find((l) => l.level === 'error' && l.request_id === 'req-500-drill');
  assert(errorLog, 'Expected structured error log with request_id req-500-drill');
  assert(errorLog.timestamp, 'Missing ISO timestamp');
  assert.strictEqual(errorLog.service_name, 'linkscale', 'Missing service_name field');
  assert(errorLog.message, 'Missing message field');

  const liveLog = logs.find((l) => l.level === 'info' && l.request_id === 'req-live-0');
  assert(liveLog, 'Expected structured info log with request_id req-live-0');
  assert.strictEqual(liveLog.service_name, 'linkscale');

  // 5. Verify alert rules file
  const alertsYml = fs.readFileSync('infra/alerts.yml', 'utf8');
  assert(alertsYml.includes('alert: HighErrorRate'), 'Missing HighErrorRate alert');
  assert(alertsYml.includes('alert: HighLatency'), 'Missing HighLatency alert');
  assert(alertsYml.includes('alert: ServiceDown'), 'Missing ServiceDown alert');

  server.close();
  console.log('Metrics sample verified:');
  console.log(
    metricsText
      .split('\n')
      .filter((line) => line.startsWith('http_requests_total{'))
      .join('\n')
  );
  console.log('Error log verified:', JSON.stringify(errorLog));
  console.log('✅ ALL MODULE 04 OBSERVABILITY CHECKS PASSED!');
  process.exit(0);
}

runDrill().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
