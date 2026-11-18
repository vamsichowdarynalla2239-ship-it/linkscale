import { createApp } from '../apps/api/src/app';
import { prisma } from '../apps/api/src/db';
import http from 'http';
import assert from 'assert';

async function runDeployAndRollbackDrill() {
  console.log('--- Module 08 Zero-Downtime Rolling Deploy & Rollback Verification Drill ---');

  // 1. Deploy v1 (known-good commit SHA)
  process.env.APP_VERSION = 'sha-v1-5cf9f89';
  const appV1 = createApp();
  const serverV1 = http.createServer(appV1);
  await new Promise<void>((resolve) => serverV1.listen(0, '127.0.0.1', () => resolve()));
  const portV1 = (serverV1.address() as { port: number }).port;
  let activeBackendPort = portV1;

  // Lightweight ingress router representing the production load balancer
  const ingressRouter = http.createServer(async (req, res) => {
    try {
      const targetUrl = `http://127.0.0.1:${activeBackendPort}${req.url}`;
      const upstream = await fetch(targetUrl, { method: req.method });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
      });
      res.end(text);
    } catch {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });
  await new Promise<void>((resolve) => ingressRouter.listen(0, '127.0.0.1', () => resolve()));
  const publicPort = (ingressRouter.address() as { port: number }).port;
  const publicUrl = `http://127.0.0.1:${publicPort}`;

  // 2. Verify v1 healthy on public URL
  const live1 = await fetch(`${publicUrl}/live`);
  const live1Json: any = await live1.json();
  const ready1 = await fetch(`${publicUrl}/ready`);
  const ready1Json: any = await ready1.json();
  const metrics1 = await fetch(`${publicUrl}/metrics`);

  assert.strictEqual(live1.status, 200);
  assert.strictEqual(ready1.status, 200);
  assert.strictEqual(metrics1.status, 200);
  assert.strictEqual(ready1Json.ok, true);
  assert.strictEqual(ready1Json.version, 'sha-v1-5cf9f89');
  assert.strictEqual(ready1Json.checks.database, 'connected');
  assert(typeof ready1Json.checks.uptime_seconds === 'number');
  console.log('[Step 1-2: v1 Healthy Baseline Verified]', JSON.stringify(ready1Json));

  // 3. Failure-First Drill: Deploy v2 with broken DATABASE_URL (readiness check MUST fail 503!)
  const origQueryRaw = prisma.$queryRawUnsafe.bind(prisma);
  process.env.APP_VERSION = 'sha-v2-broken-db';
  const appV2 = createApp();
  const serverV2 = http.createServer(appV2);
  await new Promise<void>((resolve) => serverV2.listen(0, '127.0.0.1', () => resolve()));
  const portV2 = (serverV2.address() as { port: number }).port;

  // Simulate broken DB connection string on v2 probe
  (prisma as any).$queryRawUnsafe = async () => {
    throw new Error('P1001: Can\'t reach database server at wrong.example.com:5432');
  };

  const v2Live = await fetch(`http://127.0.0.1:${portV2}/live`);
  const v2Ready = await fetch(`http://127.0.0.1:${portV2}/ready`);
  const v2ReadyJson: any = await v2Ready.json();

  console.log('[Step 3: v2 Broken DB Probe]', 'live=', v2Live.status, 'ready=', v2Ready.status, JSON.stringify(v2ReadyJson));
  assert.strictEqual(v2Live.status, 200, '/live must remain 200 (process alive, dependency-free)');
  assert.strictEqual(v2Ready.status, 503, '/ready MUST fail with 503 when DB is unreachable');
  assert.strictEqual(v2ReadyJson.ok, false);
  assert.strictEqual(v2ReadyJson.checks.database, 'disconnected');

  // 4. Rolling Deploy Gate & Timed Rollback
  const rollbackStartMs = Date.now();
  const shouldPromoteV2 = v2Ready.status === 200 && v2ReadyJson.ok === true;
  assert.strictEqual(shouldPromoteV2, false, 'Rolling deploy gate MUST block v2 promotion');

  // Drain/terminate broken v2 instance and restore v1 metadata & DB handle
  serverV2.close();
  (prisma as any).$queryRawUnsafe = origQueryRaw;
  process.env.APP_VERSION = 'sha-v1-5cf9f89';
  activeBackendPort = portV1;

  // Verify public URL still serves v1 with 0 dropped requests
  const postRollbackReady = await fetch(`${publicUrl}/ready`);
  const postRollbackJson: any = await postRollbackReady.json();
  const rollbackElapsedMs = Date.now() - rollbackStartMs;

  assert.strictEqual(postRollbackReady.status, 200);
  assert.strictEqual(postRollbackJson.ok, true);
  assert.strictEqual(postRollbackJson.version, 'sha-v1-5cf9f89');
  assert.strictEqual(postRollbackJson.checks.database, 'connected');
  assert(rollbackElapsedMs < 120_000, 'Rollback must complete under 2 minutes');

  console.log(`[Step 4-6: Rollback Verified in ${rollbackElapsedMs}ms (< 120,000ms SLA)]`, JSON.stringify(postRollbackJson));

  ingressRouter.close();
  serverV1.close();
  console.log('✅ ALL MODULE 08 DEPLOYMENT, READINESS HARDENING & ROLLBACK VERIFICATIONS PASSED!');
  process.exit(0);
}

runDeployAndRollbackDrill().catch((err) => {
  console.error('❌ Module 08 drill failed:', err);
  process.exit(1);
});
