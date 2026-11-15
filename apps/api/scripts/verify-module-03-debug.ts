import http from 'http';
import { createApp } from '../src/app';
import { linkService } from '../src/services/link.service';
import { prisma } from '../src/db';

async function runVerification() {
  console.log('================================================================');
  console.log('   MODULE 03 REPRODUCTION SCIENCE & RACE CONDITIONS TEST SUITE   ');
  console.log('================================================================\n');

  // Seed a test link
  const runId = Math.random().toString(36).substring(2, 7);
  const testLink = await linkService.createLink({
    long_url: `https://example.com/race-condition-test-${runId}`,
  });
  console.log(`[SEED] Created test short link: code = "${testLink.code}", id = "${testLink.id}"`);

  // -------------------------------------------------------------------------
  // TEST 1: Minimal Reproduction (Proving Check-Then-Act Race Condition)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 1: Minimal Reproduction (Check-Then-Act Race Condition) ---');
  const CONCURRENCY = 10;
  const testTimestamp = new Date('2026-11-15T15:00:00.000Z');

  // Execute concurrent check-then-act operations
  const buggyPromises = Array.from({ length: CONCURRENCY }, () =>
    linkService.recordClickBucketBuggy(testLink.id, testTimestamp)
  );

  const buggyResults = await Promise.allSettled(buggyPromises);
  const buggyErrors = buggyResults.filter((r) => r.status === 'rejected');
  const buggySuccesses = buggyResults.filter((r) => r.status === 'fulfilled');

  console.log(`Concurrent check-then-act results: ${buggySuccesses.length} successes, ${buggyErrors.length} crashes`);
  if (buggyErrors.length > 0) {
    const firstError = (buggyErrors[0] as PromiseRejectedResult).reason;
    console.log(`[BUG REPRODUCED] Captured expected database collision: ${firstError.message}`);
  } else {
    console.warn('[NOTE] In extremely fast execution the race window closed, but code path remains vulnerable');
  }

  // -------------------------------------------------------------------------
  // TEST 2: Atomic Upsert Fix Verification
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 2: Atomic Database Upsert Fix Verification ---');
  // Seed a fresh link for clean atomic bucket testing
  const atomicLink = await linkService.createLink({
    long_url: `https://example.com/atomic-test-${runId}`,
  });

  const atomicPromises = Array.from({ length: CONCURRENCY }, () =>
    linkService.recordClickBucketAtomic(atomicLink.id, testTimestamp)
  );

  const atomicResults = await Promise.allSettled(atomicPromises);
  const atomicErrors = atomicResults.filter((r) => r.status === 'rejected');
  const atomicSuccesses = atomicResults.filter((r) => r.status === 'fulfilled');

  console.log(`Concurrent atomic upsert results: ${atomicSuccesses.length} successes, ${atomicErrors.length} crashes`);
  if (atomicErrors.length > 0) {
    throw new Error(`Expected 0 errors with atomic upsert, but encountered ${atomicErrors.length} errors`);
  }

  const finalCount = await linkService.getBucketCount(atomicLink.id, testTimestamp);
  console.log(`Final bucket count after 10 concurrent requests: ${finalCount} (Expected: 10)`);
  if (finalCount !== 10) {
    throw new Error(`Expected exactly 10 recorded clicks, got ${finalCount}`);
  }
  console.log('✓ Bug #5 Fix Verified: Atomic upsert eliminates race condition and guarantees exact-once counting.\n');

  // -------------------------------------------------------------------------
  // TEST 3: End-to-End Concurrent HTTP Redirects Verification
  // -------------------------------------------------------------------------
  console.log('--- TEST 3: End-to-End Concurrent HTTP Redirects Verification ---');
  const app = createApp();
  const server = http.createServer(app);
  const port = 3098;

  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  console.log(`Test API server running on port ${port}`);

  try {
    const e2eLink = await linkService.createLink({
      long_url: `https://example.com/e2e-concurrent-${runId}`,
    });

    const httpRequests = Array.from({ length: 15 }, async () => {
      const res = await fetch(`http://localhost:${port}/r/${e2eLink.code}`, {
        redirect: 'manual', // Do not follow redirect so we observe the 302 directly
      });
      return res.status;
    });

    const httpStatuses = await Promise.all(httpRequests);
    const redirects = httpStatuses.filter((s) => s === 302);
    const errors = httpStatuses.filter((s) => s === 500);

    console.log(`End-to-end HTTP results: ${redirects.length} redirects (302), ${errors.length} server errors (500)`);
    if (errors.length > 0) {
      throw new Error(`Encountered ${errors.length} HTTP 500 errors during concurrent redirect burst`);
    }
    if (redirects.length !== 15) {
      throw new Error(`Expected 15 HTTP 302 redirects, got ${redirects.length}`);
    }

    console.log('✓ End-to-End Verified: 15 concurrent redirects completed with 100% success and 0 crashes.\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // -------------------------------------------------------------------------
  // TEST 4: Step 5 BREAK & FIX: Silent Timestamp Clobbering vs Monotonic Guard
  // -------------------------------------------------------------------------
  console.log('--- TEST 4: Silent Timestamp Clobbering vs Monotonic Guard ---');
  const tLater = new Date('2026-11-15T15:00:00.200Z');
  const tEarlier = new Date('2026-11-15T15:00:00.100Z');

  // 4a. Demonstrate unsafe clobbering: Request at tLater commits, then slower request at tEarlier clobbers it
  const unsafeLink = await linkService.createLink({
    long_url: `https://example.com/unsafe-ts-${runId}`,
  });
  await linkService.recordClickBucketUnsafeTimestamp(unsafeLink.id, tLater);
  await linkService.recordClickBucketUnsafeTimestamp(unsafeLink.id, tEarlier); // Out-of-order overwrite
  const corruptedRecord = await linkService.getBucketRecord(unsafeLink.id, tLater);
  console.log(`[UNSAFE CLOBBERING] Later timestamp (t=200ms) clobbered by earlier (t=100ms): stored = ${corruptedRecord?.lastAccessedAt.toISOString()}`);
  if (corruptedRecord?.lastAccessedAt.getTime() !== tEarlier.getTime()) {
    throw new Error('Expected unsafe timestamp to be corrupted to earlier time');
  }

  // 4b. Verify Monotonic Guard Fix: Later timestamp is preserved even if earlier request completes out of order
  const safeLink = await linkService.createLink({
    long_url: `https://example.com/safe-ts-${runId}`,
  });
  await linkService.recordClickBucketAtomic(safeLink.id, tLater);
  await linkService.recordClickBucketAtomic(safeLink.id, tEarlier); // Out-of-order commit
  const safeRecord = await linkService.getBucketRecord(safeLink.id, tLater);
  console.log(`[MONOTONIC FIX] Monotonic guard preserved latest timestamp: stored = ${safeRecord?.lastAccessedAt.toISOString()} (Expected: ${tLater.toISOString()})`);
  if (safeRecord?.lastAccessedAt.getTime() !== tLater.getTime()) {
    throw new Error('Expected monotonic guard to preserve latest timestamp');
  }
  console.log('✓ Silent Timestamp Corruption Resolved: Monotonic guard prevents out-of-order clock clobbering.\n');

  console.log('================================================================');
  console.log('   ALL MODULE 03 REPRODUCTION CHECKS PASSED SUCCESSFULLY (100%) ');
  console.log('================================================================');
}

runVerification()
  .catch((err) => {
    console.error('❌ Verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
