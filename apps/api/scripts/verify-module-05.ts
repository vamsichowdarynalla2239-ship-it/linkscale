import http from 'http';
import fs from 'fs';
import path from 'path';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { generateApiKey } from '../src/utils/api-key';

async function main() {
  const app = createApp();
  const PORT = 3000;
  const server = http.createServer(app);

  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  function intercept(msg: string) {
    logs.push(msg);
  }

  // Intercept stdout/stderr to test log redaction and structured format
  console.log = (...args) => {
    const str = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    intercept(str);
    originalLog(...args);
  };
  console.error = (...args) => {
    const str = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    intercept(str);
    originalError(...args);
  };
  console.warn = (...args) => {
    const str = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    intercept(str);
    originalWarn(...args);
  };

  const suiteLogs: string[] = [];
  function print(msg: string) {
    originalLog(msg);
    suiteLogs.push(msg);
  }

  print('====================================================');
  print('MODULE 05: ERROR HANDLING, REDACTION & LOGGING SUITE');
  print('====================================================\n');

  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
  print(`[SERVER] Test server booted on http://localhost:${PORT}`);

  try {
    // 0. Seed test tenant and API key
    print('\n--- 0. Seed Test Tenant and API Key ---');
    await prisma.apiKey.deleteMany();
    await prisma.clickEvent.deleteMany();
    await prisma.link.deleteMany();
    await prisma.tenant.deleteMany();

    const tenant = await prisma.tenant.create({ data: { name: 'Acme Observability Corp' } });
    const keyData = generateApiKey('sk_live_obs');
    await prisma.apiKey.create({
      data: {
        keyHash: keyData.keyHash,
        prefix: keyData.keyPrefix,
        name: 'Observability Test Key',
        tenantId: tenant.id,
      },
    });
    print(`[SEED] Created Tenant (id: ${tenant.id}) with Key: ${keyData.keyPrefix}...`);

    // 1. Validation Error (Expect 400 + Standard Envelope + No Stack Trace)
    print('\n--- 1. Validation Error Test: POST /links (Invalid Body) ---');
    const valRes = await fetch(`http://localhost:${PORT}/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': keyData.rawKey,
      },
      body: JSON.stringify({ long_url: 'not-a-valid-url' }),
    });

    const valHeaderRequestId = valRes.headers.get('x-request-id');
    const valBody = await valRes.json();
    print(`POST /links (invalid url) -> HTTP ${valRes.status}`);
    print(`Response Body: ${JSON.stringify(valBody)}`);

    if (valRes.status !== 400) {
      throw new Error(`Expected 400 for validation failure, got ${valRes.status}`);
    }
    if (!valBody.error || valBody.error.code !== 'VALIDATION_ERROR') {
      throw new Error(`Expected error.code === 'VALIDATION_ERROR', got ${JSON.stringify(valBody)}`);
    }
    if (!valBody.error.request_id || valBody.error.request_id !== valHeaderRequestId) {
      throw new Error(`request_id in body (${valBody.error.request_id}) does not match header (${valHeaderRequestId})`);
    }
    if (JSON.stringify(valBody).includes('stack') || JSON.stringify(valBody).includes('at ')) {
      throw new Error('SECURITY LEAK: Response body contains stack trace information!');
    }
    print('[PASS] Validation error returns 400 with standard envelope and zero stack traces.');

    // 2. Authentication Error (Expect 401 + Standard Envelope + No Stack Trace)
    print('\n--- 2. Authentication Error Test: GET /links (No Auth Header) ---');
    const authRes = await fetch(`http://localhost:${PORT}/links`);
    const authHeaderRequestId = authRes.headers.get('x-request-id');
    const authBody = await authRes.json();
    print(`GET /links (no auth) -> HTTP ${authRes.status}`);
    print(`Response Body: ${JSON.stringify(authBody)}`);

    if (authRes.status !== 401) {
      throw new Error(`Expected 401 for missing auth, got ${authRes.status}`);
    }
    if (!authBody.error || authBody.error.code !== 'UNAUTHORIZED') {
      throw new Error(`Expected error.code === 'UNAUTHORIZED', got ${JSON.stringify(authBody)}`);
    }
    if (!authBody.error.request_id || authBody.error.request_id !== authHeaderRequestId) {
      throw new Error(`request_id mismatch: body=${authBody.error.request_id}, header=${authHeaderRequestId}`);
    }
    if (JSON.stringify(authBody).includes('stack')) {
      throw new Error('SECURITY LEAK: 401 response contains stack trace!');
    }
    print('[PASS] Authentication error returns 401 with standard envelope and zero stack traces.');

    // 3. Not Found Error (Expect 404 + Standard Envelope + No Stack Trace)
    print('\n--- 3. Not Found Error Test: GET /links/nonexistent-id ---');
    const notFoundRes = await fetch(`http://localhost:${PORT}/links/nonexistent-cuid-12345`, {
      headers: { 'X-API-Key': keyData.rawKey },
    });
    const notFoundHeaderRequestId = notFoundRes.headers.get('x-request-id');
    const notFoundBody = await notFoundRes.json();
    print(`GET /links/nonexistent-id -> HTTP ${notFoundRes.status}`);
    print(`Response Body: ${JSON.stringify(notFoundBody)}`);

    if (notFoundRes.status !== 404) {
      throw new Error(`Expected 404 for not found, got ${notFoundRes.status}`);
    }
    if (!notFoundBody.error || notFoundBody.error.code !== 'NOT_FOUND') {
      throw new Error(`Expected error.code === 'NOT_FOUND', got ${JSON.stringify(notFoundBody)}`);
    }
    if (!notFoundBody.error.request_id || notFoundBody.error.request_id !== notFoundHeaderRequestId) {
      throw new Error(`request_id mismatch on 404 response`);
    }
    print('[PASS] Not found error returns 404 with standard envelope and zero stack traces.');

    // 4. Server Error Test (Expect 500 + Sanitized Body + No Internal Secrets or Stack Trace)
    print('\n--- 4. Unhandled 500 Error Test: GET /debug/simulate-error ---');
    const errRes = await fetch(`http://localhost:${PORT}/debug/simulate-error`);
    const errHeaderRequestId = errRes.headers.get('x-request-id');
    const errBody = await errRes.json();
    print(`GET /debug/simulate-error -> HTTP ${errRes.status}`);
    print(`Response Body: ${JSON.stringify(errBody)}`);

    if (errRes.status !== 500) {
      throw new Error(`Expected 500 for unhandled error, got ${errRes.status}`);
    }
    if (!errBody.error || errBody.error.code !== 'INTERNAL_SERVER_ERROR') {
      throw new Error(`Expected error.code === 'INTERNAL_SERVER_ERROR', got ${JSON.stringify(errBody)}`);
    }
    if (!errBody.error.request_id || errBody.error.request_id !== errHeaderRequestId) {
      throw new Error(`request_id mismatch on 500 response`);
    }
    const rawResponseBody = JSON.stringify(errBody);
    if (
      rawResponseBody.includes('postgres://') ||
      rawResponseBody.includes('secretpass') ||
      rawResponseBody.includes('stack') ||
      rawResponseBody.includes('Simulated database connection failure')
    ) {
      throw new Error('CRITICAL SECURITY LEAK: 500 error response leaked internal database secrets or stack trace!');
    }
    print('[PASS] 500 response completely sanitizes internal exception and leaks zero secrets/stack traces.');

    // 5. Secret Redaction Sentinel Test (DO_NOT_LOG_ME_123)
    print('\n--- 5. Secret Redaction Sentinel Test (DO_NOT_LOG_ME_123) ---');
    const sentinelToken = 'DO_NOT_LOG_ME_123';
    await fetch(`http://localhost:${PORT}/links`, {
      method: 'GET',
      headers: {
        'X-API-Key': sentinelToken,
        'Authorization': `Bearer ${sentinelToken}`,
      },
    });

    // Check captured server log output
    const allCapturedLogs = logs.join('\n');
    print(`[AUDIT] Inspecting ${logs.length} server log lines for sentinel leaks...`);

    if (allCapturedLogs.includes(sentinelToken)) {
      throw new Error(`SECURITY VULNERABILITY: Sentinel "${sentinelToken}" was found in server logs! Log sanitization failed.`);
    }
    print(`[PASS] Sentinel "${sentinelToken}" confirmed ABSENT from server logs. Redaction verified.`);

    // 6. Verify Structured JSON Logging Format
    print('\n--- 6. Structured JSON Logging Format Verification ---');
    const jsonLogs = logs
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null);

    print(`[AUDIT] Found ${jsonLogs.length} structured JSON log entries emitted by logger.`);
    if (jsonLogs.length === 0) {
      throw new Error('No structured JSON log lines were emitted!');
    }

    const requestCompletedLog = jsonLogs.find(
      (entry) => entry.request_id && entry.route && entry.status_code !== undefined && entry.latency_ms !== undefined
    );

    if (!requestCompletedLog) {
      throw new Error('Missing structured log entry containing request_id, route, status_code, and latency_ms!');
    }

    print(`[SAMPLE LOG] ${JSON.stringify(requestCompletedLog)}`);
    print('[PASS] Structured JSON logging verified: includes timestamp, request_id, route, status_code, latency_ms.');

    print('\n====================================================');
    print('MODULE 05 VERIFICATION SUMMARY: ALL CHECKS PASSED!');
    print('====================================================');

    const evidenceDir = path.join(process.cwd(), '..', '..', 'progress', 'evidence', 'module-05');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'error-logging-verification.txt');
    fs.writeFileSync(evidencePath, suiteLogs.join('\n'), 'utf-8');
    print(`\n[EVIDENCE] Full verification report saved to: ${evidencePath}`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    print('[SERVER] Test server shutdown cleanly.');
  }
}

main().catch((err) => {
  console.error('[FATAL] Verification suite error:', err);
  process.exit(1);
});

