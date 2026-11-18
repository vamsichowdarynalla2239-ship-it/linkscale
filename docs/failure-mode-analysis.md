# Failure Mode Analysis — LinkScale & Notification Delivery Service

**Default Failure Stance:** `fail_closed` (deny-by-default for authentication, tenant authorization, and primary write durability; explicit per-dependency `fail_open` overrides for read-through caching, async click analytics, and secondary notification failover queues).

---

## 1. External Dependency Inventory

| Dependency | Connection Method | Configured Timeout | Retry Behavior | Stance |
|---|---|---|---|---|
| **Primary Database (PostgreSQL / SQLite via Prisma)** | TCP / Local Pool (`apiPool`: 17, `workerPool`: 3) | Query timeout: 5,000ms (explicit target); Pool acquire: 3,000ms | No retries on non-idempotent writes; 2 retries with backoff on transient read errors | **Fail-Closed** |
| **Redis (Cache & Queue Broker)** | TCP (`ioredis`) | Connect: 1,000ms; Command: 250ms | `maxRetriesPerRequest: 1`; immediate graceful fallback | **Fail-Open** |
| **External Notification Providers (SendGrid, Twilio, Firebase)** | HTTPS (`fetch` + `AbortSignal.timeout`) | Connect + Response: 3,000ms (push) / 5,000ms (email/SMS) | Async queue retry (max 5 attempts, exponential backoff + full jitter -> DLQ) | **Fail-Open (Async Queue)** |
| **File System (Container OS / Logs)** | OS syscalls (stdout/stderr JSON) | N/A | None (stateless stdout logging; zero local log files) | **Fail-Open (Stateless)** |
| **DNS Resolver** | OS UDP/TCP resolver (53) | OS default 5s (target: local caching resolver + 2s cap) | OS retries up to 2 attempts | **Fail-Closed** |
| **Node.js Runtime (Memory / CPU / Event Loop)** | Container cgroups | Healthcheck timeout: 5s (`--interval=30s --retries=3`) | Orchestrator restart on OOM / liveness failure | **Fail-Closed (Restart)** |

---

## 2. Cascading Failure Propagation Map

```text
[External API / DB Slow (8s latency, no timeout)]
       |
       v
[In-Flight Requests Pile Up (http_requests_in_flight spikes)]
       |
       v
[Connection Pool & Socket Exhaustion (all 17 apiPool slots held)]
       |
       v
[Upstream Retries Amplify Load (Thundering Herd)]
       |
       v
[/ready & /live Probes Timeout -> Orchestrator Kills Healthy Pods -> Total Outage]
```

---

## 3. Comprehensive Failure Mode Table (12 Failure Modes)

| # | Dependency | Failure Mode | Probability | User Impact | Current Handling | Desired Handling |
|---|---|---|---|---|---|---|
| 1 | **Primary DB** | Connection refused (DB down) | Medium | Complete outage for writes & uncached reads; cached redirects survive | `GET /ready` returns 503; uncached routes return 500 via global error handler | Return structured 503 `Service Unavailable` with `Retry-After` header; isolate cached read path |
| 2 | **Primary DB** | Slow queries (lock contention / missing index) | High | Tail latency spikes; connection pool saturates, stalling unrelated routes | Prisma default lacks strict per-query statement timeout | Enforce PostgreSQL `statement_timeout=3000ms`, log slow queries >500ms, return 504 on timeout |
| 3 | **Redis Cache** | Redis unreachable / down | Medium | Higher latency as all reads hit DB; elevated DB CPU | Graceful fallback to DB (`cache.service.ts` logs `warn` and returns `null`) | Maintain fallback + add circuit breaker to avoid 250ms per-request connect penalties while Redis is down |
| 4 | **Redis Cache** | Stale data / invalidation lag | High | Deleted/updated links redirect to old target until TTL expires | Explicit cache eviction on `deleteLink` & `updateLink` + isolated `link:redirect:` namespace | Keep explicit eviction + bounded TTL (300s) + cache-version stamp on entity updates |
| 5 | **External API (Email/SMS/Push)** | Provider unreachable (5xx / ECONNREFUSED) | Medium | Notification delivery delayed or lost if synchronous | Worker retries with exponential backoff + full jitter (max 5 -> DLQ) | Add per-provider circuit breaker (open after 5 consecutive failures, 30s reset) + channel failover queue |
| 6 | **External API (Email/SMS/Push)** | Provider slow (5-30s latency) | High | Worker concurrency slots saturate; push SLA (<5s P99) breached | No hard HTTP `AbortSignal.timeout` on all outbound calls yet | Enforce strict per-channel timeouts (2s push, 5s email/SMS) + circuit breaker + async queue fallback |
| 7 | **File System** | Disk full (0 bytes free) | Low-Medium | Local log writes fail silently; SQLite/temp operations crash | Stateless stdout/stderr JSON logging avoids local log file growth | Monitor container ephemeral storage; alert at 80% disk usage; clean temp directories automatically |
| 8 | **Runtime (Memory)** | Out of Memory (OOM) | Low-Medium | OS OOM-killer terminates Node process; all in-flight requests dropped | In-memory log ring buffer capped at 500; container restart on exit | Set container memory limits (`512Mi`), `--max-old-space-size=384`, alert on heap >80% via `/metrics` |
| 9 | **Network** | Network partition (split brain / partial reachability) | Low | Service reachable from ingress, cannot reach primary DB or one provider | `/ready` returns 503 removing pod from LB while `/live` remains 200 | Keep `/live` decoupled from DB so orchestrator removes traffic without crash-looping pods |
| 10 | **DNS** | DNS resolution failure (`ENOTFOUND`) | Low | All outbound hostnames fail with cryptic connection errors | Propagates as generic network error in logs | Log explicit `syscall=getaddrinfo` error context; deploy node-local DNS cache; alert on elevated 5xx |
| 11 | **DB Connection Pool** | Pool exhaustion (worker retry storm) | High | Ingress API hangs while background jobs hold all DB connections | Bulkhead isolation (`workerPool=3`, `apiPool=17`) verified in Debugging Module 06 | Maintain bulkhead pools + export pool utilization gauge + alert when active/max > 85% |
| 12 | **System Clock** | Clock skew / NTP drift | Low | JWT tokens prematurely rejected or accepted past expiration; misaligned logs | Relies on host OS NTP; logs emit UTC ISO-8601 | Configure NTP sync checks on nodes + small JWT `clockTolerance` (5-10s) |

---

## 4. Empirical Failure Simulation Results

Executed via `scripts/verify-module-05-failure-modes.ts`:

| Simulation | Expected Behavior | Actual Behavior | Gap Identified |
|---|---|---|---|
| **1. Database Stopped (`ECONNREFUSED`)** | `GET /ready` returns 503 quickly; Prometheus logs 503; `/live` remains 200 | `GET /ready` returned HTTP **503** (`{"status":"unready","error":"Database dependency unavailable"}`) in **8.39ms**; structured `error` log emitted with `request_id=sim-db-down-1`; `http_requests_total{path="/ready",status="503"}` incremented to 1 | Readiness probe handles hard DB down cleanly, but business write routes still need explicit DB `statement_timeout` and structured 503 mapping instead of generic 500 |
| **2. Slow External Provider (1ms `AbortSignal.timeout`)** | Outbound call fails fast with timeout error instead of hanging 250ms | Aborted in **3ms** throwing `TimeoutError: The operation was aborted due to timeout`; structured `error` log recorded with `request_id=sim-timeout-1ms` | Outbound provider clients need standardized `AbortSignal.timeout` wrappers, circuit breakers, and fallback queueing so slow providers never exhaust worker slots (addressed in Module 06) |

---

## 5. Failure Classification: Transient vs. Permanent

| Failure Mode | Classification | Should Retry? | Handling Strategy |
|---|---|---|---|
| DB connection blip / restart (`ECONNREFUSED`) | **Transient** | Yes (reads only, max 2x backoff) | Return 503 on writes; circuit breaker + readiness removal |
| DB slow query / lock contention | **Transient** | No (amplifies lock queue) | Enforce 3s `statement_timeout`, fail fast with 504 |
| Invalid DB/Provider Credentials (`401/403`) | **Permanent** | **NEVER** | Fail fast, open circuit or page immediately; retrying wastes quota and triggers lockouts |
| Missing DB table / schema migration drift | **Permanent** | **NEVER** | Fail readiness probe, halt rollout, trigger rollback |
| Redis timeout / restart | **Transient** | Limited (1x fast fail) | Fail-open directly to DB; trip cache circuit breaker during sustained outage |
| External Provider `429` / `503` / Timeout | **Transient** | Yes (async queue, exponential backoff + full jitter, max 5 -> DLQ) | Respect `Retry-After`, trip circuit breaker, route to fallback channel |
| External Provider `400 Bad Request` (invalid email/phone) | **Permanent** | **NEVER** | Route directly to DLQ / permanent failure state; never retry malformed payloads |
| DNS hiccup (`EAI_AGAIN`) | **Transient** | Yes (OS resolver + bounded backoff) | Local DNS cache + explicit `getaddrinfo` error telemetry |
| Disk Full / OOM | **Permanent** (until mitigated) | No | Container restart (OOM) + automated disk alerts at 80% |

---

## 6. Risk-Ranked Top 3 Priorities (`Risk = Probability x Impact`)

1. **Rank #1 — Slow External Notification Providers (High Prob x Critical Cascading Impact):** Without hard `AbortSignal.timeout` caps and per-provider circuit breakers, a slow SMS/email vendor exhausts worker concurrency and breaches the 5s push SLA across all channels. **Fixed first in Module 06.**
2. **Rank #2 — Primary DB Slow Queries / Lock Contention (High Prob x Critical Blast Radius):** A single unindexed query or table lock holds connection pool slots indefinitely without `statement_timeout`, starving `/ready` and healthy endpoints.
3. **Rank #3 — Connection Pool / Redis Failover Thundering Herd (Medium-High Prob x High Impact):** Simultaneous cache misses or unjittered retries during a Redis or provider blip can overload the primary database if not guarded by bulkhead pools and jittered backoff.

**Non-Obvious Failure Modes Surfaced:** DNS resolution failures and system clock skew (NTP drift). Both are invisible during localhost testing, yet DNS outages masquerade as simultaneous multi-service timeouts while clock skew silently invalidates JWT auth tokens across nodes.

---

## 7. Post-BREAK Addendum: Newly Discovered Failure Modes & Basic Handling Verification

| # | Dependency | Failure Mode | Probability | User Impact | Previous Handling | Implemented Basic Handling |
|---|---|---|---|---|---|---|
| 13 | **Primary DB (Failover)** | Partial Failure — Read-Only Replica (`default_transaction_read_only=on`) | Medium | `GET` reads work normally; all `POST/PUT/DELETE` writes fail while `SELECT 1` health stays green | Generic HTTP 500 with opaque error message | `globalErrorHandler` detects read-only/connection failures, logs `failure_mode: "database_unavailable_or_readonly"`, and returns HTTP **503** with `Retry-After: 5` and safe message |

### Re-Simulation Verification Results

- **DNS Resolution Failure (`ENOTFOUND`):** Mapped to HTTP **503** (`DEPENDENCY_UNREACHABLE`), `Retry-After: 5`, structured log `failure_mode: "dns_resolution_failure"`, zero stack trace leaked.
- **Timeout Failure (`TimeoutError`):** Mapped to HTTP **504** (`UPSTREAM_TIMEOUT`), structured log `failure_mode: "dependency_timeout"`, zero stack trace leaked.
- **Read-Only DB Failover:** Mapped to HTTP **503** (`SERVICE_UNAVAILABLE`), `Retry-After: 5`, structured log `failure_mode: "database_unavailable_or_readonly"`.
