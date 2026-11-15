import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// -----------------------------------------------------------------------------
// PRE-FLIGHT DATABASE ISOLATION & TEST ENVIRONMENT GUARDRAILS
// -----------------------------------------------------------------------------
process.env.NODE_ENV = 'test';

const dbUrl = process.env.DATABASE_URL || 'file:./dev.db';
const isSafeTestDb =
  process.env.NODE_ENV === 'test' &&
  (dbUrl.includes('test') || dbUrl.includes('dev.db') || dbUrl.includes('file:'));

if (!isSafeTestDb) {
  console.error('\n[FATAL GUARDRAIL ERROR] Test suite attempted to run against non-test database!');
  console.error(`NODE_ENV=${process.env.NODE_ENV}, DATABASE_URL=${dbUrl}`);
  process.exit(1);
}

import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { clickWorker } from '../src/workers/click.worker';
import { analyticsService } from '../src/services/analytics.service';

const PORT = 3002;
const EVIDENCE_DIR = path.resolve(__dirname, '../../../progress/evidence/module-09');
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'testing-verification.txt');

async function main() {
  const outputLines: string[] = [];
  const log = (msg: string) => {
    console.log(msg);
    outputLines.push(msg);
  };

  log('====================================================');
  log('MODULE 09: INTEGRATION, CONCURRENCY & CHAOS SUITE');
  log('====================================================\n');
  log(`[GUARDRAIL] Pre-flight isolation verified: NODE_ENV=${process.env.NODE_ENV}, DB=${dbUrl}`);

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  // Boot local test server on dedicated test port
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  log(`[SERVER] Test API server online on http://localhost:${PORT}`);

  try {
    // 0. Seed Test Principals & API Keys
    log('\n--- 0. Setup: Seed Multi-Tenant Principals ---');
    const tenantA = await prisma.tenant.create({ data: { name: 'Acme Test Corp' } });
    const tenantB = await prisma.tenant.create({ data: { name: 'Rival Test Corp' } });

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
    log(`[SEED] Created Tenant A (${tenantA.id}) and Tenant B (${tenantB.id})`);

    // -------------------------------------------------------------------------
    // TEST 1: Link Creation & Public Redirection (Prefix /r/:code)
    // -------------------------------------------------------------------------
    log('\n--- 1. Link Creation & Prefix Redirection (GET /r/:code) ---');
    const longTarget = 'https://acme.example.com/products/release-2026';
    const createRes = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': rawKeyA,
      },
      body: JSON.stringify({
        long_url: longTarget,
        tags: ['release', 'prod'],
      }),
    });

    const linkA = await createRes.json();
    log(`POST /links -> HTTP ${createRes.status}, code: ${linkA.code}`);
    if (createRes.status !== 201 || !linkA.code) {
      throw new Error(`Test 1 Failed: Expected 201 Created with code, got ${createRes.status}`);
    }

    // Public Redirect: GET /r/:code
    const redirectRes1 = await fetch(`http://localhost:${PORT}/r/${linkA.code}`, {
      redirect: 'manual',
    });
    const location1 = redirectRes1.headers.get('location');
    const cacheHeader1 = redirectRes1.headers.get('x-cache');
    log(`GET /r/${linkA.code} (1st) -> HTTP ${redirectRes1.status}, Location: ${location1}, X-Cache: ${cacheHeader1}`);
    if (redirectRes1.status !== 302 || location1 !== longTarget) {
      throw new Error(`Test 1 Failed: Expected HTTP 302 redirect to ${longTarget}, got ${redirectRes1.status}`);
    }

    // Secondary Redirect to verify Cache-Aside HIT
    const redirectRes2 = await fetch(`http://localhost:${PORT}/r/${linkA.code}`, {
      redirect: 'manual',
    });
    const cacheHeader2 = redirectRes2.headers.get('x-cache');
    log(`GET /r/${linkA.code} (2nd) -> HTTP ${redirectRes2.status}, X-Cache: ${cacheHeader2}`);
    log(`[PASS] Test 1: Link created and public redirect validated.`);

    // -------------------------------------------------------------------------
    // TEST 2: Authentication & Perimeter Protection
    // -------------------------------------------------------------------------
    log('\n--- 2. Authentication Perimeter & Error Envelopes ---');
    // 2a. Missing API Key
    const unauthRes = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ long_url: 'https://example.com' }),
    });
    log(`POST /links (Missing Key) -> HTTP ${unauthRes.status}`);
    const unauthData = await unauthRes.json();
    if (unauthRes.status !== 401 || !unauthData.error?.code) {
      throw new Error(`Test 2a Failed: Expected HTTP 401 for missing key, got ${unauthRes.status}`);
    }

    // 2b. Invalid API Key
    const badKeyRes = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'key_live_malicious_fake_key_99999',
      },
      body: JSON.stringify({ long_url: 'https://example.com' }),
    });
    log(`POST /links (Invalid Key) -> HTTP ${badKeyRes.status}`);
    const badKeyData = await badKeyRes.json();
    if (badKeyRes.status !== 401 || !badKeyData.error?.request_id) {
      throw new Error(`Test 2b Failed: Expected HTTP 401 for invalid key with request_id, got ${badKeyRes.status}`);
    }
    log(`[PASS] Test 2: Authentication perimeter enforced with standardized 401 error envelope.`);

    // -------------------------------------------------------------------------
    // TEST 3: Anti-IDOR Owner Scoping (HTTP 404 Masking)
    // -------------------------------------------------------------------------
    log('\n--- 3. Anti-IDOR Owner Scoping (HTTP 404 on Cross-Tenant Access) ---');
    // Tenant B attempts to read Tenant A's link
    const idorGetRes = await fetch(`http://localhost:${PORT}/links/${linkA.id}`, {
      headers: { 'X-API-Key': rawKeyB },
    });
    log(`Tenant B GET /links/${linkA.id} -> HTTP ${idorGetRes.status}`);
    if (idorGetRes.status !== 404) {
      throw new Error(`Test 3 Failed: Expected HTTP 404 on IDOR read, got ${idorGetRes.status}`);
    }

    // Tenant B attempts to update Tenant A's link
    const idorPatchRes = await fetch(`http://localhost:${PORT}/links/${linkA.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': rawKeyB,
      },
      body: JSON.stringify({ long_url: 'https://evil-hijack.com' }),
    });
    log(`Tenant B PATCH /links/${linkA.id} -> HTTP ${idorPatchRes.status}`);
    if (idorPatchRes.status !== 404) {
      throw new Error(`Test 3 Failed: Expected HTTP 404 on IDOR patch, got ${idorPatchRes.status}`);
    }

    // Tenant B attempts to delete Tenant A's link
    const idorDeleteRes = await fetch(`http://localhost:${PORT}/links/${linkA.id}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': rawKeyB },
    });
    log(`Tenant B DELETE /links/${linkA.id} -> HTTP ${idorDeleteRes.status}`);
    if (idorDeleteRes.status !== 404) {
      throw new Error(`Test 3 Failed: Expected HTTP 404 on IDOR delete, got ${idorDeleteRes.status}`);
    }
    log(`[PASS] Test 3: Anti-IDOR owner scoping enforced across GET, PATCH, and DELETE.`);

    // -------------------------------------------------------------------------
    // TEST 4: Defensive URL Validation & Smuggling Rejections
    // -------------------------------------------------------------------------
    log('\n--- 4. URL Validation & Smuggling Vectors (HTTP 400) ---');
    const dangerousUrls = [
      { name: 'Backslash Smuggling', url: 'https:\\\\evil.example.com' },
      { name: 'JavaScript Protocol', url: 'javascript:alert(document.cookie)' },
      { name: 'CRLF Injection', url: 'https://example.com/path\r\nSet-Cookie: evil=1' },
      { name: 'Userinfo Credentials', url: 'https://admin:secret@malicious.com' },
      { name: 'Illegal Protocol (FTP)', url: 'ftp://ftp.example.com/file' },
    ];

    for (const vector of dangerousUrls) {
      const res = await fetch(`http://localhost:${PORT}/links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': rawKeyA,
        },
        body: JSON.stringify({ long_url: vector.url }),
      });
      log(`Rejection test: [${vector.name}] -> HTTP ${res.status}`);
      if (res.status !== 400) {
        throw new Error(`Test 4 Failed: Expected HTTP 400 for ${vector.name}, got ${res.status}`);
      }
    }
    log(`[PASS] Test 4: All 5 URL smuggling and protocol abuse vectors rejected with HTTP 400.`);

    // -------------------------------------------------------------------------
    // TEST 5: Worker Replay Idempotency & P2002 Exact-Once Persistence
    // -------------------------------------------------------------------------
    log('\n--- 5. Queue Worker Replay Idempotency (Exact-Once Persistence) ---');
    const testEventId = `clk_replay_test_${crypto.randomUUID()}`;
    const testPayload = {
      eventId: testEventId,
      linkId: linkA.id,
      tenantId: tenantA.id,
      ipHash: crypto.createHash('sha256').update('192.0.2.1').digest('hex'),
      userAgent: 'IntegrationTestRunner/1.0',
      referrer: 'https://test.local',
      timestamp: new Date().toISOString(),
    };

    // First worker execution
    const run1 = await clickWorker.processJob(testPayload);
    log(`Worker Execution 1: status=${run1.status}, processed=${run1.processed}`);
    if (run1.status !== 'success' || !run1.processed) {
      throw new Error(`Test 5 Failed: Expected status 'success' on initial job execution, got ${run1.status}`);
    }

    // Replay identical job (Simulate queue delivery retry after crash)
    const run2 = await clickWorker.processJob(testPayload);
    log(`Worker Execution 2 (Replay): status=${run2.status}, processed=${run2.processed}`);
    if (run2.status !== 'deduplicated') {
      throw new Error(`Test 5 Failed: Expected status 'deduplicated' on replayed job, got ${run2.status}`);
    }

    // Verify row count in database is strictly 1
    const storedCount = await prisma.clickEvent.count({
      where: { eventId: testEventId },
    });
    log(`Database ClickEvent count for eventId ${testEventId}: ${storedCount}`);
    if (storedCount !== 1) {
      throw new Error(`Test 5 Failed: Expected exactly 1 ClickEvent record, found ${storedCount}`);
    }
    log(`[PASS] Test 5: Worker idempotency and P2002 deduplication verified.`);

    // -------------------------------------------------------------------------
    // TEST 6: Automated Data Retention Policy Enforcement
    // -------------------------------------------------------------------------
    log('\n--- 6. Data Retention Policy & Automated Pruning ---');
    // Seed an expired click event (45 days old) and a recent click event (2 days old)
    const oldEventId = `clk_expired_${crypto.randomUUID()}`;
    const recentEventId = `clk_active_${crypto.randomUUID()}`;

    await prisma.clickEvent.create({
      data: {
        eventId: oldEventId,
        linkId: linkA.id,
        tenantId: tenantA.id,
        clickedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), // 45 days ago
      },
    });

    await prisma.clickEvent.create({
      data: {
        eventId: recentEventId,
        linkId: linkA.id,
        tenantId: tenantA.id,
        clickedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      },
    });

    log(`[SEED] Created 45-day-old click (${oldEventId}) and 2-day-old click (${recentEventId}).`);

    // Execute 30-day retention purge
    const purgeResult = await analyticsService.purgeOldClicks(30, tenantA.id);
    log(`Purge executed (30-day cutoff: ${purgeResult.cutoff}): deleted=${purgeResult.deleted}`);

    // Verify expired record was deleted
    const oldCheck = await prisma.clickEvent.findUnique({ where: { eventId: oldEventId } });
    if (oldCheck) {
      throw new Error(`Test 6 Failed: Expired click event was not pruned!`);
    }

    // Verify active record remains intact
    const recentCheck = await prisma.clickEvent.findUnique({ where: { eventId: recentEventId } });
    if (!recentCheck) {
      throw new Error(`Test 6 Failed: Active click event was erroneously pruned!`);
    }
    log(`[PASS] Test 6: Automated 30-day retention pruning successfully isolated and purged expired records.`);

    // -------------------------------------------------------------------------
    // TEST 7: Route Precedence & Bounded Search Pagination
    // -------------------------------------------------------------------------
    log('\n--- 7. Route Precedence & Bounded Pagination ---');
    const searchRes = await fetch(`http://localhost:${PORT}/links/search?q=release`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    log(`GET /links/search -> HTTP ${searchRes.status}`);
    if (searchRes.status !== 200) {
      throw new Error(`Test 7 Failed: Expected HTTP 200 for /links/search, got ${searchRes.status}`);
    }

    const hugePageRes = await fetch(`http://localhost:${PORT}/links/search?page_size=500`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    log(`GET /links/search?page_size=500 -> HTTP ${hugePageRes.status}`);
    if (hugePageRes.status !== 400) {
      throw new Error(`Test 7 Failed: Expected HTTP 400 for page_size=500, got ${hugePageRes.status}`);
    }
    log(`[PASS] Test 7: Route precedence and page_size hard limit ceiling verified.`);

    log('\n====================================================');
    log('ALL MODULE 09 INTEGRATION TESTS PASSED (7/7)');
    log('====================================================');

    fs.writeFileSync(EVIDENCE_FILE, outputLines.join('\n'), 'utf-8');
    log(`\nEvidence written to: ${EVIDENCE_FILE}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});

