import assert from 'assert';

const BASE_URL = process.env.RAILWAY_URL || 'https://linkscale-api-production.up.railway.app';
const API_KEY_A = process.env.BOOTSTRAP_API_KEY_A || '';
const API_KEY_B = process.env.BOOTSTRAP_API_KEY_B || '';

async function runLiveVerification() {
  console.log(`\n=============================================================`);
  console.log(`LINKSCALE LIVE PRODUCTION VERIFICATION SUITE`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`=============================================================\n`);

  // 1. GET /live
  const tLive = Date.now();
  const liveRes = await fetch(`${BASE_URL}/live`);
  const liveMs = Date.now() - tLive;
  const liveJson: any = await liveRes.json();
  assert.strictEqual(liveRes.status, 200, `Expected /live 200, got ${liveRes.status}`);
  assert.strictEqual(liveJson.ok, true);
  console.log(`[PASS] 1. GET /live -> 200 OK (${liveMs}ms) | version=${liveJson.version} uptime=${liveJson.uptime_seconds}s`);

  // 2. GET /ready (PostgreSQL + Redis connectivity)
  const tReady = Date.now();
  const readyRes = await fetch(`${BASE_URL}/ready`);
  const readyMs = Date.now() - tReady;
  const readyJson: any = await readyRes.json();
  assert.strictEqual(readyRes.status, 200, `Expected /ready 200, got ${readyRes.status}: ${JSON.stringify(readyJson)}`);
  assert.strictEqual(readyJson.ok, true);
  assert.strictEqual(readyJson.checks.database, 'connected', 'Expected PostgreSQL connected');
  assert.strictEqual(readyJson.checks.cache, 'connected', 'Expected Redis cache connected');
  console.log(
    `[PASS] 2. GET /ready -> 200 OK (${readyMs}ms) | db=${readyJson.checks.database} cache=${readyJson.checks.cache} fingerprint=${readyJson.checks.config_fingerprint}`
  );

  // 3. GET /metrics (Prometheus RED metrics)
  const metricsRes = await fetch(`${BASE_URL}/metrics`);
  const metricsText = await metricsRes.text();
  assert.strictEqual(metricsRes.status, 200, `Expected /metrics 200, got ${metricsRes.status}`);
  assert(metricsText.includes('http_requests_total'), 'Missing http_requests_total');
  assert(metricsText.includes('http_request_duration_seconds_bucket'), 'Missing http_request_duration_seconds');
  assert(metricsText.includes('circuit_breaker_state'), 'Missing circuit_breaker_state');
  assert(metricsText.includes('notification_queue_depth'), 'Missing notification_queue_depth');
  console.log(`[PASS] 3. GET /metrics -> 200 OK | Prometheus RED counters, histograms & resilience gauges verified`);

  // 4. End-to-end link creation (Tenant Alpha)
  const createRes = await fetch(`${BASE_URL}/links`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY_A,
    },
    body: JSON.stringify({
      longUrl: 'https://github.com/vamsichowdarynalla2239-ship-it/linkscale',
      tags: ['production-smoke', 'railway'],
    }),
  });
  const createdLink: any = await createRes.json();
  assert.strictEqual(createRes.status, 201, `Expected POST /links 201, got ${createRes.status}: ${JSON.stringify(createdLink)}`);
  const linkId = createdLink.id;
  const code = createdLink.code;
  console.log(`[PASS] 4. POST /links (Tenant Alpha) -> 201 Created | id=${linkId} code=${code}`);

  // 5. Cache-Aside Redirect (X-Cache: MISS -> HIT)
  const tMiss = Date.now();
  const r1 = await fetch(`${BASE_URL}/r/${code}`, { redirect: 'manual' });
  const missMs = Date.now() - tMiss;
  const xCache1 = r1.headers.get('x-cache');
  const loc1 = r1.headers.get('location');
  assert.strictEqual(r1.status, 302, `Expected 302 redirect, got ${r1.status}`);
  assert.strictEqual(loc1, 'https://github.com/vamsichowdarynalla2239-ship-it/linkscale');
  assert.strictEqual(xCache1, 'MISS', `Expected 1st redirect X-Cache=MISS, got ${xCache1}`);

  const tHit = Date.now();
  const r2 = await fetch(`${BASE_URL}/r/${code}`, { redirect: 'manual' });
  const hitMs = Date.now() - tHit;
  const xCache2 = r2.headers.get('x-cache');
  assert.strictEqual(r2.status, 302);
  assert.strictEqual(xCache2, 'HIT', `Expected 2nd redirect X-Cache=HIT, got ${xCache2}`);
  console.log(`[PASS] 5. GET /r/${code} -> 302 Found | Cache-Aside X-Cache: MISS (${missMs}ms) -> HIT (${hitMs}ms)`);

  // 6. Multi-tenant Isolation (Anti-IDOR 404 Check + 401 Unauthenticated Check)
  const ownerGet = await fetch(`${BASE_URL}/links/${linkId}`, { headers: { 'x-api-key': API_KEY_A } });
  assert.strictEqual(ownerGet.status, 200, `Expected owner GET 200, got ${ownerGet.status}`);

  const crossTenantGet = await fetch(`${BASE_URL}/links/${linkId}`, { headers: { 'x-api-key': API_KEY_B } });
  assert.strictEqual(crossTenantGet.status, 404, `Expected cross-tenant anti-IDOR 404, got ${crossTenantGet.status}`);

  const unauthGet = await fetch(`${BASE_URL}/links/${linkId}`);
  assert.strictEqual(unauthGet.status, 401, `Expected unauthenticated 401, got ${unauthGet.status}`);
  console.log(`[PASS] 6. Multi-Tenant Isolation -> Owner=200, Cross-Tenant Anti-IDOR=404, Unauth=401`);

  // 7. Resilient Notification Delivery (Circuit Breaker Endpoint)
  const notifyRes = await fetch(`${BASE_URL}/notifications/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: 'email',
      recipient: 'verify@linkscale.internal',
      message: 'Live Railway production smoke check',
    }),
  });
  const notifyJson: any = await notifyRes.json();
  assert(notifyRes.status === 200 || notifyRes.status === 202, `Expected 200/202, got ${notifyRes.status}`);
  console.log(`[PASS] 7. POST /notifications/send -> ${notifyRes.status} | status=${notifyJson.status} provider=${notifyJson.provider}`);

  // 8. Cache Eviction on Delete (Clean up test record + verify instant 404)
  const delRes = await fetch(`${BASE_URL}/links/${linkId}`, {
    method: 'DELETE',
    headers: { 'x-api-key': API_KEY_A },
  });
  assert.strictEqual(delRes.status, 204, `Expected DELETE 204, got ${delRes.status}`);

  const postDelRedirect = await fetch(`${BASE_URL}/r/${code}`, { redirect: 'manual' });
  assert.strictEqual(postDelRedirect.status, 404, `Expected 404 immediately after delete eviction, got ${postDelRedirect.status}`);
  console.log(`[PASS] 8. DELETE /links/${linkId} -> 204 No Content & Immediate Cache Eviction (GET /r/${code} -> 404)`);

  console.log(`\n=============================================================`);
  console.log(`ALL 8/8 LIVE RAILWAY PRODUCTION VERIFICATION GATES PASSED!`);
  console.log(`=============================================================\n`);
}

runLiveVerification().catch((err) => {
  console.error('\n❌ LIVE VERIFICATION FAILED:', err);
  process.exit(1);
});
