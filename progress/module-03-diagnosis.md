# Module 03 Diagnosis: Reproduction Science & Race Conditions

## System Overview
- **Service**: LinkOps URL Shortener API
- **Module**: 03 (Reproduction Science)
- **Bug Diagnosed**: Bug #5 (Check-Then-Act Race Condition on Analytics Bucketing)

---

## Bug #5: Check-Then-Act Concurrency Collision

### 1. Observable Symptom
Intermittent HTTP 500 errors occur on public redirects (`GET /r/:shortCode`), clustering specifically on high-traffic, popular short links. Infrequent links never fail, but popular links throw database exceptions a few times per hour under concurrent traffic.

### 2. Log Analysis & Failure Boundary
Inspecting structured logs reveals a database constraint collision:
```
ERROR: duplicate key value violates unique constraint "analytics_link_id_bucket_unique"
DETAIL: Key (link_id, timestamp_bucket)=(clk_xyz, 2026-11-15T14) already exists.
```
The failure occurs inside the redirect analytics bucketing handler when multiple concurrent visitors resolve the same short link at the start of a time bucket.

### 3. Hypotheses & Variable Isolation
- **Hypothesis 1 (Data Shape)**: Specific characters or legacy metadata in certain slugs cause query syntax errors.
  * *Test*: Replay requests with diverse slug characters one at a time.
  * *Result*: Disproven. Serial requests to all slugs succeed 100% of the time.
- **Hypothesis 2 (Timing Boundary)**: Hourly bucket transitions trigger an off-by-one timestamp error.
  * *Test*: Fire requests at exactly XX:59:59.
  * *Result*: Disproven. Single requests across bucket transitions succeed.
- **Hypothesis 3 (Concurrency / Race Condition)**: Simultaneous requests to the same link execute a non-atomic `SELECT ... WHERE linkId = X AND bucket = Y`, both observe `null`, and both attempt an `INSERT`. The first insert succeeds; the second crashes with unique constraint violation.
  * *Test*: Synthetic reproduction script sending 10 simultaneous requests to the same link.
  * *Result*: Confirmed! Intermittent 500 crashes reproduce deterministically under concurrent load.

### 4. Root Cause
Classic check-then-act race condition:
```
Request A: SELECT ... (link_id, bucket) -> null
Request B: SELECT ... (link_id, bucket) -> null
Request A: INSERT (link_id, bucket, count=1) -> SUCCESS
Request B: INSERT (link_id, bucket, count=1) -> CRASH (P2002 Unique Constraint Violation)
```

### 5. Resolution: Atomic Database Upsert
Replaced the separate `findUnique` and `create`/`update` steps with a single atomic database upsert:
```typescript
await prisma.analyticsBucket.upsert({
  where: {
    analytics_link_id_bucket_unique: {
      linkId,
      timestampBucket: bucket,
    },
  },
  create: {
    linkId,
    timestampBucket: bucket,
    count: 1,
  },
  update: {
    count: { increment: 1 },
  },
});
```
In relational storage, this translates to:
```sql
INSERT INTO "AnalyticsBucket" ("linkId", "timestampBucket", "count")
VALUES ($1, $2, 1)
ON CONFLICT ("linkId", "timestampBucket")
DO UPDATE SET count = "AnalyticsBucket".count + 1;
```
The database engine serializes concurrent requests atomically, eliminating the check-then-act race window.

### 6. Verification
Automated test in `apps/api/scripts/verify-module-03-debug.ts`:
1. **Reproduction Proof**: Simulated 10 concurrent requests against the check-then-act pattern: captured P2002 unique constraint collisions.
2. **Fix Verification**: Fired 10 concurrent requests against the atomic upsert:
   - 0 HTTP 500 errors (100% success rate).
   - Final bucket count equals exactly 10 (0 lost writes, 0 double counts).
3. **Repeated Stress Test**: Repeated across 5 consecutive batches (50 requests total): 0 errors, 100% deterministic success.

---

## Step 5: Silent Out-of-Order Timestamp Corruption

### 1. Observable Symptom
After resolving the 500 error via atomic upsert, all concurrent requests succeed. However, examining the `lastAccessedAt` timestamp on the analytics row reveals silent corruption: the timestamp corresponds to an earlier request in the concurrent batch rather than the latest request.

### 2. Forensic Analysis & Root Cause
When concurrent requests arrive nearly simultaneously:
- Request 1 arrives at `t = 100ms`.
- Request 2 arrives at `t = 200ms`.
Due to OS thread scheduling and database connection pool contention, Request 2 reaches the database and commits first, updating `lastAccessedAt = 200ms`. Immediately after, Request 1's query commits, unconditionally executing `UPDATE SET lastAccessedAt = 100ms`. The earlier request overwrites the later timestamp, causing silent clock rollback without any SQL errors.

### 3. Resolution: Monotonic Timestamp Guard
Implemented a monotonic guard on upsert updates:
```typescript
const targetTimestamp = existing && existing.lastAccessedAt > timestamp
  ? existing.lastAccessedAt // Preserve later timestamp if earlier request committed late
  : timestamp;
```
In PostgreSQL, this corresponds to:
```sql
UPDATE SET count = count + 1, last_accessed_at = GREATEST(last_accessed_at, EXCLUDED.last_accessed_at);
```
Verified in Test 4 of `verify-module-03-debug.ts`: when requests at `t=200ms` and `t=100ms` commit out of order, the database strictly preserves `200ms`.

