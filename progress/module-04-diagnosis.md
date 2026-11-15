# Module 04 Diagnosis: The Debugging Toolbox (Profiling, Memory Leaks & N+1 Queries)

## System Overview
- **Service**: LinkOps URL Shortener API
- **Module**: 04 (The Debugging Toolbox)
- **Bugs Diagnosed**: Bug #6 (Connection Pool Leak on Error Path) & Bug #7 (N+1 Query Bottleneck on Link Listing)

---

## Bug #6: Connection Pool Leak from Missing Finally Block

### 1. Observable Symptom
Under continuous traffic, the service becomes unresponsive or crashes after ~2,000 requests. Process metrics show available database connections monotonically decreasing toward zero until all requests block or fail with connection acquisition timeouts.

### 2. Runtime Profiling & Heap / Resource Analysis
Using heap inspection and resource tracking:
- On happy paths (`HTTP 200 / 302`), connections are acquired from the pool and released upon query completion.
- On error paths (e.g. database query timeout, constraint violations, or aborted clients representing ~10% of traffic), execution jumps directly to the `catch` block.
- Connection references remained pinned in memory and marked as `inUse: true`, bypassing garbage collection and pool return.

### 3. Root Cause
Classic resource leak pattern:
```typescript
// Buggy pattern (bypasses release on exception)
const conn = pool.acquire();
try {
  const result = await conn.query(...);
  conn.release(); // <-- Only executed on happy path
  return result;
} catch (error) {
  log(error);
  throw error; // <-- Connection leaked forever
}
```

### 4. Resolution: Guaranteed Cleanup via Finally Block
Enforced guaranteed release semantics using `finally`:
```typescript
let conn: PooledConnection | null = null;
try {
  conn = pool.acquire();
  return await operation(conn);
} finally {
  if (conn) {
    conn.release(); // Guarantees return to pool on both success and exception
  }
}
```

### 5. Verification
Automated test in `apps/api/scripts/verify-module-04-debug.ts`:
- **Reproduction**: Ran 15 iterations with 100% error injection under buggy handling; exactly exhausted the 10-connection pool at iteration 11 (`[POOL EXHAUSTION] Connection pool exhausted (10/10 connections in use)`).
- **Fix Verification**: Executed 2,000 operations with 10% error rate (200 injected failures) under safe `finally` handling: 100% of connections safely reclaimed, 0 leaked connections, 10/10 pool connections available.

---

## Bug #7: N+1 Query Bottleneck on Links Endpoint

### 1. Observable Symptom
The `GET /links` endpoint took >3 seconds to return a page of 50 links. Database telemetry revealed a barrage of queries fired in rapid succession for a single HTTP request.

### 2. Query Profiling & Log Analysis
Activating ORM query logging revealed 51 SQL queries per request:
```sql
-- Query 1 (find parent links)
SELECT * FROM "Link" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 50;

-- Queries 2..51 (N sequential child queries inside loop)
SELECT COUNT(*) FROM "ClickEvent" WHERE "linkId" = $1;
SELECT COUNT(*) FROM "ClickEvent" WHERE "linkId" = $2;
...
SELECT COUNT(*) FROM "ClickEvent" WHERE "linkId" = $50;
```
Each individual query took ~0.5ms locally, but across network latency and connection roundtrips, 51 queries caused extreme p95 tail latency degradation.

### 3. Root Cause
Application code looped over the fetched parent `Link` entities and sequentially awaited `prisma.clickEvent.count({ where: { linkId: link.id } })` instead of utilizing relational joins or ORM eager batch loading.

### 4. Resolution: Eager Loading with Batch Aggregation
Updated `listLinks` to leverage Prisma's `include: { _count: { select: { clicks: true } } }`:
```typescript
const [links, total] = await Promise.all([
  prisma.link.findMany({
    where: { tenantId: effectiveTenantId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip,
    take: limit,
    include: {
      _count: {
        select: { clicks: true },
      },
    },
  }),
  prisma.link.count({
    where: { tenantId: effectiveTenantId },
  }),
]);
```
Prisma compiles this into a single query with subquery aggregation or batch join:
```sql
SELECT "Link".*, (SELECT COUNT(*) FROM "ClickEvent" WHERE "ClickEvent"."linkId" = "Link"."id") AS "click_count"
FROM "Link"
WHERE "Link"."tenantId" = $1
ORDER BY "Link"."createdAt" DESC
LIMIT 50;
```

### 5. Verification & Benchmark
Automated benchmark in `apps/api/scripts/verify-module-04-debug.ts`:
- **N+1 Pattern**: 51 database queries dispatched; latency: ~22.39ms.
- **Eager Loading**: Exactly 1 database query dispatched; latency: ~1.81ms.
- **Query Count Reduction**: **98.0% drop** (from 51 queries to 1 query).
- **Latency Improvement**: **91.9% faster** execution.
- **Data Integrity**: 100% click count parity verified across all 50 items (150 total clicks).
- **End-to-End API**: `GET /links?limit=50` served in 12.65ms with full eager click metrics under authenticated tenant scoping.


---

## Step 5 & 6: ReDoS Catastrophic Backtracking Neutralization

### 1. Observable Symptom
Single `POST /links` requests taking 47-60 seconds and pinning 100% CPU on a single core, specifically on URLs containing long runs of repeating characters followed by an unexpected non-matching character:
`http://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!`

### 2. Forensic Analysis & Root Cause
Catastrophic Backtracking in Regular Expressions (CWE-1333):
- A nested greedy quantifier regex such as `/^https?:\/\/([a-zA-Z0-9_\-\.]+)+(\/[a-zA-Z0-9_\-\.]+)*$/` creates ambiguous parse states.
- Because both the inner group `+` and the outer group `+` can consume repeated `a` characters, when the trailing `!` character fails to match, the NFA engine backtracks across all $O(2^n)$ partitions ($2^{30} > 10^9$ recursive branch steps).
- The single-threaded Node.js event loop blocks completely during this computation.

### 3. Resolution: Deterministic WHATWG URL Parser + Length Guards
1. **Linear-Time Parsing**: Completely eliminated nested regexes in favor of the WHATWG URL standard parser (`new URL()`), which runs deterministically in $O(N)$ time with zero backtracking.
2. **Defensive Length Limits**: Enforced maximum URL bounds (`length <= 2048`) prior to parsing.
3. **Safe Anchor Prefix**: Simplified prefix checking to `/^https?:\/\//i` with no nested groupings.

### 4. Verification
- **Vulnerable Regex Benchmark**: Pathological string exhibited exponential compute doubling per character.
- **Production Endpoint Test**: Sent `http://example.com/` + `'a'.repeat(30)` + `'!'` to `POST /links`:
  * Responded in **88.09ms** without event loop starvation.
  * CPU utilization remained flat with zero backtracking stalls.
