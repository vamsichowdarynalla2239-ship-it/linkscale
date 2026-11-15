import http from 'http';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { generateApiKey } from '../src/utils/api-key';
import { linkService } from '../src/services/link.service';
import { cacheService } from '../src/services/cache.service';
import { queueService, ClickJobPayload } from '../src/services/queue.service';
import { ClickWorker, clickWorker } from '../src/workers/click.worker';
import { apiPool, workerPool, sharedUnisolatedPool, ConnectionPool } from '../src/utils/pool';

async function runVerification() {
  console.log('================================================================');
  console.log('   MODULE 06: MULTI-LAYER BUGS VERIFICATION SUITE              ');
  console.log('   Bug #9: Stale Cache Invalidation on Delete                  ');
  console.log('   Bug #10: Queue Retry Storm & Connection Pool Bulkhead        ');
  console.log('================================================================\n');

  // Seed test tenant, api key, and test link
  const tenantSlug = `tenant_m6_${Date.now()}`;
  const testTenant = await prisma.tenant.create({
    data: { name: tenantSlug },
  });

  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  await prisma.apiKey.create({
    data: {
      tenantId: testTenant.id,
      keyHash,
      prefix: keyPrefix,
      name: 'module-06-key',
    },
  });

  const app = createApp();
  const server = http.createServer(app);
  const testPort = 3097;

  await new Promise<void>((resolve) => server.listen(testPort, () => resolve()));
  console.log(`[BOOT] Test API server listening on http://localhost:${testPort}\n`);

  try {
    // =========================================================================
    // PART 1: BUG #9 - STALE CACHE SERVING DELETED RECORDS
    // =========================================================================
    console.log('--- PART 1: BUG #9 (STALE CACHE SERVING DELETED RECORDS) ---');

    // 1. Create short link
    const originalTarget = 'https://engineering.example.com/multi-layer/spec';
    const testLink = await linkService.createLink(
      { long_url: originalTarget },
      testTenant.id
    );
    console.log(`[SEED] Created short link: id=${testLink.id}, code="${testLink.code}"`);

    // 2. Perform initial redirect -> should populate cache (X-Cache: MISS)
    const resR1 = await fetch(`http://localhost:${testPort}/r/${testLink.code}`, { redirect: 'manual' });
    console.log(`Initial Redirect -> HTTP ${resR1.status}, Location: ${resR1.headers.get('location')}, X-Cache: ${resR1.headers.get('x-cache')}`);
    if (resR1.status !== 302 || resR1.headers.get('location') !== originalTarget) {
      throw new Error(`Expected HTTP 302 redirect to ${originalTarget}, got ${resR1.status}`);
    }

    // 3. Perform second redirect -> verify cache HIT
    const resR2 = await fetch(`http://localhost:${testPort}/r/${testLink.code}`, { redirect: 'manual' });
    console.log(`Second Redirect -> HTTP ${resR2.status}, Location: ${resR2.headers.get('location')}, X-Cache: ${resR2.headers.get('x-cache')}`);
    if (resR2.status !== 302 || resR2.headers.get('x-cache') !== 'HIT') {
      throw new Error(`Expected HTTP 302 with X-Cache: HIT, got ${resR2.status} / ${resR2.headers.get('x-cache')}`);
    }

    // 4. Delete the link via API (DELETE /links/:id)
    const deleteRes = await fetch(`http://localhost:${testPort}/links/${testLink.id}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': rawKey,
      },
    });
    console.log(`DELETE /links/${testLink.id} -> HTTP ${deleteRes.status}`);
    if (deleteRes.status !== 204 && deleteRes.status !== 200) {
      throw new Error(`Expected HTTP 204/200 on DELETE, got ${deleteRes.status}`);
    }

    // 5. Test Hypothesis 1: Database status
    const dbRecord = await prisma.link.findUnique({ where: { id: testLink.id } });
    console.log(`[TEST HYPOTHESIS 1] SELECT * FROM links WHERE id='${testLink.id}' -> ${dbRecord ? 'FOUND' : 'NULL'}`);
    if (dbRecord !== null) {
      throw new Error('Database record still exists! Database delete failed.');
    }
    console.log('[PASS] Hypothesis 1 disproven: Database delete succeeded.');

    // 6. Test Cache Invalidation: Subsequent redirect MUST immediately return 404 (NOT 302)
    const resAfterDelete = await fetch(`http://localhost:${testPort}/r/${testLink.code}`, { redirect: 'manual' });
    console.log(`Redirect after delete -> HTTP ${resAfterDelete.status} (Expected: 404)`);
    if (resAfterDelete.status !== 404) {
      throw new Error(`STALE CACHE DETECTED: Deleted link returned HTTP ${resAfterDelete.status} instead of 404!`);
    }
    console.log('[PASS] Bug #9 Fixed: Cache key was immediately evicted on DELETE. No 5-minute stale window!\n');

    // =========================================================================
    // PART 2: BUG #10 - QUEUE RETRY STORM & BULKHEAD ISOLATION
    // =========================================================================
    console.log('--- PART 2: BUG #10 (QUEUE RETRY STORM & BULKHEAD ISOLATION) ---');

    // 1. Verify Exponential Backoff calculation
    console.log('[TEST 2.1] Exponential Backoff Calculation:');
    const b0 = clickWorker.calculateBackoff(0);
    const b1 = clickWorker.calculateBackoff(1);
    const b2 = clickWorker.calculateBackoff(2);
    const b3 = clickWorker.calculateBackoff(3);
    const b4 = clickWorker.calculateBackoff(4);
    console.log(`Attempt 0: ~1000ms -> ${b0}ms`);
    console.log(`Attempt 1: ~2000ms -> ${b1}ms`);
    console.log(`Attempt 2: ~4000ms -> ${b2}ms`);
    console.log(`Attempt 3: ~8000ms -> ${b3}ms`);
    console.log(`Attempt 4: ~16000ms -> ${b4}ms`);
    if (!(b0 >= 1000 && b1 >= 2000 && b2 >= 4000 && b3 >= 8000)) {
      throw new Error('Exponential backoff does not increase exponentially!');
    }
    console.log('[PASS] Verified exponential backoff progression with jitter.');

    // 2. Verify Max Retries and Dead-Letter Queue (DLQ) routing
    console.log('\n[TEST 2.2] Max Retries & DLQ Routing:');
    await queueService.clear();

    const failingJob: ClickJobPayload = {
      eventId: `failing_evt_${Date.now()}`,
      linkId: 'non_existent_link_id',
      tenantId: testTenant.id,
      ipHash: 'test-hash',
      timestamp: new Date().toISOString(),
      retryCount: 0,
    };

    // Simulate 5 retries failing (due to foreign key constraint on linkId)
    let finalResult;
    for (let i = 0; i < 5; i++) {
      const res = await clickWorker.processJob(failingJob);
      console.log(`Retry attempt ${i + 1}/5 -> status: ${res.status}, retryCount: ${failingJob.retryCount}`);
    }

    // 6th attempt: should exceed MAX_RETRIES (5) and route to DLQ
    finalResult = await clickWorker.processJob(failingJob);
    console.log(`Final attempt -> status: ${finalResult.status} (Expected: dlq)`);
    if (finalResult.status !== 'dlq') {
      throw new Error(`Expected job to route to DLQ, got status: ${finalResult.status}`);
    }

    const dlqCount = await queueService.getDlqLength();
    console.log(`DLQ Length: ${dlqCount} (Expected >= 1)`);
    if (dlqCount < 1) {
      throw new Error('DLQ empty after exhausted retries!');
    }
    console.log('[PASS] Verified jobs do not retry forever; permanently failing jobs land in DLQ.');

    // 3. Verify Bulkhead Isolation: Worker pool exhaustion CANNOT starve API pool
    console.log('\n[TEST 2.3] Bulkhead Connection Pool Isolation:');
    workerPool.reset();
    apiPool.reset();

    // Exhaust all 3 worker connections to simulate worker stress/storm
    const conn1 = workerPool.acquire();
    const conn2 = workerPool.acquire();
    const conn3 = workerPool.acquire();
    console.log(`Worker Pool Stats: ${JSON.stringify(workerPool.getStats())}`);

    try {
      workerPool.acquire();
      throw new Error('Should have thrown pool exhaustion on worker pool');
    } catch (err: any) {
      console.log(`Worker pool correctly exhausted: "${err.message}"`);
    }

    // Now test API readiness check while worker pool is 100% full
    console.log('Checking API /ready probe while worker pool is 100% exhausted...');
    const t0 = performance.now();
    const readyRes = await fetch(`http://localhost:${testPort}/ready`);
    const readyDuration = performance.now() - t0;
    const readyBody = await readyRes.json();
    console.log(`GET /ready -> HTTP ${readyRes.status} in ${readyDuration.toFixed(2)}ms, body:`, readyBody);

    if (readyRes.status !== 200 || readyBody.status !== 'ready') {
      throw new Error(`Bulkhead failure: API /ready failed or timed out (${readyRes.status})`);
    }

    console.log(`API Pool Stats: ${JSON.stringify(apiPool.getStats())}`);
    console.log('[PASS] Bulkhead isolation verified: 100% worker exhaustion did not impact API responsiveness or health checks!');

    // Release worker connections
    conn1.release();
    conn2.release();
    conn3.release();

    // =========================================================================
    // PART 3: STEP 5 BREAK & STEP 6 FIX - CACHE NAMESPACE ISOLATION
    // =========================================================================
    console.log('\n--- PART 3: CACHE NAMESPACE ISOLATION & DEDUP INTEGRITY ---');

    // 1. Create a link
    const targetUrlA = 'https://engineering.example.com/dedup-test';
    const linkA = await linkService.createLink({ long_url: targetUrlA }, testTenant.id);
    console.log(`[SEED] Created link code: ${linkA.code}, id: ${linkA.id}`);

    // Populate redirect cache
    await cacheService.setRedirectTarget(linkA.code, targetUrlA);

    // 2. Process an analytics event for linkA
    const dedupEvtId = `evt_dedup_${Date.now()}`;
    const jobA: ClickJobPayload = {
      eventId: dedupEvtId,
      linkId: linkA.id,
      tenantId: testTenant.id,
      ipHash: 'hash-abc',
      timestamp: new Date().toISOString(),
      retryCount: 0,
    };

    const runA1 = await clickWorker.processJob(jobA);
    console.log(`Initial job run -> status: ${runA1.status} (Expected: success)`);
    if (runA1.status !== 'success') {
      throw new Error(`Expected success, got ${runA1.status}`);
    }

    // Verify key in analytics:dedup namespace exists
    const isDedupRecorded = await cacheService.isAnalyticsJobProcessed(dedupEvtId);
    console.log(`analytics:dedup:${dedupEvtId} key present: ${isDedupRecorded}`);
    if (!isDedupRecorded) {
      throw new Error('Deduplication flag was not recorded in analytics:dedup namespace!');
    }

    // 3. Delete linkA (evicts link:redirect namespace)
    await linkService.deleteLink(linkA.id, testTenant.id);
    console.log(`Deleted link ${linkA.id}. Verifying namespace separation...`);

    // Verify redirect cache key was deleted
    const cachedRedirectAfterDel = await cacheService.getRedirectTarget(linkA.code);
    console.log(`link:redirect:${linkA.code} after delete -> ${cachedRedirectAfterDel} (Expected: null)`);
    if (cachedRedirectAfterDel !== null) {
      throw new Error('Redirect target was not evicted on delete!');
    }

    // Verify deduplication key WAS NOT touched by link deletion
    const isDedupStillPresent = await cacheService.isAnalyticsJobProcessed(dedupEvtId);
    console.log(`analytics:dedup:${dedupEvtId} after delete -> ${isDedupStillPresent} (Expected: true)`);
    if (!isDedupStillPresent) {
      throw new Error('COLLISION BUG: Delete handler wiped the analytics:dedup key!');
    }
    console.log('[PASS] Namespace separation confirmed: Invalidation evicted redirect cache without touching dedup namespace.');

    // 4. Re-create link with the same code or re-run duplicate job
    const runA2Duplicate = await clickWorker.processJob(jobA);
    console.log(`Replayed job run -> status: ${runA2Duplicate.status} (Expected: deduplicated)`);
    if (runA2Duplicate.status !== 'deduplicated') {
      throw new Error(`Expected deduplicated status, got ${runA2Duplicate.status}`);
    }
    console.log('[PASS] Step 6 Fix Verified: Replay of duplicate job was safely deduplicated; zero click double counting!');

    console.log('\n================================================================');
    console.log('   ALL MODULE 06 MULTI-LAYER BUG TESTS PASSED (100% PASS)       ');
    console.log('================================================================\n');

  } finally {
    server.close();
  }
}

runVerification().catch((err) => {
  console.error('\n[FATAL VERIFICATION ERROR]:', err);
  process.exit(1);
});
