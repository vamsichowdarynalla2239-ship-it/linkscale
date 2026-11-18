import { NotificationService } from '../apps/api/src/services/notification.service';
import { retryWithBackoff } from '../apps/api/src/utils/resilience';
import { logger } from '../apps/api/src/utils/logger';
import { register } from '../apps/api/src/utils/metrics';
import assert from 'assert';

async function runModule06Drill() {
  console.log('--- Running Module 06 Graceful Degradation & Circuit Breaker Drill ---');
  logger.clearBuffer();

  // Instantiate service with fast test windows (200ms timeout, 400ms resetTimeout, volumeThreshold 5)
  const svc = new NotificationService({
    timeoutMs: 200,
    resetTimeoutMs: 400,
    volumeThreshold: 5,
  });

  // 1. Healthy baseline
  const okRes = await svc.send({
    channel: 'push',
    recipient: 'user-1',
    message: 'Welcome!',
    requestId: 'm6-ok-1',
  });
  assert.strictEqual(okRes.delivered, true);
  assert.strictEqual(okRes.degraded, false);
  assert.strictEqual(svc.getBreakerState(), 'closed');

  // 2. Simulate slow provider -> verify explicit 200ms timeout (does NOT hang 3000ms)
  svc.setSimulatedProviderMode('slow');
  const tSlow = Date.now();
  const slowFallback = await svc.send({
    channel: 'push',
    recipient: 'user-slow',
    message: 'Slow test',
    requestId: 'm6-slow-1',
  });
  const slowElapsed = Date.now() - tSlow;
  console.log(`[Timeout Check] Slow provider fell back in ${slowElapsed}ms (threshold < 600ms, vs 3000ms hang)`);
  assert(slowElapsed < 600, `Expected fast timeout fallback, took ${slowElapsed}ms`);
  assert.strictEqual(slowFallback.degraded, true);
  assert.strictEqual(slowFallback.status, 'queued_fallback');

  // 3. Simulate provider completely DOWN -> hit rapidly until circuit breaker trips OPEN
  svc.setSimulatedProviderMode('down');
  for (let i = 0; i < 6; i++) {
    const res = await svc.send({
      channel: 'email',
      recipient: `user-down-${i}`,
      message: 'Alert',
      requestId: `m6-down-${i}`,
    });
    assert.strictEqual(res.degraded, true);
  }
  assert.strictEqual(svc.getBreakerState(), 'open', 'Circuit breaker must be OPEN after threshold failures');
  const callsWhenOpened = svc.getProviderCallCount();

  // 4. Send 5 more requests while OPEN -> must return instant fallback (< 50ms) with ZERO calls to provider
  const tOpen = Date.now();
  for (let i = 0; i < 5; i++) {
    const fastFallback = await svc.send({
      channel: 'sms',
      recipient: `user-open-${i}`,
      message: 'Fast fallback',
      requestId: `m6-open-${i}`,
    });
    assert.strictEqual(fastFallback.degraded, true);
    assert.strictEqual(fastFallback.status, 'queued_fallback');
  }
  const openBatchElapsed = Date.now() - tOpen;
  console.log(`[Open Circuit Fast Fallback] 5 requests served in ${openBatchElapsed}ms; provider calls delta = ${svc.getProviderCallCount() - callsWhenOpened}`);
  assert(openBatchElapsed < 100, `Expected <100ms for 5 open-circuit fallbacks, took ${openBatchElapsed}ms`);
  assert.strictEqual(svc.getProviderCallCount(), callsWhenOpened, 'Dead provider must NOT be called while circuit is OPEN');

  // 5. Recover provider & wait for resetTimeout -> verify HALF_OPEN -> CLOSED recovery
  svc.setSimulatedProviderMode('healthy');
  await new Promise((r) => setTimeout(r, 450));
  const recoveredRes = await svc.send({
    channel: 'email',
    recipient: 'user-recovered',
    message: 'Back online',
    requestId: 'm6-recovered-1',
  });
  assert.strictEqual(recoveredRes.delivered, true);
  assert.strictEqual(recoveredRes.degraded, false);
  assert.strictEqual(svc.getBreakerState(), 'closed', 'Circuit breaker must transition back to CLOSED after successful half-open probe');

  // 6. Verify retryWithBackoff: retries transient ECONNRESET with backoff + jitter
  let transientAttempts = 0;
  const retryResult = await retryWithBackoff(
    async () => {
      transientAttempts++;
      if (transientAttempts < 3) {
        const err: any = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      return 'recovered-on-attempt-3';
    },
    { maxRetries: 3, baseDelayMs: 30, maxDelayMs: 200, jitterMs: 10, dependency: 'sendgrid', requestId: 'm6-retry-1' }
  );
  assert.strictEqual(retryResult, 'recovered-on-attempt-3');
  assert.strictEqual(transientAttempts, 3);

  // 7. Verify retryWithBackoff: NEVER retries permanent 401 Unauthorized
  let permanentAttempts = 0;
  let caught401 = false;
  try {
    await retryWithBackoff(
      async () => {
        permanentAttempts++;
        const err: any = new Error('Invalid API Key');
        err.statusCode = 401;
        throw err;
      },
      { maxRetries: 3, baseDelayMs: 30, dependency: 'sendgrid', requestId: 'm6-perm-401' }
    );
  } catch (e: any) {
    caught401 = e.statusCode === 401;
  }
  assert.strictEqual(caught401, true);
  assert.strictEqual(permanentAttempts, 1, 'Permanent 401 error must NEVER be retried');

  // 8. Verify logs & Prometheus metrics captured full lifecycle
  const logs = logger.getBuffer();
  assert(logs.some((l) => l.event === 'circuit_opened'), 'Missing circuit_opened log');
  assert(logs.some((l) => l.event === 'circuit_open_fallback'), 'Missing circuit_open_fallback log');
  assert(logs.some((l) => l.event === 'circuit_half_open'), 'Missing circuit_half_open log');
  assert(logs.some((l) => l.event === 'circuit_closed'), 'Missing circuit_closed log');
  assert(logs.some((l) => l.event === 'retry_attempt'), 'Missing retry_attempt log');

  const metricsText = await register.metrics();
  assert(metricsText.includes('circuit_breaker_state{dependency="notification_provider"} 0'));
  assert(metricsText.includes('circuit_breaker_fallbacks_total{dependency="notification_provider"}'));

  console.log('✅ ALL MODULE 06 GRACEFUL DEGRADATION & CIRCUIT BREAKER DRILLS PASSED!');
  process.exit(0);
}

runModule06Drill().catch((err) => {
  console.error('❌ Module 06 drill failed:', err);
  process.exit(1);
});
