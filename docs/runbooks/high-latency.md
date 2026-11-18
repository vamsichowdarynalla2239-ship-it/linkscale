# Runbook: High Latency (Slow Responses / Grey Failure)

**Format:** Linear Checklist (follow top-to-bottom; do not skip steps)

---

### Alert / Detection
- **Alert name:** `HighLatency` (defined in `infra/alerts.yml`)
- **Trigger:** `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 2` for `3m` (severity: `warning`)
- **Symptoms:** 5% of users wait longer than 2 seconds for API responses. Risk of impending connection pool saturation or push notification SLA breach (>5s P99).

---

### Diagnosis (Run in Order)

**Step 1: Check in-flight request saturation and circuit breaker states via `/metrics`**
```bash
curl.exe -sS http://localhost:3000/metrics | findstr /R "^http_requests_in_flight ^circuit_breaker_state ^notification_queue_depth"
```
*(Linux/macOS equivalent: `curl -sS http://localhost:3000/metrics | grep -E '^(http_requests_in_flight|circuit_breaker_state|notification_queue_depth)'`)*
- **If this IS a slow external notification provider, you will see:**
  `circuit_breaker_state{dependency="notification_provider"} 2` (OPEN) and rising `notification_queue_depth`
- **If this is NOT an external provider slowdown (healthy provider), you will see:**
  `circuit_breaker_state{dependency="notification_provider"} 0` and `http_requests_in_flight` <= 10.

**Step 2: Check for `dependency_timeout` and `retry_attempt` storms in structured logs**
```bash
docker logs --since 10m linkscale-api 2>&1 | findstr "dependency_timeout retry_attempt"
```
*(Linux/macOS equivalent: `docker logs --since 10m linkscale-api 2>&1 | grep -E 'dependency_timeout|retry_attempt' | tail -n 25`)*
- **If this IS a downstream grey failure, you will see:**
  Repeated `"event":"dependency_timeout"` or `"event":"retry_attempt"` entries naming the slow dependency (`notification_provider` or `database`).
- **If this is NOT a downstream timeout, you will see:**
  No timeout warnings (proceed to Step 3 to inspect Redis cache fallback and DB query latency).

**Step 3: Check Redis cache health (cache-down causes all reads to hit primary DB)**
```bash
docker exec linkops-redis redis-cli ping
```
- **If Redis IS down/degraded, you will see:**
  Connection error (`Could not connect to Redis at 127.0.0.1:6379: Connection refused`) or command hang > 1s.
- **If Redis IS healthy, you will see:**
  `PONG` returned in < 10ms.

---

### Fix (Follow in Order)

**Step 1: If Step 3 showed Redis is unreachable, restart the Redis container to restore read caching**
```bash
docker restart linkops-redis
```
- **Expected output:** `linkops-redis`
- Confirm recovery:
```bash
docker exec linkops-redis redis-cli ping
```
- **Expected output:** `PONG`

**Step 2: If Step 1 showed `circuit_breaker_state 2` (notification provider slow/degraded), verify graceful degradation is protecting API latency**
```bash
curl.exe -sS -w "\nhttp_code=%{http_code} time_total=%{time_total}s\n" -X POST http://localhost:3000/notifications/send -H "Content-Type: application/json" -d "{\"channel\":\"email\",\"recipient\":\"ops-probe@linkscale.internal\",\"message\":\"latency probe\"}"
```
- **Expected output during provider degradation:**
  `http_code=202`, `time_total` < `0.100s`, body contains `"status":"queued_fallback","degraded":true`.
- If `time_total` > `2.0s` (breaker failed to open or DB pool saturated), restart the API container cleanly:
```bash
docker restart linkscale-api
```
- **Expected output:** `linkscale-api`

---

### Verification

**Step 1: Measure live probe response time**
```bash
curl.exe -sS -w "\nhttp_code=%{http_code} time_total=%{time_total}s\n" http://localhost:3000/ready
```
- **Expected output:** `http_code=200` and `time_total` < `0.200s`.

**Step 2: Wait 2 minutes and verify in-flight concurrency and histogram latency stabilized**
```bash
curl.exe -sS http://localhost:3000/metrics | findstr /R "^http_requests_in_flight ^circuit_breaker_state"
```
- **Expected output:** `http_requests_in_flight` < 10 and Prometheus `HighLatency` alert clears to `inactive`.

---

### Escalation
If p95 latency remains > 2s after **15 minutes** (or escalates to > 5s):
1. Post in `#linkscale-ops` with: `http_requests_in_flight` count, `circuit_breaker_state` value, Redis `ping` result, and slowest route from logs.
2. Page **Secondary On-Call (Backend Lead)** via PagerDuty `linkscale-secondary`.
3. If no response in **10 minutes**, page **Engineering Manager** via PagerDuty `linkscale-em`.
Do NOT spend more than 15 minutes debugging alone at 3 AM.
