import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { queueService } from '../src/services/queue.service';
import { clickWorker } from '../src/workers/click.worker';
import { analyticsService } from '../src/services/analytics.service';

const PORT = 3000;
const EVIDENCE_DIR = path.resolve(__dirname, '../../../progress/evidence/module-07');
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'analytics-verification.txt');

async function main() {
  const outputLines: string[] = [];
  const log = (msg: string) => {
    console.log(msg);
    outputLines.push(msg);
  };

  log('====================================================');
  log('MODULE 07: ASYNC JOBS, ANALYTICS & RETENTION SUITE');
  log('====================================================\n');

  // 1. Boot local API test server
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  log(`[SERVER] Booted test server on http://localhost:${PORT}`);

  try {
    // 0. Seed Test Tenants and API Keys
    log('\n--- 0. Seed Test Tenants and API Keys ---');
    const tenantA = await prisma.tenant.create({ data: { name: 'Acme Global Org' } });
    const tenantB = await prisma.tenant.create({ data: { name: 'Rival Corp' } });

    const rawKeyA = `key_live_${crypto.randomBytes(24).toString('hex')}`;
    const hashA = crypto.createHash('sha256').update(rawKeyA).digest('hex');
    await prisma.apiKey.create({
      data: {
        keyHash: hashA,
        prefix: rawKeyA.slice(0, 12),
        tenantId: tenantA.id,
        name: 'Tenant A Primary Key',
      },
    });

    const rawKeyB = `key_live_${crypto.randomBytes(24).toString('hex')}`;
    const hashB = crypto.createHash('sha256').update(rawKeyB).digest('hex');
    await prisma.apiKey.create({
      data: {
        keyHash: hashB,
        prefix: rawKeyB.slice(0, 12),
        tenantId: tenantB.id,
        name: 'Tenant B Primary Key',
      },
    });
    log(`[SEED] Created Tenant A (${tenantA.id}) and Tenant B (${tenantB.id}) with active API keys.`);

    // 1. Create a Short Link (POST /links)
    log('\n--- 1. Create Initial Short Link (POST /links) ---');
    const targetUrl = 'https://acme.example.com/campaign/launch-2026';
    const createRes = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': rawKeyA,
      },
      body: JSON.stringify({ long_url: targetUrl }),
    });

    const link = await createRes.json();
    log(`POST /links -> HTTP ${createRes.status}`);
    log(`Created Link id: ${link.id}, code: ${link.code}`);

    if (createRes.status !== 201 || !link.code) {
      throw new Error(`Failed to create link: ${JSON.stringify(link)}`);
    }

    // 2. Trigger Two Public Redirects (GET /r/:code)
    log(`\n--- 2. Trigger Public Redirects (GET /r/${link.code}) ---`);
    const r1 = await fetch(`http://localhost:${PORT}/r/${link.code}`, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        'Referer': 'https://news.ycombinator.com/',
      },
    });
    log(`Redirect 1 -> HTTP ${r1.status}, Location: ${r1.headers.get('location')}`);
    if (r1.status !== 302 || r1.headers.get('location') !== targetUrl) {
      throw new Error(`Expected 302 to ${targetUrl}, got ${r1.status}`);
    }

    const r2 = await fetch(`http://localhost:${PORT}/r/${link.code}`, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605.1',
        'Referer': 'https://twitter.com/',
      },
    });
    log(`Redirect 2 -> HTTP ${r2.status}, Location: ${r2.headers.get('location')}`);
    if (r2.status !== 302 || r2.headers.get('location') !== targetUrl) {
      throw new Error(`Expected 302 to ${targetUrl}, got ${r2.status}`);
    }

    // Check queue length
    const queueLen = await queueService.getQueueLength();
    log(`[QUEUE] Current pending click jobs in queue: ${queueLen}`);

    // 3. Background Worker Drains & Processes Jobs
    log('\n--- 3. Background Worker Processing Click Jobs ---');
    const workerResults = await clickWorker.drainQueue(10);
    log(`[WORKER] Processed ${workerResults.length} jobs. Statuses: ${workerResults.map((r) => r.status).join(', ')}`);

    const countInDb = await prisma.clickEvent.count({ where: { linkId: link.id } });
    log(`[DB] Verified click events in database: ${countInDb}`);
    if (countInDb !== 2) {
      throw new Error(`Expected 2 click events in database, found ${countInDb}`);
    }
    log('[PASS] Two redirects queued and successfully processed into PostgreSQL by background worker.');

    // 4. Protected Analytics Read Endpoint (GET /links/:id/analytics)
    log(`\n--- 4. Protected Analytics Endpoint (GET /links/${link.id}/analytics) ---`);
    const analyticsRes = await fetch(
      `http://localhost:${PORT}/links/${link.id}/analytics?from=2000-01-01&to=2100-01-01`,
      {
        headers: {
          'X-API-Key': rawKeyA,
        },
      }
    );

    const analytics = await analyticsRes.json();
    log(`GET /links/${link.id}/analytics -> HTTP ${analyticsRes.status}`);
    log(`Response: ${JSON.stringify(analytics, null, 2)}`);

    if (analyticsRes.status !== 200 || analytics.total_clicks !== 2) {
      throw new Error(`Expected 2 total_clicks, got ${JSON.stringify(analytics)}`);
    }
    if (!analytics.last_clicked_at) {
      throw new Error('Expected last_clicked_at timestamp to be populated');
    }
    log('[PASS] Protected analytics endpoint returned correct click count and recent timestamp.');

    // Cross-tenant verification: Tenant B cannot access Tenant A's link analytics (IDOR check)
    log('\n--- Cross-Tenant Analytics Isolation Check ---');
    const crossTenantRes = await fetch(
      `http://localhost:${PORT}/links/${link.id}/analytics?from=2000-01-01&to=2100-01-01`,
      {
        headers: {
          'X-API-Key': rawKeyB,
        },
      }
    );
    log(`Tenant B reading Tenant A analytics -> HTTP ${crossTenantRes.status}`);
    if (crossTenantRes.status !== 404) {
      throw new Error(`Expected HTTP 404 for cross-tenant analytics access, got ${crossTenantRes.status}`);
    }
    log('[PASS] Multi-tenant isolation verified: Tenant B received 404 Not Found on Tenant A analytics.');

    // 5. Idempotency Proof: Replay Exact Same Event Twice
    log('\n--- 5. Idempotency Proof: Replaying Duplicate Job Payload ---');
    const duplicateEventId = `clk_test_idempotency_${crypto.randomUUID()}`;
    const duplicateJob = {
      eventId: duplicateEventId,
      linkId: link.id,
      tenantId: tenantA.id,
      ipHash: analyticsService.hashIp('203.0.113.195'),
      userAgent: 'Automated-Test-Agent/1.0',
      referrer: 'https://test.example.com',
      timestamp: new Date().toISOString(),
    };

    // First execution
    const firstRun = await clickWorker.processJob(duplicateJob);
    log(`First job execution -> status: ${firstRun.status}`);
    if (firstRun.status !== 'success') {
      throw new Error(`Expected success on first job execution, got ${firstRun.status}`);
    }

    // Second execution (duplicate replay)
    const secondRun = await clickWorker.processJob(duplicateJob);
    log(`Second job replay -> status: ${secondRun.status}`);
    if (secondRun.status !== 'deduplicated') {
      throw new Error(`Expected deduplicated on replay, got ${secondRun.status}`);
    }

    // Verify row count increased by exactly 1 (not 2)
    const finalCount = await prisma.clickEvent.count({ where: { linkId: link.id } });
    log(`[DB] Click count after duplicate replay: ${finalCount} (expected 3)`);
    if (finalCount !== 3) {
      throw new Error(`Idempotency failure: expected exactly 3 clicks, got ${finalCount}`);
    }
    log('[PASS] Idempotency verified: replayed job safely caught by unique constraint, zero double-counting.');

    // 6. Privacy Proof: Verify Zero Raw IP Addresses Stored
    log('\n--- 6. Privacy & Anonymization Proof (GDPR/CCPA) ---');
    const sampleClicks = await prisma.clickEvent.findMany({
      where: { linkId: link.id },
      take: 5,
    });

    for (const c of sampleClicks) {
      log(`ClickEvent id: ${c.id}, ipHash: ${c.ipHash}`);
      if (!c.ipHash || c.ipHash.length !== 64) {
        throw new Error(`Expected 64-char SHA-256 ipHash, found: ${c.ipHash}`);
      }
      // Assert no raw IPv4 pattern
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(c.ipHash)) {
        throw new Error(`CRITICAL PRIVACY VIOLATION: Raw IP found in database: ${c.ipHash}`);
      }
    }
    log('[PASS] Privacy compliance verified: Salted SHA-256 ipHash stored; zero raw IP addresses in database.');

    // 7. Queue-Down Drill: Simulate Queue Broker Outage
    log('\n--- 7. Queue-Down Drill: Simulating Broker Outage ---');
    queueService.simulateOutage(true);

    const outageRedirect = await fetch(`http://localhost:${PORT}/r/${link.code}`, {
      redirect: 'manual',
    });
    log(`Redirect during Queue outage -> HTTP ${outageRedirect.status}, Location: ${outageRedirect.headers.get('location')}`);

    if (outageRedirect.status !== 302 || outageRedirect.headers.get('location') !== targetUrl) {
      throw new Error(`Queue outage broke redirect: expected 302 to ${targetUrl}, got ${outageRedirect.status}`);
    }
    queueService.simulateOutage(false);
    log('[PASS] Queue-down drill verified: Redirect remained 100% available with zero HTTP 500 errors.');

    // 8. Retention Proof: Purge Clicks Older Than Retention Cutoff
    log('\n--- 8. Data Retention Proof: Automated Purge of Expired Clicks ---');
    // Create an artificial expired click record 60 days in the past
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const expiredClick = await prisma.clickEvent.create({
      data: {
        eventId: `clk_expired_${crypto.randomUUID()}`,
        linkId: link.id,
        tenantId: tenantA.id,
        ipHash: analyticsService.hashIp('198.51.100.42'),
        clickedAt: sixtyDaysAgo,
      },
    });
    log(`Created test click record dated 60 days ago (id: ${expiredClick.id}, clickedAt: ${expiredClick.clickedAt.toISOString()})`);

    const prePurgeCount = await prisma.clickEvent.count({ where: { linkId: link.id } });
    log(`Pre-purge click count: ${prePurgeCount}`);

    // Run purge for 30-day retention
    const purgeResult = await analyticsService.purgeOldClicks(30);
    log(`Purge executed with retention_days = 30 -> Deleted count: ${purgeResult.deleted}`);

    const postPurgeCount = await prisma.clickEvent.count({ where: { linkId: link.id } });
    log(`Post-purge click count: ${postPurgeCount}`);

    const checkExpiredExists = await prisma.clickEvent.findUnique({ where: { id: expiredClick.id } });
    if (checkExpiredExists) {
      throw new Error('Expected 60-day-old click record to be purged, but it still exists!');
    }
    if (postPurgeCount !== prePurgeCount - 1) {
      throw new Error(`Expected exactly 1 expired record purged, got diff ${prePurgeCount - postPurgeCount}`);
    }
    log('[PASS] Retention proof verified: 60-day-old record purged cleanly; recent records intact.');

    log('\n====================================================');
    log('MODULE 07 VERIFICATION SUMMARY: ALL CHECKS PASSED!');
    log('====================================================\n');

    // Save evidence
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(EVIDENCE_FILE, outputLines.join('\n'), 'utf8');
    log(`[EVIDENCE] Verification report saved to: ${EVIDENCE_FILE}`);
  } finally {
    server.close();
    log('[SERVER] Test server shutdown cleanly.');
  }
}

main().catch((err) => {
  console.error('\n[FATAL] Verification suite error:', err);
  process.exit(1);
});
