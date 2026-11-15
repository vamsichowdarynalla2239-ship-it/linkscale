import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createApp } from '../src/app';
import { prisma } from '../src/db';

const PORT = 3001;
const EVIDENCE_DIR = path.resolve(__dirname, '../../../progress/evidence/module-08');
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'search-verification.txt');

async function main() {
  const outputLines: string[] = [];
  const log = (msg: string) => {
    console.log(msg);
    outputLines.push(msg);
  };

  log('====================================================');
  log('MODULE 08: SEARCH & ADVANCED QUERIES VERIFICATION');
  log('====================================================\n');

  // Ensure evidence directory exists
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

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

    // 1. Seed Tenant A Links with distinct URLs and tags
    log('\n--- 1. Seed Links for Tenant A & Tenant B ---');
    const tenantALinksData = [
      {
        url: 'https://acme.example.com/blog/ai-search-launch-2026',
        tags: ['marketing', 'launch', 'ai'],
        clicks: 5,
      },
      {
        url: 'https://acme.example.com/docs/api-reference-v2',
        tags: ['engineering', 'docs'],
        clicks: 2,
      },
      {
        url: 'https://acme.example.com/pricing/enterprise-discount',
        tags: ['sales', 'pricing'],
        clicks: 12,
      },
      {
        url: 'https://acme.example.com/blog/q4-launch-recap',
        tags: ['marketing', 'launch'],
        clicks: 0,
      },
      {
        url: 'https://acme.example.com/careers/senior-backend-engineer',
        tags: ['hr', 'careers'],
        clicks: 1,
      },
    ];

    const seededALinks: any[] = [];
    for (const item of tenantALinksData) {
      const res = await fetch(`http://localhost:${PORT}/links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': rawKeyA,
        },
        body: JSON.stringify({
          long_url: item.url,
          tags: item.tags,
        }),
      });
      const link = await res.json();
      if (res.status !== 201) throw new Error(`Failed to create Tenant A link: ${JSON.stringify(link)}`);

      // Seed click events directly in DB to test sort_by=clicks
      for (let i = 0; i < item.clicks; i++) {
        await prisma.clickEvent.create({
          data: {
            eventId: `clk_${link.id}_${i}`,
            linkId: link.id,
            tenantId: tenantA.id,
            clickedAt: new Date(Date.now() - i * 1000),
          },
        });
      }
      seededALinks.push({ ...link, targetClicks: item.clicks });
    }
    log(`[SEED] Seeded 5 links for Tenant A with tags and synthetic click records.`);

    // Seed Tenant B link (contains "launch" to verify isolation)
    const resB = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': rawKeyB,
      },
      body: JSON.stringify({
        long_url: 'https://rival.example.com/marketing/rival-launch-secret',
        tags: ['marketing', 'launch'],
      }),
    });
    const linkB = await resB.json();
    if (resB.status !== 201) throw new Error(`Failed to create Tenant B link: ${JSON.stringify(linkB)}`);
    log(`[SEED] Seeded 1 link for Tenant B: ${linkB.id} (${linkB.long_url})`);

    // 2. Test Route Precedence: GET /links/search does not hit /links/:id
    log('\n--- 2. Route Precedence Check ---');
    const routeCheckRes = await fetch(`http://localhost:${PORT}/links/search`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    log(`GET /links/search -> HTTP ${routeCheckRes.status}`);
    if (routeCheckRes.status !== 200) {
      throw new Error(`Route precedence failed! Expected HTTP 200, got ${routeCheckRes.status}`);
    }
    log(`[PASS] Route precedence verified: /links/search is correctly resolved before /links/:id.`);

    // 3. Test Keyword Search: ?q=launch
    log('\n--- 3. Substring Keyword Search (?q=launch) ---');
    const searchRes = await fetch(`http://localhost:${PORT}/links/search?q=launch`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    const searchData = await searchRes.json();
    log(`Search results count: ${searchData.data.length}, total: ${searchData.pagination.total}`);
    for (const item of searchData.data) {
      log(`  - Code: ${item.code}, URL: ${item.long_url}, Clicks: ${item.clicks}`);
    }
    if (searchData.pagination.total !== 2) {
      throw new Error(`Expected 2 results for q=launch, got ${searchData.pagination.total}`);
    }
    log(`[PASS] Substring keyword search returned exact matching records for Tenant A.`);

    // 4. Test Tag Filtering: ?tag=marketing
    log('\n--- 4. Tag Filtering (?tag=marketing) ---');
    const tagRes = await fetch(`http://localhost:${PORT}/links/search?tag=marketing`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    const tagData = await tagRes.json();
    log(`Tag filter count: ${tagData.data.length}, total: ${tagData.pagination.total}`);
    if (tagData.pagination.total !== 2) {
      throw new Error(`Expected 2 results for tag=marketing, got ${tagData.pagination.total}`);
    }
    log(`[PASS] Tag filtering successfully isolated tagged links.`);

    // 5. Test Combined Search: ?q=ai&tag=marketing
    log('\n--- 5. Combined Search (?q=ai&tag=marketing) ---');
    const combinedRes = await fetch(`http://localhost:${PORT}/links/search?q=ai&tag=marketing`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    const combinedData = await combinedRes.json();
    log(`Combined filter count: ${combinedData.data.length}, total: ${combinedData.pagination.total}`);
    if (combinedData.pagination.total !== 1 || !combinedData.data[0].long_url.includes('ai-search-launch-2026')) {
      throw new Error(`Combined search failed to intersect q and tag criteria properly`);
    }
    log(`[PASS] Combined search successfully intersected text search and tag filters.`);

    // 6. Test Pagination Calculations: page=1&page_size=2, page=2&page_size=2, page=3&page_size=2
    log('\n--- 6. Bounded Pagination Calculations ---');
    const p1Res = await fetch(`http://localhost:${PORT}/links/search?page=1&page_size=2`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    const p1 = await p1Res.json();
    log(`Page 1: items=${p1.data.length}, total=${p1.pagination.total}, total_pages=${p1.pagination.total_pages}`);

    const p2Res = await fetch(`http://localhost:${PORT}/links/search?page=2&page_size=2`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    const p2 = await p2Res.json();
    log(`Page 2: items=${p2.data.length}, total=${p2.pagination.total}, total_pages=${p2.pagination.total_pages}`);

    const p3Res = await fetch(`http://localhost:${PORT}/links/search?page=3&page_size=2`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    const p3 = await p3Res.json();
    log(`Page 3: items=${p3.data.length}, total=${p3.pagination.total}, total_pages=${p3.pagination.total_pages}`);

    // Boundary test: page beyond total
    const p4Res = await fetch(`http://localhost:${PORT}/links/search?page=4&page_size=2`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    const p4 = await p4Res.json();
    log(`Page 4 (beyond end): items=${p4.data.length}, total=${p4.pagination.total}, total_pages=${p4.pagination.total_pages}`);

    if (
      p1.data.length !== 2 ||
      p2.data.length !== 2 ||
      p3.data.length !== 1 ||
      p4.data.length !== 0 ||
      p1.pagination.total !== 5 ||
      p1.pagination.total_pages !== 3
    ) {
      throw new Error(`Pagination calculation error: expected [2, 2, 1, 0] items across pages 1..4 for total 5`);
    }
    log(`[PASS] Pagination metadata and windowing verified without off-by-one errors.`);

    // 7. Test Hard Limit / Ceiling: page_size=500 and invalid bounds
    log('\n--- 7. Hard Ceiling Capping Verification (?page_size=500) ---');
    const hugePageRes = await fetch(`http://localhost:${PORT}/links/search?page_size=500`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    log(`GET /links/search?page_size=500 -> HTTP ${hugePageRes.status}`);
    const hugePageData = await hugePageRes.json();
    if (hugePageRes.status !== 400 || hugePageData.error?.code !== 'VALIDATION_ERROR') {
      throw new Error(`Expected HTTP 400 VALIDATION_ERROR for page_size=500, got ${hugePageRes.status}`);
    }
    log(`[PASS] page_size ceiling enforced: oversized pagination request rejected with HTTP 400.`);

    // 8. Test Sorting Allowlist: sort_by=clicks vs malicious SQL injection
    log('\n--- 8. Sorting Allowlist & Multi-Relation Sorting ---');
    const sortClicksRes = await fetch(`http://localhost:${PORT}/links/search?sort_by=clicks&sort_order=desc`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    const sortClicksData = await sortClicksRes.json();
    log(`Top link by clicks: ${sortClicksData.data[0].long_url} (clicks=${sortClicksData.data[0].clicks})`);
    if (sortClicksData.data[0].clicks !== 12) {
      throw new Error(`Expected highest clicks to be 12, got ${sortClicksData.data[0].clicks}`);
    }

    const sortInvalidRes = await fetch(`http://localhost:${PORT}/links/search?sort_by=non_existent_column;DROP%20TABLE`, {
      headers: { 'X-API-Key': rawKeyA },
    });
    log(`Invalid sort parameter -> HTTP ${sortInvalidRes.status}`);
    if (sortInvalidRes.status !== 400) {
      throw new Error(`Expected HTTP 400 for unallowlisted sort_by, got ${sortInvalidRes.status}`);
    }
    log(`[PASS] Sorting allowlist verified: relation count sorting operational, unallowlisted columns rejected.`);

    // 9. Multi-Tenant Boundary Isolation
    log('\n--- 9. Strict Multi-Tenant Data Isolation ---');
    // Search with Tenant B's API key for "launch"
    const tenantBSearchRes = await fetch(`http://localhost:${PORT}/links/search?q=launch`, {
      headers: { 'X-API-Key': rawKeyB },
    });
    const tenantBSearchData = await tenantBSearchRes.json();
    log(`Tenant B search (?q=launch) returned ${tenantBSearchData.data.length} links (total=${tenantBSearchData.pagination.total})`);
    if (tenantBSearchData.pagination.total !== 1 || !tenantBSearchData.data[0].long_url.includes('rival-launch-secret')) {
      throw new Error(`Tenant B received incorrect records or leaked Tenant A data!`);
    }

    // Verify Tenant A search never contained Tenant B's link
    const leaked = searchData.data.some((item: any) => item.long_url.includes('rival'));
    if (leaked) {
      throw new Error(`CRITICAL: Cross-tenant data leak! Tenant A search returned Tenant B links.`);
    }
    log(`[PASS] Multi-tenant isolation verified: zero cross-tenant leak across search and filtering.`);

    log('\n====================================================');
    log('ALL MODULE 08 VERIFICATION CHECKS PASSED (8/8)');
    log('====================================================');

    fs.writeFileSync(EVIDENCE_FILE, outputLines.join('\n'), 'utf-8');
    log(`\nEvidence written to: ${EVIDENCE_FILE}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});

