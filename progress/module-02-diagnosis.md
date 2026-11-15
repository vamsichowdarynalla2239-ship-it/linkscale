# Module 02 Diagnosis: Reading Logs Like a Story

## System Overview
- **Service**: LinkOps URL Shortener API
- **Module**: 02 (Reading Logs Like a Story)
- **Bugs Diagnosed**: Bug #3 (Log Level Misconfiguration) & Bug #4 (Timestamp Timezone Mismatch)

---

## Bug #3: Log Level Misconfiguration

### 1. Observable Symptom
In production logs, error responses (HTTP 404s, 500s) appear out of thin air without any preceding "request received" lines or following "response sent" lines. The service appears to be generating failures without record of incoming requests.

### 2. Hypotheses Formulated
- **Hypothesis A (Log Level Filtering)**: The logger is configured to filter out log messages below `WARN` level, causing `INFO` (request received, response sent) and `DEBUG` (headers, trace data) lines to be discarded.
- **Hypothesis B (Middleware Ordering)**: The logging middleware is placed after the error handler or routes, failing to execute for standard requests.

### 3. Investigation & Root Cause
Investigating `apps/api/src/config/logger.config.ts` and `apps/api/src/utils/logger.ts` revealed that while `.env` specified `LOG_LEVEL=info`, the config file contained a hardcoded override:
```typescript
const activeLevel = config.logging.level || process.env.LOG_LEVEL || 'info';
```
Because `config.logging.level` was hardcoded to `'warn'`, the logical OR (`||`) short-circuited. The environment variable `process.env.LOG_LEVEL` was never evaluated. Consequently, only `warn` and `error` messages reached standard out/error.

### 4. Resolution
1. Removed the hardcoded override in `apps/api/src/config/logger.config.ts`.
2. Restructured precedence so runtime environment variables override file defaults:
```typescript
export const getEffectiveLogLevel = (): 'debug' | 'info' | 'warn' | 'error' => {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  const configLevel = loggerConfig.logging.level?.toLowerCase();
  const resolved = envLevel || configLevel || 'info';
  return resolved as any;
};
```
3. Added strict priority filtering in `apps/api/src/utils/logger.ts`:
```typescript
export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
```

### 5. Verification
- Under `LOG_LEVEL=warn`: INFO request/response logs are suppressed, matching the symptom.
- Under `LOG_LEVEL=info`: Every incoming request logs `request received`, processing steps, and `response sent` with status code and latency.

---

## Bug #4: Timestamp Timezone Mismatch

### 1. Observable Symptom
User reports: *"Links I create around midnight sometimes return 404 for a few hours, then magically start working. It does not happen every time. It only seems to happen late at night."*

### 2. Hypotheses Formulated
- **Hypothesis A (Timezone Offset Gap)**: Application logs timestamps in UTC (`Z`), but timestamp parsing or database queries evaluate against server-local time. Around midnight UTC, a multi-hour offset creates an invisibility gap where links appear to be in the future or outside the current day boundary.
- **Hypothesis B (Database Cache TTL Bug)**: Redis TTL expires immediately at midnight due to a negative timestamp calculation.

### 3. Investigation & Root Cause
- Comparing log output vs stored timestamps: The log records `2025-01-15T23:58:00.000Z` (UTC). However, date parsing without explicit timezone tokens (`new Date("2025-01-15 23:58:00")`) or queries using server-local `setHours(0,0,0,0)` evaluate boundaries against local midnight.
- In a system running in UTC-5 (US Eastern), when a link is created at 11:58 PM UTC, local time is 6:58 PM.
- Queries or validations filtering links created "today" or comparing against `NOW()` with mismatched timezones evaluate UTC midnight and local midnight as two distinct points in time separated by 5 hours.
- During this window, recently created links fall into the gap and fail active queries, returning HTTP 404 until the local server clock crosses midnight.

### 4. Resolution
1. Created `apps/api/src/utils/timezone.ts` providing strict UTC normalization:
   - `parseStrictUTC`: Enforces ISO-8601 UTC strings by appending `Z` if no timezone offset is supplied.
   - `isLinkActiveUTC`: Validates link creation and expiration using UTC epoch milliseconds, eliminating local timezone drift.
2. Updated `LinkService.createLink` to parse expiration dates via `parseStrictUTC`.
3. Updated `LinkService.resolveRedirect` to validate link activation status via `isLinkActiveUTC`.

### 5. Verification
Automated test in `apps/api/scripts/verify-module-02-debug.ts`:
- Tested link creation at `23:59:50.000Z` (10 seconds before UTC midnight).
- Verified `isLinkActiveUTC` and `resolveRedirect` immediately return HTTP 302 with correct destination, with 0 dropped lookups across midnight boundaries.
- Tested link creation with local date string and verified strict UTC normalization.

---

## Log Injection / CRLF Neutralization (CWE-117)

### 1. Observable Symptom
In log output, a fake `"admin login successful"` entry (request `r-102`, user `admin`) appeared out of thin air in the middle of request `r-101`'s lifecycle.

### 2. Forensic Analysis
- Examining the raw string revealed the admin login line was physically embedded inside the user-supplied `url` payload of request `r-101` (Bob's POST request).
- The payload contained an unescaped newline `\n` followed by crafted JSON text.
- When printed to console without escaping, the newline broke the structured record, creating a second, forged log line that spoofed authentication events.
- Causality violation: The forged line claimed timestamp `15:42:03.500Z`, but was printed inside a request lifecycle executing between `.400Z` and `.420Z`.

### 3. Resolution
1. Implemented `sanitizeLogString(val)` in `apps/api/src/utils/logger.ts`, escaping `\r` and `\n` to `\\r` and `\\n`.
2. Sanitized `entry.message` and all context string values recursively in `redactSensitiveData`.
3. Verified via Test 5 of `verify-module-02-debug.ts` that injected newlines remain single-line inert strings within `entry.url` rather than splitting into new lines.

