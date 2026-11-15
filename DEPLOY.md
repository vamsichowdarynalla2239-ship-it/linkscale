# Production Deployment & Operational Runbook

## 1. Multi-Service Architecture Overview

The system is deployed as two decoupled, independently scalable services built from the same immutable multi-stage Docker image:

1. **Web API Service (`api`)**:
   - **Command**: `npm start` (`node dist/main.js`)
   - **Binding**: `0.0.0.0` dynamically honoring `$PORT`
   - **Liveness Probe**: `GET /health` (HTTP 200 when Node.js process is active)
   - **Readiness Probe**: `GET /ready` (HTTP 200 when PostgreSQL connection pool is verified; HTTP 503 if down)
   - **Timeouts**: `keepAliveTimeout=65000ms`, `headersTimeout=66000ms`
   - **Shutdown**: Graceful drain on `SIGTERM` / `SIGINT` with 10s deadline

2. **Background Worker Service (`worker`)**:
   - **Command**: `npm run worker` (`node dist/workers/run-worker.js`)
   - **Scaling Metric**: Horizontal scaling based on Redis queue depth (`queue:clicks`)
   - **Public Ingress**: Disabled (internal background worker)
   - **Shutdown**: Graceful drain on `SIGTERM` / `SIGINT`

---

## 2. Environment Variables Specification (Railway / PaaS)

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `PORT` | Auto | Platform-injected runtime port | `8080` |
| `NODE_ENV` | Yes | Node runtime environment | `production` |
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `REDIS_URL` | Yes | Redis connection string for caching & queues | `redis://default:pass@host:6379` |
| `JWT_SECRET` | Yes | 64-character entropy string for token signing | `[SECURE_RANDOM_SECRET]` |
| `IP_SALT` | Yes | Salt string for privacy-preserving SHA-256 IP hashing | `[SECURE_SALT_HEX]` |

---

## 3. Database Migration Strategy: One-Off Job (Expand-and-Contract)

To ensure zero-downtime deployments without migration lock contention across multi-replica fleets:

1. **Never Run Migrations on App Startup**:
   Running `prisma migrate` inside `main.ts` causes race conditions when multiple API replicas boot concurrently.
2. **Execute via Pre-Deploy Release Command**:
   Run as an isolated one-off command in the CI/CD pipeline or PaaS pre-deploy phase:
   ```bash
   npx prisma migrate deploy
   ```
3. **Expand-and-Contract Pattern**:
   - **Phase 1 (Expand)**: Apply additive schema changes (new columns as nullable, new tables, or non-blocking indexes).
   - **Phase 2 (Deploy Workers)**: Deploy updated background workers first.
   - **Phase 3 (Deploy Web API)**: Deploy updated API servers behind `/ready` health checks.
   - **Phase 4 (Contract)**: In a subsequent release, remove legacy code references and run a cleanup migration dropping deprecated columns.

---

## 4. Rollback Plan

If a release fails health checks or triggers SLO error budget alerts:
1. **Application Rollback**:
   Because database migrations follow the expand-and-contract rule, the previous container version (`v1`) remains 100% compatible with the expanded database schema. Roll back API and Worker container images immediately to the prior Git commit SHA.
2. **Zero Schema Rollback**:
   Do not rollback additive database migrations during an active incident. Keep the additive database changes in place; roll back container binaries only.

