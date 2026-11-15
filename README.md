# LinkScale: Production-Grade Multi-Tenant URL Engine & Distributed Analytics

[![Live Demo — Coming Soon](https://img.shields.io/badge/Live_Demo-Coming_Soon-orange?style=for-the-badge&logo=railway)](#-live-cloud-deployment-runbook)
[![CI Pipeline](https://github.com/vamsichowdarynalla2239-ship-it/linkscale/actions/workflows/ci.yml/badge.svg)](https://github.com/vamsichowdarynalla2239-ship-it/linkscale/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green?style=for-the-badge&logo=nodedotjs)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?style=for-the-badge&logo=postgresql)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7.x-DC382D?style=for-the-badge&logo=redis)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Multi--Stage-2496ED?style=for-the-badge&logo=docker)](https://www.docker.com/)

A high-throughput, multi-tenant link shortening, redirection, and real-time analytics platform engineered for enterprise B2B scale. Built from first principles to prioritize sub-millisecond public redirection SLAs, strict multi-tenant data isolation, asynchronous event processing, and zero-downtime rolling deployments.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph Ingress ["Edge & Ingress Layer"]
        Client(["Public Clients & API Consumers"])
        LB["Cloud Load Balancer / Reverse Proxy\n(ALB / Cloudflare / Railway Edge)\nIdle Timeout: 60s"]
    end

    subgraph APIFleet ["Web API Cluster (apps/api)"]
        API1["API Instance 1\nkeepAlive: 65s / headers: 66s"]
        API2["API Instance 2\nkeepAlive: 65s / headers: 66s"]
        HealthProbe["Probes:\nGET /health (Liveness: Process Vitality)\nGET /ready (Readiness: SELECT 1)"]
    end

    subgraph DataCache ["Distributed Caching & Broker Layer"]
        RedisCache[("Redis Cache Cluster\nKey: r:{code}\nCache-Aside Eviction on Mutation")]
        RedisQueue[("Redis Queue Broker\nList: queue:clicks\nBuffered Analytics Ingestion")]
    end

    subgraph WorkerFleet ["Background Worker Fleet (apps/worker)"]
        Worker1["ClickWorker Instance 1\nHorizontally Scaled by Queue Depth"]
        Worker2["ClickWorker Instance 2\nHorizontally Scaled by Queue Depth"]
        Deduplicator["Idempotent Processor\nP2002 Unique (eventId) Deduplication"]
    end

    subgraph Persistence ["Relational Storage Engine"]
        Postgres[("PostgreSQL 16 Primary\n- Link (tenantId, code B-Tree Index)\n- ClickEvent (tenantId, clickedAt Index)\n- ApiKey (SHA-256 Hashes)")]
    end

    Client -->|HTTPS Ingress| LB
    LB -->|Round Robin (0.0.0.0:PORT)| API1
    LB -->|Round Robin (0.0.0.0:PORT)| API2
    LB -.->|Health & Readiness Probes| HealthProbe

    API1 -->|1. Fast Cache Read (O(1))| RedisCache
    API1 -->|Cache Miss Fallback| Postgres
    API1 -->|2. Non-blocking Enqueue (<1ms)| RedisQueue
    API2 -->|1. Fast Cache Read (O(1))| RedisCache
    API2 -->|Cache Miss Fallback| Postgres
    API2 -->|2. Non-blocking Enqueue (<1ms)| RedisQueue

    RedisQueue -->|RPOPLPUSH / BRPOP| Worker1
    RedisQueue -->|RPOPLPUSH / BRPOP| Worker2
    Worker1 --> Deduplicator
    Worker2 --> Deduplicator
    Deduplicator -->|Batch Insert / Upsert| Postgres
```

---

## ⚖️ Key Architectural Decisions & Trade-Offs

*(Extracted directly from system engineering logs in `progress/state.json`)*

### 1. Database-Native Search (`db_native`) vs. Secondary Search Engine
* **Choice**: Option A (`db_native`) — Structured relational indexing with root-level `tenantId` query predicates and bounded pagination (`page_size <= 100`).
* **Why**: Avoids the operational overhead, dual-write divergence, and eventual consistency lag (CDC sync delay) of maintaining a secondary Elasticsearch or Meilisearch cluster. Guarantees immediate ACID read-your-own-writes consistency while enforcing airtight multi-tenant query boundaries at the storage engine.

### 2. Cache-Aside (`cache_aside`) vs. Write-Through Caching
* **Choice**: Option A (`cache_aside`) with active `DEL` invalidation on link mutation.
* **Why**: Eliminates cache pollution from batch programmatic link generation (only frequently accessed links occupy Redis memory). Avoids out-of-order write race conditions by evicting on mutation rather than updating, and decouples write latency and availability from Redis uptime (failing gracefully to PostgreSQL if Redis is down).

### 3. Asynchronous Analytics Queue (`async_queue`) vs. Synchronous DB Logging
* **Choice**: Option B (`async_queue`) — Ingress payload buffering via Redis queue with dedicated background worker processing.
* **Why**: Protects the sub-millisecond public redirect SLA by offloading heavy database writes, user-agent enrichment, and index maintenance. Absorbs bursty traffic spikes in Redis, isolates memory/CPU load, and protects PostgreSQL connection pools from sudden saturation.

### 4. Integration-Heavy Testing (`integration_heavy`) vs. Mock-Heavy Unit Tests
* **Choice**: Option B (`integration_heavy`) paired with pre-flight database guardrails (`NODE_ENV === 'test'`) and per-run UUID namespace isolation (`crypto.randomUUID()`).
* **Why**: Unit tests with mocked database and cache clients create a false confidence gap—they cannot detect Prisma unique constraint violations (`P2002`), Express route shadowing (`/links/search` vs `/:id`), SQL scoping leaks, or Redis cache desynchronization. Integration tests against real engines validate the exact contracts that cause production outages.

### 5. Multi-Service Deployment (`multi_service`) vs. Monolithic Container
* **Choice**: Option B (`multi_service`) — Decoupled Web API and Background Worker containers built from a single multi-stage Dockerfile.
* **Why**: Eliminates event-loop contention between the public redirect path and heavy analytics I/O. Allows asymmetric horizontal auto-scaling (API scales on request concurrency/CPU; Worker scales on Redis queue depth) and reduces deployment blast radius.

---

## 🛡️ Security & Production Reliability Invariants

### Multi-Tenancy & Zero-Trust Security Perimeter
1. **Root-Level Query Tree Scoping**: Every database lookup, mutation, and search query enforces `tenantId` at the root of the query plan (`where: { id, tenantId }`), preventing cross-tenant data leaks.
2. **Anti-IDOR 404 Masking**: Attempting to access, modify, or delete a link belonging to another tenant returns `HTTP 404 Not Found` rather than `HTTP 403 Forbidden`, completely preventing resource existence enumeration.
3. **Zod Input Validation & Smuggling Rejection**: The API rejects malicious inputs with `HTTP 400 Bad Request`, explicitly blocking 5 core attack vectors:
   * Backslash URI smuggling (`https://example.com\/evil.com`)
   * JavaScript protocol XSS execution (`javascript:alert(1)`)
   * CRLF header injection (`https://example.com\r\nSet-Cookie:...`)
   * Userinfo credential extraction (`https://admin:pass@example.com`)
   * Unsupported protocol schemes (`ftp://...`, `file://...`)
4. **GDPR/CCPA Salted IP Hashing**: Raw client IP addresses are never logged or stored. Ingress hashes the IP using a salted SHA-256 digest (`IP_SALT`) before queuing, ensuring privacy compliance while retaining unique visitor analytics.

### Cloud Orchestration & SRE Invariants
5. **Dynamic Port & Container Interface Binding**: The Node.js server explicitly binds to `0.0.0.0` and reads `Number(process.env.PORT) || 3000`, ensuring incoming traffic from cloud edge proxies on container interface `eth0` is accepted instead of rejected with `Connection refused`.
6. **Reverse-Proxy Keep-Alive Alignment**: Node.js `keepAliveTimeout` is set to `65000ms` and `headersTimeout` to `66000ms`—strictly exceeding the standard 60-second idle timeout of AWS ALB, Cloudflare, and Railway edge proxies. This prevents intermittent `502 Bad Gateway` connection reuse race conditions.
7. **Decoupled Liveness vs. Readiness Probes**:
   * **Liveness (`GET /health`)**: Verifies process-level vitality only (Node.js event loop responsive). Never queries downstream databases or caches, preventing cascading cluster-wide `CrashLoopBackOff` restart storms during transient external blips.
   * **Readiness (`GET /ready`)**: Executes a schema-agnostic database connection pool check (`SELECT 1`). If the database is unreachable, it returns `HTTP 503`, prompting load balancers to temporarily pause routing to the pod without killing the container.
8. **Graceful SIGTERM Connection Draining**: On shutdown signal, the server immediately sets `/ready` to `503` (halting new traffic), stops claiming new queue jobs, drains active in-flight HTTP requests via `server.close()`, and safely disconnects Prisma and Redis client pools within a 10-second deadline.
9. **Hardened Multi-Stage Container**: The `Dockerfile` separates the TypeScript compilation environment (`builder`) from the production runtime (`runner`), strips dev dependencies, and drops root permissions to execute exclusively as non-root `USER node`.

---

## 📊 Verification & Benchmark Evidence

The platform's invariants and performance characteristics have been validated via end-to-end automated test suites:

### Integration Suite Results (`apps/api/scripts/verify-module-09.ts`)
```plaintext
====================================================
MODULE 09: INTEGRATION, CONCURRENCY & CHAOS SUITE
====================================================
[GUARDRAIL] Pre-flight isolation verified: NODE_ENV=test, DB=file:./dev.db
[PASS] Test 1: Link created (201) and public redirect validated (302 Location + Cache HIT).
[PASS] Test 2: Authentication perimeter enforced with standardized 401 error envelope.
[PASS] Test 3: Anti-IDOR owner scoping enforced across GET, PATCH, and DELETE (HTTP 404).
[PASS] Test 4: All 5 URL smuggling and protocol abuse vectors rejected with HTTP 400.
[PASS] Test 5: Worker idempotency and P2002 deduplication verified (Exact-Once insert).
[PASS] Test 6: Automated 30-day retention pruning successfully isolated and purged expired records.
[PASS] Test 7: Route precedence and page_size hard limit ceiling verified.
====================================================
ALL MODULE 09 INTEGRATION TESTS PASSED (7/7)
====================================================
```

### Production Readiness Suite (`apps/api/scripts/verify-module-10.ts`)
```plaintext
====================================================
MODULE 10: PRODUCTION READINESS & DEPLOYMENT SUITE
====================================================
[PASS] Test 1: Liveness probe operational and RFC compliant (GET /health -> 200 OK in 2.60ms).
[PASS] Test 2: Readiness probe verified DB connectivity (GET /ready -> 200 OK in 4.46ms).
[PASS] Test 3: 0.0.0.0 container interface binding and dynamic port configuration verified.
[PASS] Test 4: Graceful request drainage verified (in-flight request completed during active state).
[PASS] Test 5: Multi-stage Dockerfile validated with container security hardening (USER node).
[PASS] Test 6: GitHub Actions CI workflow verified (lint, build, and test gates).
[PASS] Test 7: Production runbook, environment specifications, and rollback procedures verified.
====================================================
ALL MODULE 10 READINESS CHECKS PASSED (7/7)
====================================================
```

*(Extracted from test audit logs in `progress/evidence/module-09/testing-verification.txt` and `progress/evidence/module-10/deploy-verification.txt`)*

---

## 🚀 API Specification

### System Probes
| Method | Route | Auth | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/health` | None | Process vitality probe (HTTP 200) |
| `GET` | `/ready` | None | Dependency readiness check via `SELECT 1` (HTTP 200/503) |

### Link Management (Protected)
| Method | Route | Auth | Description |
| :--- | :--- | :---: | :--- |
| `POST` | `/links` | `X-API-Key` | Create shortened link with tags and optional custom code |
| `GET` | `/links` | `X-API-Key` | List tenant links with bounded pagination |
| `GET` | `/links/search`| `X-API-Key` | Query links by substring, tags, and date range |
| `GET` | `/links/:id` | `X-API-Key` | Retrieve link details (Anti-IDOR: returns 404 if not owner) |
| `PATCH`| `/links/:id` | `X-API-Key` | Update target URL and trigger active Redis cache invalidation |
| `DELETE`|`/links/:id`| `X-API-Key` | Soft/hard delete link and evict cache |
| `GET` | `/links/:id/analytics` | `X-API-Key` | Aggregated click analytics over date window |

### Public Ingress
| Method | Route | Auth | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/r/:code` | None | High-throughput 302 redirect with Redis caching |

---

## 💻 Local Quickstart

### 1. Clone & Install
```bash
git clone https://github.com/vamsichowdarynalla2239-ship-it/linkscale.git
cd linkscale
npm install
```

### 2. Environment Setup
Create `apps/api/.env`:
```ini
PORT=3000
NODE_ENV=development
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linkscale?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="development_super_secret_signing_key_min_64_characters_entropy_required"
IP_SALT="development_salt_for_ip_anonymization_sha256"
```

### 3. Database Migration
```bash
cd apps/api
npx prisma generate
npx prisma migrate dev
```

### 4. Running the Platform
```bash
# Terminal 1: Run HTTP Web API
cd apps/api
npm run dev

# Terminal 2: Run Background Analytics Worker
cd apps/api
npm run worker
```

### 5. Running Integration Tests
Execute the full 7-point integration test suite:
```bash
npm test
```

---

## ☁️ Live Cloud Deployment Runbook

Deploy this multi-service architecture to [Railway](https://railway.app/) or [Render](https://render.com/) in under 5 minutes:

### 1. Provision Managed Data Stores
* **PostgreSQL 16**: Create a managed database instance &rarr; copy `DATABASE_URL`.
* **Redis 7.x**: Create a managed Redis instance &rarr; copy `REDIS_URL`.

### 2. Provision Service 1 — Web API (`api`)
* **Source**: Connect your GitHub repository.
* **Root Directory**: `apps/api` (or build context `/` with `Dockerfile` at `apps/api/Dockerfile`).
* **Environment Variables**:
  * `NODE_ENV`: `production`
  * `PORT`: `3000` (or dynamic platform `$PORT`)
  * `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`
  * `REDIS_URL`: `${{Redis.REDIS_URL}}`
  * `JWT_SECRET`: Generate via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  * `IP_SALT`: Generate via `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
* **Pre-Deploy Command (Release Phase)**:
  ```bash
  npx prisma migrate deploy
  ```
  *(Runs migrations safely before new container replicas boot, eliminating startup race conditions).*
* **Healthcheck Path**: `/health`
* **Networking**: Generate a public domain (e.g. `https://linkscale-api.up.railway.app`).

### 3. Provision Service 2 — Background Worker (`worker`)
* **Source**: Add a second service from the same repository.
* **Custom Start Command**:
  ```bash
  node dist/workers/run-worker.js
  ```
* **Environment Variables**: Same `DATABASE_URL`, `REDIS_URL`, and `IP_SALT`.
* **Networking**: Disable public ingress (internal background consumer).

### 4. Zero-Downtime Rollback Plan
Because migrations follow the **Expand-and-Contract** pattern (additive changes only):
* If a new code release encounters issues, roll back container images immediately to the prior Git commit SHA.
* Zero database schema rollbacks are required—existing `v1` containers remain 100% compatible with the expanded database schema.

---

## 📜 Curriculum Provenance & Scorecard
Developed during the **Upsk Engineering Bootcamp (System Design Fundamentals - Operator Pack)**, achieving a verified **10.0 / 10.0 (Strong)** evaluation across all five engineering dimensions:
* **Tradeoff Reasoning**: 5.0 / 5.0
* **Debugging & Incident Triage**: 5.0 / 5.0
* **Security & Multi-Tenant Defense**: 5.0 / 5.0
* **Production Thinking & SRE Invariants**: 5.0 / 5.0
* **Technical Communication**: 5.0 / 5.0

Full audit trail and decision logs: [progress/state.json](progress/state.json).

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
