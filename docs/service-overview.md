# Operations Manual: LinkScale API & Notification Service

## Purpose
LinkScale is a multi-tenant URL shortening, click-analytics, and multi-channel notification delivery API (email, SMS, push) built on Node.js 20, Express, Prisma, and Redis. It guarantees sub-10ms cached redirects, isolated connection pools, and zero-loss async notification queueing during external provider outages.

---

## Architecture & Dependencies

| Dependency | Type | What Happens Without It | Fallback Mechanism (Module 06) |
|---|---|---|---|
| **PostgreSQL / SQLite (`linkops-postgres`)** | Primary datastore | `GET /ready` returns 503; link creation & cache-miss reads fail with 503 (`Retry-After: 5`). Cached hot redirects stay online. | No fallback for durable writes (Fail-Closed). Cached reads continue from Redis until TTL expiry. |
| **Redis (`linkops-redis`)** | Cache & Click Queue Broker | Elevated DB read QPS; slightly higher redirect latency. | **Fail-Open:** `cache.service.ts` falls back transparently to DB; `queue.service.ts` falls back to bounded in-memory queue. |
| **External Notification Providers (SendGrid, Twilio, Firebase)** | External HTTPS APIs | Synchronous delivery fails or stalls. | **Fail-Open (Async Queue):** `opossum` circuit breaker (1s timeout, 50% threshold, 30s reset) trips OPEN and enqueues payloads locally returning HTTP `202 Accepted` (`status: queued_fallback`). |
| **Prometheus Scraper** | Out-of-band telemetry | Loss of dashboard/alert visibility; API traffic unaffected. | External synthetic black-box probes + Watchdog alert. |

---

## Exposed Endpoints

| Method | Path | Purpose | Expected Healthy Output |
|---|---|---|---|
| `GET` | `/live` | Liveness probe (process event loop alive; zero external calls) | `200 OK` `{"ok":true,"status":"healthy","request_id":"..."}` |
| `GET` | `/health` | Alias for `/live` liveness probe | `200 OK` `{"ok":true,"status":"healthy","request_id":"..."}` |
| `GET` | `/ready` | Readiness probe (verifies primary DB `SELECT 1` connectivity) | `200 OK` `{"status":"ready","database":"connected",...}` (or `503` if DB down) |
| `GET` | `/metrics` | Prometheus scrape endpoint (RED metrics, gauges, circuit breaker state) | `200 OK` `text/plain` with `http_requests_total`, `circuit_breaker_state` |
| `POST` | `/links` | Create a shortened link (authenticated via `X-API-Key`) | `201 Created` `{"code":"...","target_url":"..."}` |
| `GET` | `/links` | List tenant links (authenticated via `X-API-Key`) | `200 OK` `[...]` |
| `DELETE` | `/links/:code` | Delete link and immediately evict Redis cache | `204 No Content` |
| `GET` | `/r/:code` | Public short-link redirect (cache-aside + async click tracking) | `302 Found` `Location: <target_url>` |
| `POST` | `/notifications/send` | Dispatch email/SMS/push notification via circuit-breaker-protected provider | `200 OK` (`sent`) or `202 Accepted` (`queued_fallback`) |

---

## Operational Configuration

Full schema contract: [`.env.example`](../.env.example) (validated fail-fast on startup in `apps/api/src/config/env.ts`).

| Variable | Operational Effect | Safe to Change Without Restart? |
|---|---|---|
| `APP_ENV` / `NODE_ENV` | Controls environment mode (`development`, `staging`, `production`) and error detail masking | **No — Restart Required** |
| `PORT` | HTTP listening port (default `3000`) | **No — Restart Required** |
| `DATABASE_URL` | Primary datastore connection string (`apiPool=17`, `workerPool=3`) | **No — Restart Required** |
| `REDIS_URL` | Redis cache and queue broker endpoint | **No — Restart Required** |
| `JWT_SECRET` | Cryptographic token signing key (min 32 chars) | **No — Restart Required** (coordinate rolling rotation) |
| `LOG_LEVEL` | Minimum structured log threshold (`debug`, `info`, `warn`, `error`) | **No — Restart Required** (env parsed on boot) |
| `CORS_ORIGIN` | Strict allowed browser origin | **No — Restart Required** |

---

## Deploy Procedure (Exact Commands)

Deployments are automated via `.github/workflows/ci.yml` on every push to `main` (lint -> build -> test -> Docker build -> `<200MB` size gate -> `ghcr.io` push tagged with git SHA).

```bash
# 1. Trigger automated build & publish from main
git checkout main
git pull origin main
git push origin main

# 2. Deploy specific immutable git SHA container on host
TARGET_SHA=$(git rev-parse HEAD)
docker pull ghcr.io/vamsichowdarynalla2239-ship-it/linkscale:$TARGET_SHA
docker stop linkscale-api || true
docker rm linkscale-api || true
docker run -d --name linkscale-api --restart unless-stopped \
  -p 3000:3000 \
  --env-file /etc/linkscale/production.env \
  ghcr.io/vamsichowdarynalla2239-ship-it/linkscale:$TARGET_SHA

# 3. Verify deployment health
curl.exe -sS http://localhost:3000/live
# Expected: {"ok":true,"status":"healthy","request_id":"req_..."}

curl.exe -sS http://localhost:3000/ready
# Expected: {"status":"ready","database":"connected","timestamp":"...","request_id":"req_..."}
```

---

## Rollback Procedure (Exact Commands — Target < 2 Minutes)

```bash
# 1. Identify the last known-good image SHA tag
docker images ghcr.io/vamsichowdarynalla2239-ship-it/linkscale --format "table {{.Tag}}\t{{.CreatedAt}}"

# 2. Swap container back to the previous verified SHA tag (example: 5cf9f89)
docker stop linkscale-api
docker rm linkscale-api
docker run -d --name linkscale-api --restart unless-stopped \
  -p 3000:3000 \
  --env-file /etc/linkscale/production.env \
  ghcr.io/vamsichowdarynalla2239-ship-it/linkscale:5cf9f89

# 3. Verify rollback immediately
curl.exe -sS -w "\nhttp_code=%{http_code}\n" http://localhost:3000/live
# Expected: {"ok":true,"status":"healthy",...} and http_code=200

curl.exe -sS -w "\nhttp_code=%{http_code}\n" http://localhost:3000/ready
# Expected: {"status":"ready","database":"connected",...} and http_code=200
```

---

## Ownership & Escalation

- **Owning Team:** Core Platform & Reliability Engineering (`#linkscale-ops`)
- **Primary On-Call:** Platform Rotation (`pagerduty: linkscale-primary`)
- **Secondary On-Call:** Backend Lead (`pagerduty: linkscale-secondary`)
- **Engineering Manager / Incident Commander:** Escalate via PagerDuty `linkscale-em` if unresolved after **15 minutes** or if P1 customer data integrity is at risk.
