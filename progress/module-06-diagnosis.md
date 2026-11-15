# Module 06 Diagnosis: Multi-Layer Bugs & Cross-Component Failure Modes

## Overview
- **Track**: Debugging & Incident Response (Operator Pack)
- **Module**: 06 - Multi-Layer Bugs
- **Focus**: Cross-system boundaries where individual components behave correctly in isolation, but the emergent interaction across layer contracts produces catastrophic system failure.
- **Bugs Diagnosed & Fixed**:
  - **Bug #9**: Stale Cache Serving Deleted Records (Cache-Aside contract omission)
  - **Bug #10**: Queue Retry Storm Starving Shared Connection Pool (Cascading resource contention)

---

## Part 1: Bug #9 — Stale Cache Serving Deleted Records

### 1. Incident Symptom
- **User Report**: "I deleted a short link through the admin API. The `DELETE /links/:id` request returned HTTP 200/204. But when I try the short link (`GET /r/:code`), it still redirects to the target destination. The deleted link is still active."
- **Paradox**: Every component performed its isolated unit specification correctly:
  - Database received `DELETE FROM links WHERE id = $1` and returned success (0 rows remaining).
  - Cache received `GET r:code` and returned the valid cached string.
  - Delete API handler called `prisma.link.delete()` and returned HTTP 204.
  - **System Outcome**: Stale redirect served for up to 5 minutes (cache TTL window).

### 2. Hypothesis-Driven Differential Diagnosis
- **Hypothesis 1**: *The database delete operation did not commit or failed silently.*
  - **Test**: Direct database query `SELECT * FROM links WHERE id = '<id>'`.
  - **Result**: Record is `NULL`. Hypothesis 1 is **DISPROVEN**.
- **Hypothesis 2**: *The redirect resolution path reads from Redis cache and bypasses PostgreSQL, and the delete handler omitted cache eviction.*
  - **Test**: Inspect Redis key `r:<code>` immediately following `DELETE /links/:id`.
  - **Result**: Redis key was still present with value `https://...`. Hypothesis 2 is **CONFIRMED**.

### 3. Root Cause Analysis
In a Cache-Aside (Lazy Loading) architecture:
- Reads populate the cache on miss (`setRedirectTarget(code, longUrl, TTL)`).
- Mutations (updates and deletes) **must explicitly evict** cached entries (`cache.del(key)`).
- The delete handler called `prisma.link.delete()` but failed to invoke `cacheService.invalidateRedirectTarget(existing.code)` and `cacheService.invalidateTenantLink(tenantId, id)`.

```
[Client] ──DELETE /links/:id──> [API] ──DELETE──> [PostgreSQL] (Success)
                                  │
                          (MISSING CALL) ──X──> [Redis Cache] (Key persists for 5m TTL!)
```

### 4. Implementation Fix
In `apps/api/src/services/link.service.ts`:
```typescript
async deleteLink(id: string, tenantId?: string): Promise<boolean> {
  const effectiveTenantId = tenantId || (await this.getOrCreateDefaultTenant());
  const existing = await prisma.link.findFirst({
    where: { id, tenantId: effectiveTenantId },
  });
  if (!existing) return false;

  await prisma.link.delete({ where: { id: existing.id } });

  // Cache-Aside Eviction: Evict public redirect cache and tenant metadata
  await cacheService.invalidateRedirectTarget(existing.code);
  await cacheService.invalidateTenantLink(effectiveTenantId, id);

  return true;
}
```

---

## Part 2: Bug #10 — Queue Retry Storm & Connection Pool Starvation

### 1. Incident Symptom
- **Monitoring Alert**: "The entire API has become unresponsive. No error messages. No process crashes. Incoming requests hang indefinitely. The `/ready` Kubernetes readiness probe times out, marking all pods Unready."
- **Diagnostic Observation**:
  - Process CPU is low (~2%).
  - Event loop is not blocked by synchronous CPU work.
  - Database server CPU is normal, but connection count is pegged at 100% capacity.
  - Zero database connections are available for incoming HTTP request handlers.

### 2. Twelve-Step Chain of Causation
1. An async click job encounters a transient or permanent error (e.g. invalid foreign key, constraint failure).
2. The queue worker catches the error and attempts retry.
3. **Flaw 1 (No Backoff)**: Worker retries immediately without exponential delay or jitter.
4. Each retry attempt acquires a database connection from the connection pool.
5. **Flaw 2 (No Retry Limit)**: Worker loops indefinitely without routing to a Dead-Letter Queue (DLQ).
6. Steps 3-5 repeat in a microsecond tight loop.
7. **Flaw 3 (Shared Pool)**: Worker shares the same database connection pool as the web API.
8. Within seconds, worker checkout requests exhaust 100% of available pool connections.
9. Incoming user-facing API requests require a database connection and are queued in pool wait queues.
10. API requests block and hang waiting for available connections until client timeouts trigger.
11. Infrastructure health check (`GET /ready` executing `SELECT 1`) cannot acquire a connection and times out.
12. Load balancer and container orchestrator take the service out of rotation, causing a complete outage.

```
+-------------------------------------------------------------------------------+
|                             CASCADING FAILURE CHAIN                           |
+-------------------------------------------------------------------------------+
|  [Queue Job Error]                                                            |
|          │                                                                    |
|          ▼                                                                    |
|  [Immediate Retry (0s Backoff)]                                               |
|          │                                                                    |
|          ▼                                                                    |
|  [Infinite Loop (>5 Retries, No DLQ)]                                         |
|          │                                                                    |
|          ▼                                                                    |
|  [Acquires DB Connections] ──> [Shared Connection Pool: 20/20 In Use (100%)]  |
|                                                     ▲                         |
|                                                     │ (Starved!)              |
|  [Incoming HTTP /links & /ready] ───────────────────┘                         |
|          │                                                                    |
|          ▼                                                                    |
|  [All API Requests & Health Checks Hang -> Complete Service Outage]           |
+-------------------------------------------------------------------------------+
```

### 3. The 3-Part Architectural Remedy
Any single fix is insufficient to guarantee resilience:

1. **Exponential Backoff with Full Jitter**:
   $$\text{delay} = \min(1000 \cdot 2^{\text{retryCount}}, 30000) + \text{jitter}(0..200\text{ms})$$
   Prevents tight retry loops and breaks phase-synchronized resonance storms across workers.

2. **Strict Maximum Retry Limit & Dead-Letter Queue (DLQ)**:
   Jobs are bounded to a maximum of 5 attempts. Permanently unprocessable jobs are ejected to `queue:clicks:dlq` with failure timestamp and root cause reason for offline inspection, preserving queue processing throughput.

3. **Bulkhead Resource Isolation (Dedicated Connection Pools)**:
   - `apiPool`: 17 dedicated connections reserved strictly for API requests and `/ready` probes.
   - `workerPool`: 3 dedicated connections strictly allocated to background queue workers.
   - Even if background workers saturate all 3 worker connections, the API pool maintains 17 idle connections, ensuring user traffic and health probes continue responding in sub-10ms latency.

---

## Part 4: Step 5 Break & Step 6 Fix — Cache Namespace Isolation

### 1. Incident Symptom
- **Analytics Anomaly**: After deploying the cache invalidation fix for Bug #9, the analytics team reported duplicate analytics events whenever links were deleted and re-created with the same short code.
- **Root Cause**: The redirect cache and analytics deduplication check were overloaded onto the same Redis key namespace (`r:<short_code>`). When `cache.del()` was added to `deleteLink`, it purged both the redirect destination AND the deduplication flag. When the short code was re-created, incoming click events for that short code were treated as unprocessed by the worker and recorded twice.

### 2. Architectural Fix: Strict Namespace Decoupling
Segregated key spaces into distinct domain prefixes:
- **Redirect Resolution**: `link:redirect:<short_code>` (evicted on link delete/update; never touches analytics).
- **Worker Deduplication**: `analytics:dedup:<event_or_job_id>` (persists with 24-hour TTL; isolated from link lifecycle).

### 3. Verification
- Saturated worker pool and proved API readiness remained HTTP 200 in 8ms.
- Verified that deleting a link purged `link:redirect:<code>` while preserving `analytics:dedup:<id>`. Replayed jobs were safely skipped with `status: deduplicated`, preventing all duplicate event counting.

---

## Part 5: Empirical Verification Results

Automated suite `apps/api/scripts/verify-module-06-debug.ts` executed and verified:
- [x] **Bug #9**: Initial redirect returned HTTP 302 (`X-Cache: MISS`); second returned HTTP 302 (`X-Cache: HIT`). Following `DELETE /links/:id`, verified database record was removed (`Hypothesis 1 disproven`) and cache key was evicted; subsequent redirect returned immediate `HTTP 404` (zero stale redirect window).
- [x] **Bug #10 Part 1 (Backoff)**: Verified exponential delay progression: 1070ms, 2154ms, 4082ms, 8140ms.
- [x] **Bug #10 Part 2 (DLQ)**: Simulated 5 failing attempts; 6th attempt routed message to Dead-Letter Queue with `status: dlq` and recorded error message.
- [x] **Bug #10 Part 3 (Bulkhead)**: Saturated 100% of worker pool (3/3 connections in use). Verified `GET /ready` responded in 8.04ms with `HTTP 200` (`status: ready, database: connected`) without being starved by worker exhaustion.
