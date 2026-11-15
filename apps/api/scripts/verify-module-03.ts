import http from 'http';
import fs from 'fs';
import path from 'path';
import { createApp } from '../src/app';
import { prisma } from '../src/db';

async function main() {
  const app = createApp();
  const PORT = 3000;
  const server = http.createServer(app);

  const logs: string[] = [];
  function log(msg: string) {
    console.log(msg);
    logs.push(msg);
  }

  log('====================================================');
  log('MODULE 03: CORE API & CRUD VERIFICATION SUITE');
  log('====================================================\n');

  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
  log(`[SERVER] Booted test server on http://localhost:${PORT}`);

  try {
    // 1. Health check
    log('\n--- 1. Health Check ---');
    const healthRes = await fetch(`http://localhost:${PORT}/health`);
    const healthBody = await healthRes.json();
    log(`GET /health -> HTTP ${healthRes.status}`);
    log(`Response: ${JSON.stringify(healthBody)}`);
    if (healthRes.status !== 200 || !healthBody.ok) {
      throw new Error(`Health check failed: ${JSON.stringify(healthBody)}`);
    }

    // 2. Create valid link
    log('\n--- 2. Create Short Link (POST /links) ---');
    const createRes = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ long_url: 'https://example.com' }),
    });
    const createBody = await createRes.json();
    log(`POST /links -> HTTP ${createRes.status}`);
    log(`Response: ${JSON.stringify(createBody, null, 2)}`);

    if (createRes.status !== 201 || !createBody.code) {
      throw new Error(`Create link failed: ${JSON.stringify(createBody)}`);
    }

    const { code, id, long_url } = createBody;

    // 3. Test Redirect (GET /r/:code)
    log(`\n--- 3. Public Redirect (GET /r/${code}) ---`);
    const redirectRes = await fetch(`http://localhost:${PORT}/r/${code}`, {
      redirect: 'manual',
    });
    const location = redirectRes.headers.get('location');
    log(`GET /r/${code} -> HTTP ${redirectRes.status}`);
    log(`Location Header: ${location}`);

    if (redirectRes.status !== 302 || location !== 'https://example.com') {
      throw new Error(`Redirect failed: expected 302 to https://example.com, got ${redirectRes.status} to ${location}`);
    }

    // 4. List Links (GET /links)
    log('\n--- 4. List Links (GET /links) ---');
    const listRes = await fetch(`http://localhost:${PORT}/links?page=1&limit=10`);
    const listBody = await listRes.json();
    log(`GET /links -> HTTP ${listRes.status}`);
    log(`Total items found: ${listBody.pagination?.total}`);

    // 5. Get Link by ID (GET /links/:id)
    log(`\n--- 5. Get Link By ID (GET /links/${id}) ---`);
    const getByIdRes = await fetch(`http://localhost:${PORT}/links/${id}`);
    const getByIdBody = await getByIdRes.json();
    log(`GET /links/${id} -> HTTP ${getByIdRes.status}`);
    log(`Matched code: ${getByIdBody.code}, long_url: ${getByIdBody.long_url}`);

    // 6. Validation Abuse Checks (All must return HTTP 400)
    log('\n--- 6. Validation Abuse Checks (Expecting HTTP 400) ---');
    const abuseCases = [
      { name: 'javascript:alert(1)', payload: { long_url: 'javascript:alert(1)' } },
      { name: 'JaVaScRiPt:alert(1) (case-insensitive bypass)', payload: { long_url: 'JaVaScRiPt:alert(1)' } },
      { name: '" javascript:alert(1) " (whitespace bypass)', payload: { long_url: ' javascript:alert(1) ' } },
      { name: 'data:text/html,<svg/onload=alert(1)>', payload: { long_url: 'data:text/html,<svg/onload=alert(1)>' } },
      { name: '//evil.example.com (scheme-relative)', payload: { long_url: '//evil.example.com' } },
      { name: 'http:%2f%2fevil.example.com (encoded slashes)', payload: { long_url: 'http:%2f%2fevil.example.com' } },
      { name: 'http%3A%2F%2Fevil.example.com (encoded scheme)', payload: { long_url: 'http%3A%2F%2Fevil.example.com' } },
      { name: 'http:\\\\evil.example.com (backslashes)', payload: { long_url: 'http:\\\\evil.example.com' } },
      { name: 'https://good.com@evil.example.com (userinfo trick)', payload: { long_url: 'https://good.com@evil.example.com' } },
      { name: 'https://example.com\\n (control character)', payload: { long_url: 'https://example.com\n' } },
    ];

    let abusePassed = 0;
    for (const testCase of abuseCases) {
      const res = await fetch(`http://localhost:${PORT}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testCase.payload),
      });
      const body = await res.json();
      const statusOk = res.status === 400;
      if (statusOk) {
        abusePassed++;
        log(`[PASS] ${testCase.name} -> HTTP ${res.status} (Rejected)`);
      } else {
        log(`[FAIL] ${testCase.name} -> HTTP ${res.status} (VULNERABILITY: NOT REJECTED!)`);
        throw new Error(`Abuse case failed: ${testCase.name} returned HTTP ${res.status}`);
      }
    }

    log(`\nValidation Abuse Suite: ${abusePassed}/${abuseCases.length} attack vectors rejected with HTTP 400.`);

    // 7. Test Non-Existent Route & Code
    log('\n--- 7. Non-Existent Code Handling ---');
    const notFoundRes = await fetch(`http://localhost:${PORT}/r/nonexistent-code-999`, {
      redirect: 'manual',
    });
    log(`GET /r/nonexistent-code-999 -> HTTP ${notFoundRes.status}`);
    if (notFoundRes.status !== 404) {
      throw new Error(`Expected 404 for missing code, got ${notFoundRes.status}`);
    }

    log('\n====================================================');
    log('VERIFICATION SUMMARY: ALL CHECKS PASSED PERFECTLY!');
    log('====================================================');

    // Save evidence file
    const evidenceDir = path.resolve(__dirname, '../../../progress/evidence/module-03');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'api-verification.txt');
    fs.writeFileSync(evidencePath, logs.join('\n'), 'utf8');
    log(`\n[EVIDENCE] Saved full verification report to: ${evidencePath}`);
  } finally {
    server.close();
    await prisma.$disconnect();
    log('[SERVER] Test server shutdown cleanly.');
  }
}

main().catch((err) => {
  console.error('[FATAL] Verification suite error:', err);
  process.exit(1);
});

