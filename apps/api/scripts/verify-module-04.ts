import http from 'http';
import fs from 'fs';
import path from 'path';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { generateApiKey } from '../src/utils/api-key';

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
  log('MODULE 04: MULTI-TENANCY, AUTH & RATE LIMIT SUITE');
  log('====================================================\n');

  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
  log(`[SERVER] Booted test server on http://localhost:${PORT}`);

  try {
    // 0. Seed Two Tenants and API Keys
    log('\n--- 0. Seed Test Tenants and API Keys ---');
    await prisma.apiKey.deleteMany();
    await prisma.clickEvent.deleteMany();
    await prisma.link.deleteMany();
    await prisma.tenant.deleteMany();

    const tenantA = await prisma.tenant.create({ data: { name: 'Acme Corp (Tenant A)' } });
    const keyDataA = generateApiKey('sk_live_acme');
    await prisma.apiKey.create({
      data: {
        keyHash: keyDataA.keyHash,
        prefix: keyDataA.keyPrefix,
        name: 'Production Key A',
        tenantId: tenantA.id,
      },
    });

    const tenantB = await prisma.tenant.create({ data: { name: 'Stark Industries (Tenant B)' } });
    const keyDataB = generateApiKey('sk_live_stark');
    await prisma.apiKey.create({
      data: {
        keyHash: keyDataB.keyHash,
        prefix: keyDataB.keyPrefix,
        name: 'Production Key B',
        tenantId: tenantB.id,
      },
    });

    log(`[SEED] Created Tenant A (id: ${tenantA.id}) with Key: ${keyDataA.keyPrefix}...`);
    log(`[SEED] Created Tenant B (id: ${tenantB.id}) with Key: ${keyDataB.keyPrefix}...`);

    // 1. Unauthenticated Request to Protected Endpoint
    log('\n--- 1. Protected Endpoint Without Auth (Expect 401) ---');
    const noAuthRes = await fetch(`http://localhost:${PORT}/links`);
    const noAuthBody = await noAuthRes.json();
    log(`GET /links (no auth) -> HTTP ${noAuthRes.status}`);
    log(`Response: ${JSON.stringify(noAuthBody)}`);
    if (noAuthRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated request, got ${noAuthRes.status}`);
    }

    // 2. Invalid Key Request to Protected Endpoint
    log('\n--- 2. Protected Endpoint With Invalid Key (Expect 401) ---');
    const badKeyRes = await fetch(`http://localhost:${PORT}/links`, {
      headers: { 'X-API-Key': 'sk_live_invalid_bad_key_12345' },
    });
    log(`GET /links (bad key) -> HTTP ${badKeyRes.status}`);
    if (badKeyRes.status !== 401) {
      throw new Error(`Expected 401 for invalid key, got ${badKeyRes.status}`);
    }

    // 3. Valid API Key A Request
    log('\n--- 3. Protected Endpoint With Valid Key A (Expect 200) ---');
    const validKeyRes = await fetch(`http://localhost:${PORT}/links`, {
      headers: { 'X-API-Key': keyDataA.rawKey },
    });
    const validKeyBody = await validKeyRes.json();
    log(`GET /links (Key A) -> HTTP ${validKeyRes.status}`);
    log(`Initial links for Tenant A: ${validKeyBody.pagination?.total}`);
    if (validKeyRes.status !== 200) {
      throw new Error(`Expected 200 for valid key, got ${validKeyRes.status}`);
    }

    // 4. Tenant A Creates Link
    log('\n--- 4. Tenant A Creates Short Link (POST /links) ---');
    const createRes = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': keyDataA.rawKey,
      },
      body: JSON.stringify({ long_url: 'https://acme.example.com/confidential-launch' }),
    });
    const createdLink = await createRes.json();
    log(`POST /links (Tenant A) -> HTTP ${createRes.status}`);
    log(`Created Link id: ${createdLink.id}, code: ${createdLink.code}`);
    if (createRes.status !== 201 || !createdLink.id) {
      throw new Error(`Failed to create link for Tenant A: ${JSON.stringify(createdLink)}`);
    }

    // 5. Tenant A Accesses Own Link
    log('\n--- 5. Tenant A Accesses Own Link (GET /links/:id) ---');
    const getOwnRes = await fetch(`http://localhost:${PORT}/links/${createdLink.id}`, {
      headers: { 'X-API-Key': keyDataA.rawKey },
    });
    const getOwnBody = await getOwnRes.json();
    log(`GET /links/${createdLink.id} (Tenant A) -> HTTP ${getOwnRes.status}`);
    log(`Matched long_url: ${getOwnBody.long_url}`);
    if (getOwnRes.status !== 200 || getOwnBody.id !== createdLink.id) {
      throw new Error(`Tenant A failed to retrieve own link`);
    }

    // 6. Tenant B Tries to Access Tenant A's Link (IDOR Defense Check)
    log("\n--- 6. Tenant B Tries to Access Tenant A's Link (IDOR Test - Expect 404) ---");
    const idorRes = await fetch(`http://localhost:${PORT}/links/${createdLink.id}`, {
      headers: { 'X-API-Key': keyDataB.rawKey },
    });
    const idorBody = await idorRes.json();
    log(`GET /links/${createdLink.id} (Tenant B) -> HTTP ${idorRes.status}`);
    log(`Response: ${JSON.stringify(idorBody)}`);
    if (idorRes.status !== 404) {
      throw new Error(`IDOR VULNERABILITY DETECTED! Expected 404 Not Found, got ${idorRes.status}`);
    }
    log('[PASS] IDOR Defense verified: Cross-tenant resource hidden with 404 Not Found.');

    // 7. Tenant B Lists Links (Verify complete multi-tenant list isolation)
    log('\n--- 7. Tenant B Lists Links (Expect Isolated List) ---');
    const listBRes = await fetch(`http://localhost:${PORT}/links`, {
      headers: { 'X-API-Key': keyDataB.rawKey },
    });
    const listBBody = await listBRes.json();
    log(`GET /links (Tenant B) -> Total found: ${listBBody.pagination?.total}`);
    if (listBBody.pagination?.total !== 0) {
      throw new Error(`Data leakage! Tenant B sees ${listBBody.pagination?.total} links from other tenants!`);
    }
    log('[PASS] Multi-tenant list isolation verified: Tenant B sees 0 links.');

    // 8. Public Redirect Remains Unauthenticated
    log(`\n--- 8. Public Redirect Without Auth (GET /r/${createdLink.code}) ---`);
    const publicRedirectRes = await fetch(`http://localhost:${PORT}/r/${createdLink.code}`, {
      redirect: 'manual',
    });
    const redirectLocation = publicRedirectRes.headers.get('location');
    log(`GET /r/${createdLink.code} (no auth) -> HTTP ${publicRedirectRes.status}`);
    log(`Location: ${redirectLocation}`);
    if (publicRedirectRes.status !== 302 || redirectLocation !== 'https://acme.example.com/confidential-launch') {
      throw new Error(`Public redirect failed: expected 302, got ${publicRedirectRes.status}`);
    }
    log('[PASS] Public redirect verified: Fast, unauthenticated, RFC 9110 compliant.');

    // 9. Rate Limiting Proof on POST /links (Limit: 30/min per tenant)
    log('\n--- 9. Rate Limiting Proof: POST /links (Limit: 30/min) ---');
    let throttledAt = -1;
    for (let i = 1; i <= 35; i++) {
      const res = await fetch(`http://localhost:${PORT}/links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': keyDataA.rawKey,
        },
        body: JSON.stringify({ long_url: `https://example.com/item-${i}` }),
      });

      if (res.status === 429) {
        throttledAt = i;
        const retryAfter = res.headers.get('retry-after');
        log(`[THROTTLED] Request #${i} triggered HTTP 429 Too Many Requests (Retry-After: ${retryAfter}s)`);
        break;
      }
    }

    if (throttledAt === -1 || throttledAt > 31) {
      throw new Error(`Rate limiting failed on POST /links: was not throttled as expected at request 31 (throttled at: ${throttledAt})`);
    }
    log(`[PASS] Rate limiting verified: Tenant throttled at request #${throttledAt} with HTTP 429.`);

    // 10. Rate Limiting Proof on Public Redirect (Limit: 120/min per IP)
    log('\n--- 10. Rate Limiting Proof: GET /r/:code (Limit: 120/min) ---');
    let redirectThrottledAt = -1;
    for (let i = 1; i <= 125; i++) {
      const res = await fetch(`http://localhost:${PORT}/r/${createdLink.code}`, {
        redirect: 'manual',
      });

      if (res.status === 429) {
        redirectThrottledAt = i;
        const retryAfter = res.headers.get('retry-after');
        log(`[THROTTLED] Public redirect #${i} triggered HTTP 429 Too Many Requests (Retry-After: ${retryAfter}s)`);
        break;
      }
    }

    if (redirectThrottledAt === -1 || redirectThrottledAt > 121) {
      throw new Error(`Rate limiting failed on GET /r/:code: expected throttling at 121, got ${redirectThrottledAt}`);
    }
    log(`[PASS] Redirect rate limiting verified: IP throttled at request #${redirectThrottledAt} with HTTP 429.`);

    log('\n====================================================');
    log('MODULE 04 VERIFICATION SUMMARY: ALL CHECKS PASSED!');
    log('====================================================');

    // Save evidence file
    const evidenceDir = path.resolve(__dirname, '../../../progress/evidence/module-04');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'auth-verification.txt');
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

