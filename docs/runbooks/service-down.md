# Runbook: Service Down (Process Unreachable / OOM Crash)

**Format:** Linear Checklist (follow top-to-bottom; do not skip steps)

---

### Alert / Detection
- **Alert name:** `ServiceDown` (defined in `infra/alerts.yml`)
- **Trigger:** `up{job="linkscale"} == 0` for `1m` (severity: `critical`)
- **Symptoms:** Prometheus cannot scrape `GET /metrics` for > 1 minute. All external user traffic receives `502 Bad Gateway` / `503 Service Unavailable` or connection refused.

---

### Diagnosis (Run in Order)

**Step 1: Verify whether the API endpoint is locally reachable**
```bash
curl.exe -sS --max-time 5 -w "\nhttp_code=%{http_code}\n" http://localhost:3000/live
```
- **If the service IS down, you will see:**
  `curl: (7) Failed to connect to localhost port 3000` or `curl: (28) Operation timed out`
- **If the service IS actually running (scraper/network issue only), you will see:**
  `{"ok":true,"status":"healthy","request_id":"req_..."}` and `http_code=200`

**Step 2: Inspect container status and exit code (check for OOMKilled=true or ExitCode=1)**
```bash
docker inspect linkscale-api --format "Status={{.State.Status}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}} RestartCount={{.RestartCount}}"
```
- **If this IS an OOM crash, you will see:**
  `Status=exited ExitCode=137 OOMKilled=true` (or `Status=restarting`)
- **If this IS a boot-time Zod configuration failure, you will see:**
  `Status=exited ExitCode=1 OOMKilled=false`
- **If container IS healthy, you will see:**
  `Status=running ExitCode=0 OOMKilled=false`

**Step 3: Inspect the final 40 lines of container stdout/stderr before crash**
```bash
docker logs --tail 40 linkscale-api
```
- **If this IS a missing environment variable crash (Module 03 fail-fast), you will see:**
  `Invalid environment configuration:` followed by the exact missing variable (e.g. `- DATABASE_URL: DATABASE_URL is required`).
- **If this IS an unhandled startup crash after a new deploy, you will see:**
  A Node.js exception stack trace or `FATAL ERROR: Reached heap limit Allocation failed`.

---

### Fix (Follow in Order)

**Step 1: If Step 3 revealed missing/invalid environment configuration, restore `/etc/linkscale/production.env` from secrets vault and restart**
```bash
docker restart linkscale-api
```
- **Expected output:** `linkscale-api`

**Step 2: If Step 2 showed repeated crash-looping (`ExitCode=1` or `ExitCode=137`) immediately after a deployment, roll back to the previous commit SHA**
```bash
PREV_SHA=$(git rev-parse HEAD~1)
docker pull ghcr.io/vamsichowdarynalla2239-ship-it/linkscale:$PREV_SHA
docker stop linkscale-api
docker rm linkscale-api
docker run -d --name linkscale-api --restart unless-stopped \
  --memory="512m" \
  -p 3000:3000 \
  --env-file /etc/linkscale/production.env \
  ghcr.io/vamsichowdarynalla2239-ship-it/linkscale:$PREV_SHA
```
- **Expected output:** A 64-character container ID printed to stdout.

---

### Verification

**Step 1: Confirm `/live`, `/ready`, and `/metrics` all respond HTTP 200**
```bash
curl.exe -sS -w "\nhttp_code=%{http_code}\n" http://localhost:3000/live
curl.exe -sS -w "\nhttp_code=%{http_code}\n" http://localhost:3000/ready
curl.exe -sS -w "\nhttp_code=%{http_code}\n" http://localhost:3000/metrics | findstr "http_requests_total"
```
- **Expected output:** `http_code=200` on `/live` and `/ready`, and valid Prometheus counter lines from `/metrics`.

**Step 2: Wait 2 minutes and verify container has zero additional restarts**
```bash
docker inspect linkscale-api --format "Status={{.State.Status}} RestartCount={{.RestartCount}}"
```
- **Expected output:** `Status=running` with unchanged `RestartCount`, and `ServiceDown` alert clears to `inactive`.

---

### Escalation
If the service is NOT back to HTTP 200 on `/live` and `/ready` within **10 minutes** (P1 complete outage):
1. Post in `#linkscale-ops` with: `docker inspect` output, last 20 lines of `docker logs`, and rollback SHA attempted.
2. Immediately page **Secondary On-Call (Backend Lead)** via PagerDuty `linkscale-secondary` AND **Engineering Manager** via PagerDuty `linkscale-em`.
3. If no acknowledgement in **5 minutes**, escalate to **VP of Engineering / Incident Commander** phone tree.
Do NOT spend more than 10 minutes debugging a full outage alone at 3 AM.

---

### Addendum: Pre-OOM Memory Leak & Out-of-Band Config Drift Checks (Module 08)

**Check Heap Growth Before OOM (`HighHeapMemoryUsage` alert):**
```powershell
curl.exe -sS http://localhost:3000/metrics | Select-String '^nodejs_heap_size_(used|total)_bytes'
```
- **Healthy:** `used / total < 0.80` and flat across 15 minutes.
- **Leak detected:** `used / total > 0.85` climbing monotonically -> verify `notification_queue_depth` is bounded (<=1000), capture heap snapshot, and roll back to `PREV_SHA`.

**Check for Out-of-Band Config Drift:**
```bash
curl.exe -sS http://localhost:3000/ready
```
- Compare `checks.config_fingerprint` against the startup log fingerprint emitted by the last CI/CD deployment. Any mismatch indicates an unauthorized ClickOps change; restore configuration via GitOps (`fly.toml` + vault) and redeploy.
