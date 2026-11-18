# Runbook: High Error Rate (5xx Spike)

**Format:** Linear Checklist (follow top-to-bottom; do not skip steps)
**Last Verified:** 2026-11-18 (via `scripts/verify-module-07-runbook-test.ts`)

---

### Alert / Detection
- **Alert name:** `HighErrorRate` (defined in `infra/alerts.yml`)
- **Trigger:** `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05` for `2m` (severity: `critical`)
- **Symptoms:** More than 5% of API requests are returning HTTP `500`, `503`, or `504`. Users see failed link creations or degraded notification deliveries.

---

### Diagnosis (Run in Order)

**Step 0: Confirm active container names, mapped ports, and sidecars (drift check)**
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```
- **Expected output:** Active rows for `linkscale-api` (`0.0.0.0:3000->3000/tcp`), `linkops-postgres` (`5432/tcp`), and `linkops-redis` (`6379/tcp`). If any container name or host port differs, use the live name/port shown here and open a post-incident PR to update this runbook.

**Step 1: Check process liveness and database readiness**
```bash
curl.exe -sS -w "\nhttp_code=%{http_code}\n" http://localhost:3000/ready
```
- **If this IS a database connectivity failure, you will see:**
  `{"status":"unready","error":"Database dependency unavailable","request_id":"req_..."}` and `http_code=503`
- **If the database IS healthy, you will see:**
  `{"status":"ready","database":"connected","timestamp":"...","request_id":"req_..."}` and `http_code=200`

**Step 2: Identify which exact routes and status codes are returning 5xx via Prometheus metrics**
```powershell
curl.exe -sS http://localhost:3000/metrics | Select-String 'http_requests_total.*status="5'
```
*(Linux/macOS equivalent: `curl -sS http://localhost:3000/metrics | grep -E 'http_requests_total.*status="5'`)*
- **If this IS the problem, you will see:**
  Lines with non-zero counts, e.g. `http_requests_total{method="POST",path="/links",status="503"} 42` or `status="500"`
- **If this is NOT the problem (error spike already subsided), you will see:**
  Empty output or unchanged counter values across two consecutive scrapes 15s apart.

**Step 3: Inspect recent structured error logs for exact `failure_mode` and `request_id`**
```bash
docker logs --since 10m linkscale-api 2>&1 | findstr "\"level\":\"error\""
```
*(Linux/macOS equivalent: `docker logs --since 10m linkscale-api 2>&1 | grep '"level":"error"' | tail -n 20`)*
- **If this IS a downstream/DB infrastructure fault, you will see:**
  `"failure_mode":"database_unavailable_or_readonly"` or `"failure_mode":"dns_resolution_failure"` or `"failure_mode":"dependency_timeout"`
- **If this IS a recent bad code deployment, you will see:**
  `"message":"Unhandled exception on ..."` with a stack trace pointing to application code after the latest deploy timestamp.

---

### Fix (Follow in Order)

**Step 1: If Step 1 showed HTTP 503 (`Database dependency unavailable`), restart the database container**
```bash
docker restart linkops-postgres
```
- **Expected output:** `linkops-postgres`
- Wait 10 seconds and re-verify readiness (`pg_isready`):
```bash
docker exec linkops-postgres pg_isready -U postgres -d linkops
```
- **Expected output:** `/var/run/postgresql:5432 - accepting connections`
- If this does NOT succeed, go immediately to **Escalation**.

**Step 2: If Step 3 showed an application code regression following a recent deploy, fetch the prior commit SHA and roll back**
```bash
PREV_SHA=$(git rev-parse HEAD~1)
docker pull ghcr.io/vamsichowdarynalla2239-ship-it/linkscale:$PREV_SHA
docker stop linkscale-api
docker rm linkscale-api
docker run -d --name linkscale-api --restart unless-stopped \
  -p 3000:3000 \
  --env-file /etc/linkscale/production.env \
  ghcr.io/vamsichowdarynalla2239-ship-it/linkscale:$PREV_SHA
```
- **Expected output:** A 64-character container ID printed to stdout.

---

### Verification

**Step 1: Confirm `/live` and `/ready` return HTTP 200**
```bash
curl.exe -sS -w "\nhttp_code=%{http_code}\n" http://localhost:3000/live
curl.exe -sS -w "\nhttp_code=%{http_code}\n" http://localhost:3000/ready
```
- **Expected output:** Both return `http_code=200` with `"status":"healthy"` and `"database":"connected"`.

**Step 2: Wait 2 minutes and confirm 5xx counter is no longer increasing**
```powershell
curl.exe -sS http://localhost:3000/metrics | Select-String 'http_requests_total.*status="5'
```
- **Expected output:** 5xx counters remain completely flat compared to the reading taken 2 minutes earlier, and Prometheus alert `HighErrorRate` clears to `inactive`.

---

### Escalation
If this runbook does not restore 5xx rate below 1% within **15 minutes**:
1. Post in `#linkscale-ops` with: failing route from Step 2, exact `failure_mode`/`request_id` from Step 3, and UTC timestamps of actions taken.
2. Page **Secondary On-Call (Backend Lead)** via PagerDuty service `linkscale-secondary`.
3. If no acknowledgement in **10 minutes**, page **Engineering Manager** via PagerDuty `linkscale-em`.
Do NOT spend more than 15 minutes debugging alone at 3 AM.
