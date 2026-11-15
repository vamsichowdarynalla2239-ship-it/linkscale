import http from 'http';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { generateApiKey } from '../src/utils/api-key';
import { linkService } from '../src/services/link.service';

async function runVerification() {
  console.log('================================================================');
  console.log('   MODULE 05: INCIDENT RESPONSE & AUTH BYPASS TEST SUITE        ');
  console.log('================================================================\n');

  // Seed test tenant, api key, and test link
  const tenantSlug = `tenant_inc_${Date.now()}`;
  const testTenant = await prisma.tenant.create({
    data: { name: tenantSlug },
  });

  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  await prisma.apiKey.create({
    data: {
      tenantId: testTenant.id,
      keyHash,
      prefix: keyPrefix,
      name: 'incident-response-key',
    },
  });

  const testLink = await linkService.createLink(
    { long_url: 'https://example.com/incident-demo-target' },
    testTenant.id
  );
  console.log(`[SEED] Created tenant: ${testTenant.id}, link code: "${testLink.code}"`);

  const app = createApp();
  const server = http.createServer(app);
  const testPort = 3096;

  await new Promise<void>((resolve) => server.listen(testPort, () => resolve()));
  console.log(`Test API running on port ${testPort}\n`);

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Request with Authorization: "" (empty string) -> MUST return 401
    // -------------------------------------------------------------------------
    const res1 = await fetch(`http://localhost:${testPort}/links`, {
      headers: { 'Authorization': '' },
    });
    console.log(`Test 1 [Authorization: ""] -> HTTP ${res1.status} (Expected: 401)`);
    if (res1.status !== 401) {
      throw new Error(`Test 1 Failed: Expected HTTP 401 on empty Authorization header, got ${res1.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 2: Request with Authorization: "   " (whitespace) -> MUST return 401
    // -------------------------------------------------------------------------
    const res2 = await fetch(`http://localhost:${testPort}/links`, {
      headers: { 'Authorization': '   ' },
    });
    console.log(`Test 2 [Authorization: "   "] -> HTTP ${res2.status} (Expected: 401)`);
    if (res2.status !== 401) {
      throw new Error(`Test 2 Failed: Expected HTTP 401 on whitespace Authorization header, got ${res2.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 3: Request with Authorization: "Bearer " (missing token) -> MUST return 401
    // -------------------------------------------------------------------------
    const res3 = await fetch(`http://localhost:${testPort}/links`, {
      headers: { 'Authorization': 'Bearer ' },
    });
    console.log(`Test 3 [Authorization: "Bearer "] -> HTTP ${res3.status} (Expected: 401)`);
    if (res3.status !== 401) {
      throw new Error(`Test 3 Failed: Expected HTTP 401 on missing Bearer token, got ${res3.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 4: Request with no credentials at all -> MUST return 401
    // -------------------------------------------------------------------------
    const res4 = await fetch(`http://localhost:${testPort}/links`);
    console.log(`Test 4 [No auth headers] -> HTTP ${res4.status} (Expected: 401)`);
    if (res4.status !== 401) {
      throw new Error(`Test 4 Failed: Expected HTTP 401 on omitted credentials, got ${res4.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 5: Request with empty x-api-key header -> MUST return 401
    // -------------------------------------------------------------------------
    const res5 = await fetch(`http://localhost:${testPort}/links`, {
      headers: { 'x-api-key': '   ' },
    });
    console.log(`Test 5 [x-api-key: "   "] -> HTTP ${res5.status} (Expected: 401)`);
    if (res5.status !== 401) {
      throw new Error(`Test 5 Failed: Expected HTTP 401 on empty x-api-key, got ${res5.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 6: Request with VALID API key -> MUST return 200
    // -------------------------------------------------------------------------
    const res6 = await fetch(`http://localhost:${testPort}/links`, {
      headers: { 'x-api-key': rawKey },
    });
    console.log(`Test 6 [Valid API Key] -> HTTP ${res6.status} (Expected: 200)`);
    if (res6.status !== 200) {
      throw new Error(`Test 6 Failed: Expected HTTP 200 on valid credentials, got ${res6.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 7: Request to Public Redirect Service (/r/:code) -> MUST return 302
    // Confirms redirect path is completely decoupled and unblocked for sales demo!
    // -------------------------------------------------------------------------
    const res7 = await fetch(`http://localhost:${testPort}/r/${testLink.code}`, {
      redirect: 'manual',
    });
    console.log(`Test 7 [Public Redirect /r/:code] -> HTTP ${res7.status} (Expected: 302)`);
    if (res7.status !== 302) {
      throw new Error(`Test 7 Failed: Expected HTTP 302 on public redirect, got ${res7.status}`);
    }

    console.log('\n✓ 7-Point Security & Decoupling Verification Passed:');
    console.log('  1. Empty auth header blocked (401)');
    console.log('  2. Whitespace auth header blocked (401)');
    console.log('  3. Malformed Bearer token blocked (401)');
    console.log('  4. Missing credentials blocked (401)');
    console.log('  5. Whitespace x-api-key blocked (401)');
    console.log('  6. Legitimate authenticated calls succeed (200)');
    console.log('  7. Public redirect service unaffected for sales demo (302)\n');
  } finally {
    server.close();
  }

  console.log('================================================================');
  console.log('   ALL MODULE 05 INCIDENT RESPONSE TESTS PASSED (100%)          ');
  console.log('================================================================');
}

runVerification().catch((err) => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
