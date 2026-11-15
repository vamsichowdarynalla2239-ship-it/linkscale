import http from 'http';
import fs from 'fs';
import path from 'path';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { generateApiKey } from '../src/utils/api-key';
import { cacheService } from '../src/services/cache.service';

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
  log('MODULE 06: REDIS CACHING, EVICTION & FALLBACK SUITE');
  log('====================================================\n');

  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
  log(`[SERVER] Booted test server on http://localhost:${PORT}`);

  try {
    // 0. Seed Test Tenant and API Key
    log('\n--- 0. Seed Test Tenant and API Key ---');
    await prisma.apiKey.deleteMany();
    await prisma.clickEvent.deleteMany();
    await prisma.link.deleteMany();
    await prisma.tenant.deleteMany();

    const tenantA = await prisma.tenant.create({ data: { name: 'Acme Caching Enterprise' } });
    const keyDataA = generateApiKey('sk_live_cache_a');
    await prisma.apiKey.create({
      data: {
        keyHash: keyDataA.keyHash,
        prefix: keyDataA.keyPrefix,
        name: 'Production Key A',
        tenantId: tenantA.id,
      },
    });

    const tenantB = await prisma.tenant.create({ data: { name: 'Stark Industries (Tenant B)' } });
    const keyDataB = generateApiKey('sk_live_cache_b');
    await prisma.apiKey.create({
      data: {
        keyHash: keyDataB.keyHash,
        prefix: keyDataB.keyPrefix,
        name: 'Production Key B',
        tenantId: tenantB.id,
      },
    });

    log(`[SEED] Created Tenant A (${tenantA.id}) and Tenant B (${tenantB.id})`);

    // 1. Create a Short Link
    log('\n--- 1. Create Initial Short Link (POST /links) ---');
    const initialUrl = 'https://acme.example.com/v1/original-campaign';
    const createRes = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': keyDataA.rawKey,
      },
      body: JSON.stringify({ long_url: initialUrl }),
    });

    const link = await createRes.json();
    log(`POST /links -> HTTP ${createRes.status}`);
    log(`Created Link id: ${link.id}, code: ${link.code}`);
    if (createRes.status !== 201 || !link.code) {
      throw new Error(`Failed to create short link: ${JSON.stringify(link)}`);
    }

    // 2. First Redirect: Expect Cache Miss (DB query + Cache population)
    log(`\n--- 2. First Redirect (GET /r/${link.code}): Expect Cache MISS ---`);
    const r1 = await fetch(`http://localhost:${PORT}/r/${link.code}`, { redirect: 'manual' });
    const r1CacheHeader = r1.headers.get('x-cache');
    const r1Location = r1.headers.get('location');
    log(`Redirect 1 -> HTTP ${r1.status}, Location: ${r1Location}, X-Cache: ${r1CacheHeader}`);

    if (r1.status !== 302 || r1Location !== initialUrl) {
      throw new Error(`Expected 302 to ${initialUrl}, got ${r1.status} to ${r1Location}`);
    }
    if (r1CacheHeader !== 'MISS') {
      throw new Error(`Expected X-Cache: MISS on initial redirect, got ${r1CacheHeader}`);
    }
    log('[PASS] First redirect successfully read from DB and populated cache (X-Cache: MISS).');

    // 3. Second Redirect: Expect Cache Hit (Sub-millisecond retrieval from Redis)
    log(`\n--- 3. Second Redirect (GET /r/${link.code}): Expect Cache HIT ---`);
    const tStart = performance.now();
    const r2 = await fetch(`http://localhost:${PORT}/r/${link.code}`, { redirect: 'manual' });
    const r2Duration = performance.now() - tStart;
    const r2CacheHeader = r2.headers.get('x-cache');
    const r2Location = r2.headers.get('location');
    log(`Redirect 2 -> HTTP ${r2.status}, Location: ${r2Location}, X-Cache: ${r2CacheHeader} (${r2Duration.toFixed(2)}ms)`);

    if (r2.status !== 302 || r2Location !== initialUrl) {
      throw new Error(`Expected 302 to ${initialUrl}, got ${r2.status}`);
    }
    if (r2CacheHeader !== 'HIT') {
      throw new Error(`Expected X-Cache: HIT on second redirect, got ${r2CacheHeader}`);
    }
    log('[PASS] Second redirect served directly from cache (X-Cache: HIT).');

    // 4. Update Link Destination: Expect Immediate Cache Eviction
    log(`\n--- 4. Update Link Destination (PATCH /links/${link.id}) ---`);
    const updatedUrl = 'https://acme.example.com/v2/new-destination-page';
    const updateRes = await fetch(`http://localhost:${PORT}/links/${link.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': keyDataA.rawKey,
      },
      body: JSON.stringify({ long_url: updatedUrl }),
    });

    const updatedBody = await updateRes.json();
    log(`PATCH /links/${link.id} -> HTTP ${updateRes.status}`);
    log(`Updated long_url: ${updatedBody.long_url}`);

    if (updateRes.status !== 200 || updatedBody.long_url !== updatedUrl) {
      throw new Error(`Failed to update link destination: ${JSON.stringify(updatedBody)}`);
    }
    log('[PASS] Link updated in database; cache key evicted.');

    // 5. Third Redirect: Verify ZERO Stale Data
    log(`\n--- 5. Third Redirect (GET /r/${link.code}): Verify Zero Stale Data ---`);
    const r3 = await fetch(`http://localhost:${PORT}/r/${link.code}`, { redirect: 'manual' });
    const r3CacheHeader = r3.headers.get('x-cache');
    const r3Location = r3.headers.get('location');
    log(`Redirect 3 -> HTTP ${r3.status}, Location: ${r3Location}, X-Cache: ${r3CacheHeader}`);

    if (r3.status !== 302) {
      throw new Error(`Expected 302, got ${r3.status}`);
    }
    if (r3Location !== updatedUrl) {
      throw new Error(`STALE DATA HAZARD: Redirect still points to old URL ${r3Location} instead of ${updatedUrl}`);
    }
    if (r3CacheHeader !== 'MISS') {
      throw new Error(`Expected X-Cache: MISS after eviction, got ${r3CacheHeader}`);
    }
    log('[PASS] Zero stale data: redirect immediately resolved to updated URL (X-Cache: MISS).');

    // 6. Fourth Redirect: Confirm New URL is now Cached
    log(`\n--- 6. Fourth Redirect (GET /r/${link.code}): Confirm New URL is Cached ---`);
    const r4 = await fetch(`http://localhost:${PORT}/r/${link.code}`, { redirect: 'manual' });
    const r4CacheHeader = r4.headers.get('x-cache');
    log(`Redirect 4 -> HTTP ${r4.status}, Location: ${r4.headers.get('location')}, X-Cache: ${r4CacheHeader}`);

    if (r4CacheHeader !== 'HIT' || r4.headers.get('location') !== updatedUrl) {
      throw new Error(`Expected X-Cache: HIT for new URL, got ${r4CacheHeader}`);
    }
    log('[PASS] Updated URL cached successfully (X-Cache: HIT).');

    // 7. Delete Link: Verify Eviction on Delete
    log(`\n--- 7. Delete Link (DELETE /links/${link.id}): Expect Eviction ---`);
    const deleteRes = await fetch(`http://localhost:${PORT}/links/${link.id}`, {
      method: 'DELETE',
      headers: {
        'X-API-Key': keyDataA.rawKey,
      },
    });
    log(`DELETE /links/${link.id} -> HTTP ${deleteRes.status}`);
    if (deleteRes.status !== 204) {
      throw new Error(`Expected 204 on delete, got ${deleteRes.status}`);
    }

    const r5 = await fetch(`http://localhost:${PORT}/r/${link.code}`, { redirect: 'manual' });
    log(`Redirect 5 (after delete) -> HTTP ${r5.status}`);
    if (r5.status !== 404) {
      throw new Error(`STALE DATA HAZARD: Deleted link still redirected! Expected 404, got ${r5.status}`);
    }
    log('[PASS] Deleted link evicted: subsequent redirect immediately returns 404 Not Found.');

    // 8. Redis Down Drill: Prove Graceful DB Fallback
    log('\n--- 8. Redis Down Drill: Simulating Redis Outage ---');
    cacheService.simulateOutage(true);

    const fallbackUrl = 'https://acme.example.com/resilience-proof';
    const createFallbackRes = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': keyDataA.rawKey,
      },
      body: JSON.stringify({ long_url: fallbackUrl }),
    });
    const fallbackLink = await createFallbackRes.json();
    log(`Created Link during Redis outage: code=${fallbackLink.code}`);

    const rOutage = await fetch(`http://localhost:${PORT}/r/${fallbackLink.code}`, { redirect: 'manual' });
    const rOutageLoc = rOutage.headers.get('location');
    log(`Redirect during Redis outage -> HTTP ${rOutage.status}, Location: ${rOutageLoc}`);

    if (rOutage.status !== 302 || rOutageLoc !== fallbackUrl) {
      throw new Error(`Graceful fallback failed during Redis outage: expected 302 to ${fallbackUrl}, got ${rOutage.status}`);
    }
    log('[PASS] Redis down drill verified: System degraded gracefully to DB, zero 500 errors.');

    cacheService.simulateOutage(false);

    // 9. Org Scoping Twist: Verify Tenant Isolation in Metadata Cache
    log('\n--- 9. Org Scoping Twist: Verify Tenant-Scoped Cache Isolation ---');
    const linkA = await prisma.link.create({
      data: {
        code: 'orgScope1',
        longUrl: 'https://tenant-a.internal/data',
        tenantId: tenantA.id,
      },
    });

    // Populate Tenant A metadata cache
    await cacheService.setTenantLink(tenantA.id, linkA.id, { id: linkA.id, secret: 'tenant_a_confidential' });

    // Tenant A queries cache
    const cachedForA = await cacheService.getTenantLink(tenantA.id, linkA.id);
    // Tenant B queries cache for Tenant A's linkId
    const cachedForB = await cacheService.getTenantLink(tenantB.id, linkA.id);

    log(`Tenant A Cache Lookup: ${cachedForA ? 'FOUND' : 'MISS'}`);
    log(`Tenant B Cache Lookup: ${cachedForB ? 'LEAKED' : 'BLOCKED (NULL)'}`);

    if (!cachedForA || cachedForB !== null) {
      throw new Error('Tenant isolation failure in cache: Tenant B retrieved Tenant A cached record!');
    }
    log('[PASS] Org scoping verified: Tenant B isolated from Tenant A cached metadata.');

    log('\n====================================================');
    log('MODULE 06 VERIFICATION SUMMARY: ALL CHECKS PASSED!');
    log('====================================================');

    const evidenceDir = path.join(process.cwd(), '..', '..', 'progress', 'evidence', 'module-06');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'caching-verification.txt');
    fs.writeFileSync(evidencePath, logs.join('\n'), 'utf-8');
    log(`\n[EVIDENCE] Full verification report saved to: ${evidencePath}`);
  } finally {
    await cacheService.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log('[SERVER] Test server shutdown cleanly.');
  }
}

main().catch((err) => {
  console.error('[FATAL] Verification suite error:', err);
  process.exit(1);
});

