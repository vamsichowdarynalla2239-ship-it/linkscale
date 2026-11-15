# Postmortem: INC-2024-0315-01 (Administrative API Authentication Bypass & Unauthorized Data Deletion)

**Date**: 2024-03-15  
**Status**: Resolved / Closed  
**Severity**: SEV1  
**Incident Commander / Author**: Security & Incident Response Lead  
**Scope**: Narrow Scope (Administrative Authentication & Data Deletion Vulnerability)

---

## 1. Summary
On March 15, 2024, between 14:22 and 14:32 UTC, an authentication bypass vulnerability in the administrative API allowed an unauthenticated external client to execute privileged deletion requests. During this 10-minute active exploitation window, 47 unauthorized `DELETE /links/:id` requests were executed from IP address `203.0.113.42`, resulting in the deletion of 12 short links across 8 customer organizations before traffic was blocked. The public short-link redirection service (`GET /r/:code`) remained 100% available and operational throughout the incident; all 12 deleted links were successfully restored from PostgreSQL Point-in-Time Recovery (PITR) WAL backups by 15:07 UTC with zero permanent data loss.

---

## 2. Timeline (all times UTC)
- **14:22:00** — Attacker begins sending scripted `DELETE /links/:id` requests from IP `203.0.113.42` bearing empty `Authorization: ""` and whitespace `Authorization: "   "` headers.
- **14:32:07** — WAF automated anomaly detector triggers P1 alert: unusual administrative deletion volume detected (47 deletes in 10 minutes vs. normal baseline of 2–5 per day), all returning HTTP 200.
- **14:34:00** — On-call incident commander paged; incident response channel `#inc-2024-0315-01` opened and triage begins.
- **14:37:30** — Severity formally classified as **SEV1** due to confirmed production data destruction and suspected credential bypass.
- **14:39:15** — Stakeholder status broadcast #1 sent to VP of Product and executive channel confirming active investigation, containment underway, and that public redirect traffic and scheduled sales demos are unaffected.
- **14:41:20** — Attacker IP `203.0.113.42` blocked at API Gateway WAF perimeter, stopping further inbound deletion requests.
- **14:44:00** — Forensic code audit identifies root cause in `requireAuth` middleware: falsy check `if (!authHeader)` allowed non-null empty strings (`""`) and whitespace to pass through token validation unchecked.
- **14:48:30** — Emergency hotfix drafted and verified against local security regression suite; pull request submitted and merged.
- **14:52:10** — Hotfix deployed to production; synthetic curl verification confirms requests with empty, whitespace, and malformed authorization headers immediately return HTTP 401 Unauthorized.
- **14:55:00** — Stakeholder status broadcast #2 sent confirming perimeter block, patch deployment, and initiation of data restoration plan.
- **14:58:00** — Forensic database audit completed: exactly 12 unique short links across 8 tenant accounts identified as deleted during the 14:22–14:32 attack window.
- **15:02:00** — Database Point-in-Time Recovery (PITR) WAL replay initiated to extract pre-attack record state at 14:20:00 UTC.
- **15:07:30** — All 12 deleted link records successfully re-inserted into primary PostgreSQL database; automated synthetic probe verifies all 12 links resolve to correct destinations with HTTP 302.
- **15:09:00** — Incident Commander declares incident mitigated. Final stakeholder notification sent; proactive notifications dispatched to the 8 affected account owners.

---

## 3. Root Cause
The technical root cause was a boundary-condition parsing flaw in the Express authentication middleware (`apps/api/src/middleware/auth.middleware.ts`). 

The middleware inspected incoming headers using a loose falsy check:
```typescript
// Flawed implementation
const authHeader = req.headers['authorization'];
if (!authHeader) {
  return res.status(401).json({ error: 'Authorization required' });
}
```
When a client submitted `Authorization: ""` (empty string) or `Authorization: "   "` (whitespace string), the HTTP parser populated `req.headers['authorization']` with a defined string object. Because empty and non-empty string literals evaluate as non-null, the check passed. Subsequent token extraction logic (`authHeader.split(' ')[1]`) returned `undefined`, which was passed directly to the token validator. Downstream handlers failed to verify token presence, allowing execution to reach the controller without an authenticated principal.

---

## 4. Contributing Factors
1. **Absence of Negative Boundary Tests in CI**: The test suite only validated happy-path JWT tokens and completely omitted headers; no test cases existed for empty strings, whitespace, or missing token parameters.
2. **Lack of Rate Limiting on Destructive Operations**: Administrative endpoints permitted 47 unthrottled DELETE requests in 10 minutes from a single IP without triggering rate-limiting or captchas.
3. **No Anomaly Alerting on Deletion Velocity**: The system relied on static daily WAF thresholds rather than dynamic rate-of-change velocity alerts, allowing the attacker 10 minutes of uninterrupted execution before alerting on-call staff.
4. **Permissive In-Memory Header Defaults**: The API gateway did not sanitize or drop empty HTTP headers at the edge, forwarding malformed headers directly to downstream microservices.

---

## 5. Impact
- **Incident Duration**: 47 minutes total (14:22 UTC exploitation start to 15:09 UTC full restoration).
- **Active Attack Window**: 10 minutes (14:22 to 14:32 UTC).
- **Users / Tenants Affected**: 8 customer organizations.
- **Data Affected**: 12 short link records deleted; 0 permanent data loss (100% recovered via continuous WAL PITR).
- **Public Service Availability**: 100% uptime for public redirection traffic (`GET /r/:code`).

---

## 6. Resolution
1. **Immediate Perimeter Containment**: Added IP `203.0.113.42` to Cloudflare/WAF blocklist, immediately dropping connection attempts.
2. **Middleware Hardening**: Refactored `requireAuth` to strictly sanitize and validate credentials:
   ```typescript
   const authHeader = req.headers['authorization'];
   const trimmedAuth = typeof authHeader === 'string' ? authHeader.trim() : '';
   if (!trimmedAuth || !trimmedAuth.startsWith('Bearer ') || trimmedAuth.length <= 7) {
     return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or malformed credentials' } });
   }
   ```
3. **Database Restoration**: Leveraged continuous PostgreSQL WAL archiving to recover the exact pre-attack state at 14:20:00 UTC, extracting and restoring the 12 deleted links without downtime.

---

## 7. Remediation Items

| # | Action Item | Owner | Target Deadline | Status |
|---|-------------|-------|-----------------|--------|
| 1 | **Automated Auth Header Fuzzing**: Integrate automated boundary tests (empty, whitespace, non-ASCII, CRLF) into CI pull-request merge checks. | Security Eng | 2024-03-22 | In Progress |
| 2 | **WAF Edge Header Sanitization**: Configure edge gateway to strip empty and whitespace-only HTTP headers before forwarding requests to backends. | Platform / Infra | 2024-03-25 | Open |
| 3 | **Destructive Operation Rate Limiting**: Implement strict per-tenant and per-IP rate limits on administrative mutations (max 10 deletes / minute). | Backend Team | 2024-03-29 | Open |
| 4 | **Velocity-Based Deletion Alarms**: Deploy Prometheus alerting rule triggering immediate P1 page if administrative deletes exceed 5/min across any tenant. | Observability Team | 2024-04-05 | Open |

---

## 8. Lessons Learned

### What Went Well
- **Decoupled Architecture Resilience**: Public redirects were completely decoupled from admin operations, ensuring zero end-user redirection downtime or sales demo disruption during the incident.
- **Rapid PITR Recovery**: Continuous PostgreSQL WAL archiving enabled 100% data recovery with zero data loss within 35 minutes of detection.
- **Transparent Incident Cadence**: Pre-defined 15-minute stakeholder updates prevented executive escalations and gave engineering clear air to debug and patch.

### What Went Poorly
- **10-Minute Detection Latency**: The attacker executed 47 unauthorized deletions before automated alerting fired, indicating our deletion velocity threshold was calibrated too high.
- **Soft-Delete Omission**: The database schema executed physical `DELETE` statements rather than logical soft-deletes (`deleted_at` timestamp), necessitating PITR database recovery instead of a simple database update.

### Where We Got Lucky
- **Benign / Script-Kiddie Exploitation Pattern**: The attacker exclusively invoked `DELETE /links/:id` and made no attempts to exfiltrate tenant customer data or elevate permissions to write administrative API keys.
- **Low Production Deletion Traffic**: Because standard admin deletion volume is low, the anomaly stood out sharply in logs once alerted, simplifying forensic identification of the affected records.
