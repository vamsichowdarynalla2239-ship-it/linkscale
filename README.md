# LinkScale: Production-Grade Multi-Tenant URL Engine, Notification Delivery & SRE Platform

[![Live Production Demo](https://img.shields.io/badge/Live_Demo-Railway_Production-0B0D0E?style=for-the-badge&logo=railway)](https://linkscale-api-production.up.railway.app/ready)
[![CI Pipeline](https://github.com/vamsichowdarynalla2239-ship-it/linkscale/actions/workflows/ci.yml/badge.svg)](https://github.com/vamsichowdarynalla2239-ship-it/linkscale/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-green?style=for-the-badge&logo=nodedotjs)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-336791?style=for-the-badge&logo=postgresql)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-8.2-DC382D?style=for-the-badge&logo=redis)](https://redis.io/)
[![Prometheus](https://img.shields.io/badge/Prometheus-RED_Metrics-E6522C?style=for-the-badge&logo=prometheus)](https://linkscale-api-production.up.railway.app/metrics)
[![Docker](https://img.shields.io/badge/Docker-Multi--Stage-2496ED?style=for-the-badge&logo=docker)](https://www.docker.com/)
[![Upsk Verified](https://img.shields.io/badge/Upsk_Curriculum-25%2F25_Modules_10.0%2F10.0-brightgreen?style=for-the-badge)](https://www.upsk.to/vamsichowdarynalla22)

**Live Production Deployment:** [https://linkscale-api-production.up.railway.app](https://linkscale-api-production.up.railway.app/ready) · [Liveness (`/live`)](https://linkscale-api-production.up.railway.app/live) · [Readiness (`/ready`)](https://linkscale-api-production.up.railway.app/ready) · [Prometheus Metrics (`/metrics`)](https://linkscale-api-production.up.railway.app/metrics)

A high-throughput, multi-tenant link shortening, real-time analytics, and resilient notification delivery platform engineered from first principles for enterprise B2B scale. Hardened end-to-end across **System Design**, **Distributed Debugging & Incident Response**, and **Production Readiness**—delivering sub-10ms cached redirects, bulkhead pool isolation, Prometheus RED observability, `opossum` circuit breakers, live-tested 3 AM operational runbooks, and verified zero-downtime rolling deployments with sub-2-minute rollbacks.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph Ingress ["Edge & Ingress Layer"]
        Client(["Public Clients & API Consumers"])
        LB["Cloud Load Balancer / Reverse Proxy\n(Fly Edge / ALB / Cloudflare)\nRolling Deploy (max_unavailable: 0)"]
    end

    subgraph APIFleet ["Web API Cluster (apps/api — Non-Root node:20-slim)"]
        API1["API Instance 1\nkeepAlive: 65s / headers: 66s\nBulkhead apiPool: 17 conns"]
        API2["API Instance 2\nkeepAlive: 65s / headers: 66s\nBulkhead apiPool: 17 conns"]
        Probes["Probes & Telemetry:\nGET /live & /health (Liveness)\nGET /ready (2s DB Probe + Config Fingerprint)\nGET /metrics (Prometheus RED + Gauges)"]
        Breaker["NotificationService\nAbortController Timeout (1s)\nopossum CircuitBreaker + FIFO Fallback Queue"]
    end

    subgraph DataCache ["Distributed Caching & Broker Layer"]
        RedisCache[("Redis Cache Cluster\nNamespaces: link:redirect:{code}\nanalytics:dedup:{eventId}")]
        RedisQueue[("Redis Queue Broker\nqueue:clicks + queue:clicks:dlq\nExponential Backoff + Full Jitter")]
    end

    subgraph WorkerFleet ["Background Worker Fleet (apps/worker)"]
        Worker1["ClickWorker Instance 1\nBulkhead workerPool: 3 conns"]
        Worker2["ClickWorker Instance 2\nMax 5 Retries -> DLQ"]
        Deduplicator["Idempotent Processor\nP2002 Unique (eventId) Deduplication"]
    end

    subgraph Persistence ["Relational Storage & Observability"]
        Postgres[("PostgreSQL 16 Primary\n- Link (tenantId, code B-Tree Index)\n- ClickEvent (tenantId, clickedAt Index)\n- ApiKey (SHA-256 Hashes)")]
        Prom["Prometheus + Alertmanager\ninfra/alerts.yml (4 Golden Rules)"]
    end

    Client -->|HTTPS Ingress| LB
    LB -->|Round Robin (0.0.0.0:PORT)| API1
    LB -->|Round Robin (0.0.0.0:PORT)| API2
    LB -.->|Liveness & Readiness Gating| Probes
    Prom -.->|Scrape /metrics| Probes

    API1 -->|1. O(1) Cache Read| RedisCache
    API1 -->|Cache Miss Fallback| Postgres
    API1 -->|2. Non-blocking Enqueue (<1ms)| RedisQueue
    API1 --> Breaker
    API2 -->|1. O(1) Cache Read| RedisCache
    API2 -->|Cache Miss Fallback| Postgres
    API2 -->|2. Non-blocking Enqueue (<1ms)| RedisQueue
    API2 --> Breaker

    RedisQueue -->|BRPOP / Backoff| Worker1
    RedisQueue -->|BRPOP / Backoff| Worker2
    Worker1 --> Deduplicator
    Worker2 --> Deduplicator
    Deduplicator -->|Batch Insert / Upsert| Postgres
```

---

## 🚀 Enterprise Production Engineering & Resilience

*(Hardened in Production Readiness & Debugging tracks — commit `ab7e59b`)*

### 1. Observability & Alerting
* **Prometheus RED Metrics (`GET /metrics`):** Powered by `prom-client` in [`apps/api/src/utils/metrics.ts`](apps/api/src/utils/metrics.ts) and [`apps/api/src/middleware/metrics.middleware.ts`](apps/api/src/middleware/metrics.middleware.ts), exposing `http_requests_total`, `http_request_duration_seconds` histograms, `http_requests_in_flight`, `notification_queue_depth{channel}`, `circuit_breaker_state`, and Node.js heap/event-loop metrics. Dynamic path segments (`/r/:code`, `/links/:id`) are normalized to prevent Prometheus time-series cardinality explosions.
* **Structured JSON Logging & Secret Scrubbing:** [`apps/api/src/utils/logger.ts`](apps/api/src/utils/logger.ts) emits UTC ISO-8601 JSON logs stamped with `service_name` and correlated `request_id` (`X-Request-Id`), neutralizing CRLF injection (CWE-117) and automatically redacting sensitive headers, keys, and inline URI credentials (`://user:pass@` &rarr; `://[REDACTED]@`).
* **Actionable PromQL Alerting:** [`infra/alerts.yml`](infra/alerts.yml) defines 4 fatigue-resistant rules with sustained `for:` windows, severity tiers, and direct runbook links: `HighErrorRate` (`5xx > 5%` for `2m`), `HighLatency` (`p95 > 2s` for `3m`), `ServiceDown` (`up == 0` for `1m`), and `HighHeapMemoryUsage` (`heap > 85%` for `5m`).

### 2. Fault Tolerance & Graceful Degradation
* **Explicit Timeouts, Jittered Retries & Circuit Breakers:** [`apps/api/src/utils/resilience.ts`](apps/api/src/utils/resilience.ts) wraps outbound calls with `AbortController` timeouts (`withTimeout`), transient-only exponential backoff with mandatory jitter floors (`retryWithBackoff`, clamped `maxRetries <= 10`, `jitterMs >= 5ms`, zero retries on permanent `4xx` errors), and `opossum` circuit breakers (`createResilientBreaker`) wired to Prometheus gauges.
* **Bounded Async Fallback Queues:** [`apps/api/src/services/notification.service.ts`](apps/api/src/services/notification.service.ts) (`POST /notifications/send`) transitions cleanly across `Closed → Open → Half-Open → Closed`. When an external email/SMS/push provider stalls or fails, open-circuit requests return `HTTP 202 Accepted` (`status: queued_fallback`) in `<1ms` without touching the dead provider, backed by a FIFO-capped fallback queue (`MAX_FALLBACK_QUEUE_SIZE = 1000`) to prevent unbounded memory leaks.
* **Bulkhead Pool & Namespace Isolation:** Separate database pools (`apiPool = 17`, `workerPool = 3` in [`apps/api/src/utils/pool.ts`](apps/api/src/utils/pool.ts)) ensure 100% worker exhaustion never starves ingress traffic (`/ready` verified at `8.04ms` under full worker saturation), while decoupled Redis namespaces (`link:redirect:` vs. `analytics:dedup:`) prevent cross-domain cache collisions.

### 3. Failure Mode Analysis & 3 AM Operational Runbooks
* **13-Mode Failure Mode & Effects Analysis (FMEA):** [`docs/failure-mode-analysis.md`](docs/failure-mode-analysis.md) audits 6 external dependencies (including DNS and runtime/clock skew), classifies transient vs. permanent faults, maps cascading failure propagation, ranks top risks by probability &times; impact, and records live simulation gaps.
* **Structured Infrastructure Fault Classification:** [`apps/api/src/middleware/error.middleware.ts`](apps/api/src/middleware/error.middleware.ts) classifies `TimeoutError`/`ETIMEDOUT` &rarr; `HTTP 504`, `ENOTFOUND`/`EAI_AGAIN` DNS failures &rarr; `HTTP 503` (`Retry-After: 5`), and storage read-only/connection failures &rarr; `HTTP 503`, logging explicit `failure_mode` telemetry without leaking stack traces.
* **Live-Tested 3 AM Runbooks:** Zero-placeholder operations manual ([`docs/service-overview.md`](docs/service-overview.md)) and 3 alert-linked linear-checklist runbooks—[`high-error-rate.md`](docs/runbooks/high-error-rate.md), [`high-latency.md`](docs/runbooks/high-latency.md), and [`service-down.md`](docs/runbooks/service-down.md)—complete with Step 0 live topology drift checks, dual healthy/unhealthy expected outputs, pre-OOM heap diagnostics, and timed escalation paths.

### 4. Zero-Downtime Deployment, Config Governance & Automated Rollback
* **Hardened Probes & Drift Detection:** [`apps/api/src/app.ts`](apps/api/src/app.ts) decouples lightweight, dependency-free `GET /live` from 2-second timeout-bounded `GET /ready` (reporting `database`, `cache`, `notification_circuit_breaker`, `version` git SHA, `uptime_seconds`, and `config_fingerprint`). [`apps/api/src/config/env.ts`](apps/api/src/config/env.ts) enforces Twelve-Factor fail-fast Zod startup validation and computes a non-secret SHA-256 `CONFIG_FINGERPRINT` to detect out-of-band ClickOps configuration drift.
* **Multi-Stage Non-Root Container & Rolling Rollout:** Root [`Dockerfile`](Dockerfile) and [`.dockerignore`](.dockerignore) build a minimal `node:20-slim` runtime executing as unprivileged `USER appuser` with `<200MB` CI size enforcement. [`fly.toml`](fly.toml) (`strategy = "rolling"`, `max_unavailable = 0`) and [`infra/docker-compose.yml`](infra/docker-compose.yml) (`mem_limit: 512m`) govern rollout health gating.
* **Automated CI/CD Deploy & Failure Rollback:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) executes `lint → build → test → Docker build (git SHA) → <200MB guardrail → ghcr.io push → rolling deploy → 30-attempt /ready poll → functional POST /notifications/send business smoke check → automated rollback on failure`.

---

## ⚖️ Key Architectural Decisions & Trade-Offs

*(Extracted from engineering decision logs in [`progress/state.json`](progress/state.json))*

1. **Database-Native Search (`db_native`) vs. Secondary Search Engine:** Relational indexing with root-level `tenantId` query predicates and bounded pagination (`page_size <= 100`) guarantees ACID read-your-own-writes consistency and airtight multi-tenant scoping without Elasticsearch dual-write drift.
2. **Cache-Aside (`cache_aside`) vs. Write-Through:** Evicting on mutation (`DEL`) prevents cache pollution from bulk link generation, eliminates out-of-order write races, and degrades cleanly to PostgreSQL if Redis goes down.
3. **Asynchronous Analytics Queue (`async_queue`) vs. Synchronous DB Logging:** Buffers click telemetry in Redis (`<1ms` ingress) and drains via dedicated idempotent workers (`P2002` deduplication, max 5 jittered retries &rarr; DLQ), shielding public redirect latency from write bursts.
4. **Integration-Heavy Testing (`integration_heavy`) vs. Mock-Heavy Unit Tests:** Runs against real storage engines with `NODE_ENV=test` guardrails and UUID tenant namespaces to catch real constraint violations, route shadowing, and cache desynchronization.
5. **Multi-Service Deployment (`multi_service`) + Rolling Auto-Rollback:** Decouples Web API and Background Worker scaling while pairing expand-and-contract migrations with rolling health-gated deploys and automated rollback.

---

## 🛡️ Security & Multi-Tenant Invariants

* **Root-Level Tenant Scoping & Anti-IDOR 404 Masking:** Every query scopes by `tenantId` at the root predicate and returns `HTTP 404 Not Found` (never `403`) on cross-tenant access attempts to block resource enumeration.
* **Strict Input Sanitization:** Zod validation blocks backslash URI smuggling, `javascript:` XSS schemes, CRLF header injection, userinfo credential extraction, and non-HTTP(S) schemes with `HTTP 400`.
* **GDPR/CCPA Salted IP Hashing:** Ingress hashes client IPs via salted SHA-256 (`IP_SALT`) so raw IP addresses are never logged or persisted.
* **Reverse-Proxy Keep-Alive & Graceful SIGTERM Draining:** `keepAliveTimeout` (`65s`) and `headersTimeout` (`66s`) exceed standard 60s cloud LB timeouts to eliminate `502` race conditions; `SIGTERM` flips `/ready` to `503` and drains in-flight requests cleanly.

---

## 📊 Verification Suite Summary

All architecture, debugging, observability, resilience, runbook, and zero-downtime deployment invariants are backed by executable test harnesses and recorded audit logs:

| Verification Harness / Audit Log | Scope & Proven Invariants | Result |
|---|---|---|
| [`progress/evidence/live-railway-verification.txt`](progress/evidence/live-railway-verification.txt) & [`scripts/verify-live-railway.ts`](scripts/verify-live-railway.ts) | **Live Railway Production (PostgreSQL + Redis):** `/live` `200`, `/ready` (`db=connected`, `cache=connected`, `6.18ms`), `/metrics`, `POST /links`, `X-Cache: MISS → HIT`, Anti-IDOR `404`, `POST /notifications/send`, immediate delete eviction | **PASS (8/8 LIVE)** |
| [`progress/evidence/module-09/testing-verification.txt`](progress/evidence/module-09/testing-verification.txt) | 7/7 Integration, Anti-IDOR 404 scoping, 5 URL smuggling rejections, P2002 exact-once deduplication, 30-day retention pruning | **PASS (7/7)** |
| [`progress/evidence/module-10/deploy-verification.txt`](progress/evidence/module-10/deploy-verification.txt) | 7/7 Cloud readiness (`/health` `2.60ms`, `/ready` `4.46ms`), `0.0.0.0` binding, graceful draining, Dockerfile & CI gates | **PASS (7/7)** |
| [`apps/api/scripts/verify-module-06-debug.ts`](apps/api/scripts/verify-module-06-debug.ts) | Cache eviction on delete, exponential backoff (1s–8s), DLQ routing after 5 failures, `/ready` in `8.04ms` during 100% worker exhaustion | **PASS** |
| [`scripts/verify-module-04-observability.ts`](scripts/verify-module-04-observability.ts) | Prometheus RED counters (`200`/`404`/`500`), histograms, gauges, `request_id` correlation, inline URI credential scrubbing, and `alerts.yml` validation | **PASS** |
| [`scripts/verify-module-05-failure-modes.ts`](scripts/verify-module-05-failure-modes.ts) & [`scripts/verify-module-05-fix.ts`](scripts/verify-module-05-fix.ts) | Live DB outage (`503` in `8.39ms`), `1ms` `AbortSignal` timeout (`3ms`), DNS `ENOTFOUND` (`503`), and read-only failover (`503` + `Retry-After`) | **PASS** |
| [`scripts/verify-module-06-resilience.ts`](scripts/verify-module-06-resilience.ts) | Slow provider timeout cutoff (`201ms` vs `3000ms` hang), `0ms` open-circuit fallback (`0` dead calls), `Closed → Open → Half-Open → Closed`, jittered retries, `0` retries on `401` | **PASS** |
| [`scripts/verify-module-07-runbook-test.ts`](scripts/verify-module-07-runbook-test.ts) | Verbatim live execution of `docs/runbooks/high-error-rate.md` against simulated 500/503 outage (3 real gaps caught & patched) | **PASS** |
| [`scripts/verify-module-08-deploy-rollback.ts`](scripts/verify-module-08-deploy-rollback.ts) | Rolling deploy gate blocks broken-DB v2 (`/live=200`, `/ready=503`), `0` dropped requests, `12ms` rollback to verified v1 (`config_fingerprint: 183ed1ef69cb`) | **PASS** |

---

## 🌐 API Specification

### System Probes & Telemetry
| Method | Route | Auth | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/live`, `/health` | None | Lightweight dependency-free process vitality probe (`HTTP 200`, version & uptime) |
| `GET` | `/ready` | None | 2s timeout-bounded DB readiness + cache, circuit breaker & `config_fingerprint` (`200`/`503`) |
| `GET` | `/metrics` | None | Prometheus scrape endpoint (RED metrics, in-flight & queue gauges, heap/CPU metrics) |

### Link Management & Notifications
| Method | Route | Auth | Description |
| :--- | :--- | :---: | :--- |
| `POST` | `/links` | `X-API-Key` | Create shortened link with tags and optional custom code |
| `GET` | `/links` | `X-API-Key` | List tenant links with bounded pagination (`page_size <= 100`) |
| `GET` | `/links/search` | `X-API-Key` | Query links by substring, tags, and date range |
| `GET` | `/links/:id` | `X-API-Key` | Retrieve link details (Anti-IDOR: returns `404` if not owner) |
| `PATCH` | `/links/:id` | `X-API-Key` | Update target URL and trigger active Redis cache invalidation |
| `DELETE` | `/links/:id` | `X-API-Key` | Delete link and immediately evict redirect & tenant cache entries |
| `GET` | `/links/:id/analytics` | `X-API-Key` | Aggregated click analytics over date window |
| `POST` | `/notifications/send` | None | Multi-channel (`email`/`sms`/`push`) delivery via `opossum` circuit breaker (`200` / `202` fallback) |

### Public Ingress
| Method | Route | Auth | Description |
| :--- | :--- | :---: | :--- |
| `GET` | `/r/:code` | None | Sub-10ms 302 redirect with Cache-Aside Redis acceleration & async click queueing |

---

## 💻 Local Quickstart

```bash
# 1. Clone & install dependencies
git clone https://github.com/vamsichowdarynalla2239-ship-it/linkscale.git
cd linkscale
npm install

# 2. Configure environment (copy contract and fill values)
cp .env.example apps/api/.env

# 3. Start PostgreSQL + Redis (or full containerized stack)
docker compose -f infra/docker-compose.yml up -d postgres redis

# 4. Generate Prisma client, build & verify
cd apps/api && npx prisma generate && npx prisma migrate dev
cd ../.. && npm run lint && npm run build && npm test

# 5. Run API and background worker
npm run dev     # Terminal 1: HTTP API
npm run worker  # Terminal 2: Click Analytics Worker
```

---

## 🏆 Curriculum Provenance & Verified Scorecard

Engineered across all **three Upsk Production Engineering tracks** (**25 / 25 modules — 10.0 / 10.0 across every module & dimension**):

| Track | Modules | Score | Core Competencies Demonstrated |
|---|---|---|---|
| **System Design Fundamentals** | 10 / 10 | **10.0 / 10.0** | Multi-tenant data modeling, Cache-Aside invalidation, async Redis queues, Anti-IDOR security, integration testing |
| **Debugging & Incident Response** | 7 / 7 | **10.0 / 10.0** | Hypothesis-driven triage, bulkhead pool isolation, retry-storm DLQ remediation, blameless SRE postmortems |
| **Production Readiness** | 8 / 8 | **10.0 / 10.0** | Multi-stage non-root Docker, CI/CD SHA pipelines, Twelve-Factor config, Prometheus RED alerting, FMEA, `opossum` circuit breakers, 3 AM runbooks, zero-downtime rollbacks |

Full verified portfolio showcase: [upsk.to/vamsichowdarynalla22](https://www.upsk.to/vamsichowdarynalla22) · Audit trail & decision logs: [`progress/state.json`](progress/state.json).

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
