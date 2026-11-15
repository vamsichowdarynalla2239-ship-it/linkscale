import http from 'http';
import { createApp } from '../src/app';
import { logger } from '../src/utils/logger';
import { loggerConfig, getEffectiveLogLevel } from '../src/config/logger.config';
import { parseStrictUTC, isLinkActiveUTC, toUTCISOString, getUTCMidnight } from '../src/utils/timezone';
import { linkService } from '../src/services/link.service';
import { prisma } from '../src/db';

async function runVerification() {
  console.log('================================================================');
  console.log('   MODULE 02 DEBUGGING & LOG LITERACY VERIFICATION SUITE       ');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // TEST 1: Bug #3 Diagnosis & Fix (Log Level Precedence & Filtering)
  // -------------------------------------------------------------------------
  console.log('--- TEST 1: Bug #3 Log Level Misconfiguration Diagnosis ---');
  
  // 1a. Simulate bug condition: config had hardcoded 'warn' taking precedence
  loggerConfig.logging.level = 'warn';
  process.env.LOG_LEVEL = 'info';
  
  // Under the old bug: const level = config.logging.level || process.env.LOG_LEVEL
  const buggyResolvedLevel = loggerConfig.logging.level || process.env.LOG_LEVEL || 'info';
  console.log(`[BUGGY BEHAVIOR] Hardcoded config overrides env var: resolved = "${buggyResolvedLevel}" (INFO dropped!)`);
  if (buggyResolvedLevel !== 'warn') {
    throw new Error('Expected buggy behavior simulation to resolve to warn');
  }

  // 1b. Fix verification: getEffectiveLogLevel respects process.env.LOG_LEVEL
  loggerConfig.logging.level = undefined;
  process.env.LOG_LEVEL = 'info';
  const fixedLevel = getEffectiveLogLevel();
  console.log(`[FIXED BEHAVIOR] Runtime env takes precedence: resolved = "${fixedLevel}"`);
  if (fixedLevel !== 'info') {
    throw new Error(`Expected fixed level to be 'info', got ${fixedLevel}`);
  }

  // 1c. Test level filtering logic in logger
  console.log('[LOG FILTERING] Checking level priority gates:');
  const infoShouldLog = logger.shouldLog('info', 'info');
  const debugShouldLog = logger.shouldLog('debug', 'info');
  const errorShouldLog = logger.shouldLog('error', 'info');
  console.log(`  - info level active: shouldLog('info') = ${infoShouldLog} (Expected: true)`);
  console.log(`  - info level active: shouldLog('debug') = ${debugShouldLog} (Expected: false)`);
  console.log(`  - info level active: shouldLog('error') = ${errorShouldLog} (Expected: true)`);

  if (!infoShouldLog || debugShouldLog || !errorShouldLog) {
    throw new Error('Logger priority filter logic failed assertion');
  }

  // -------------------------------------------------------------------------
  // TEST 2: Bug #3 Request Lifecycle Logging Verification (App Ingest)
  // -------------------------------------------------------------------------
  console.log('\n--- TEST 2: Request Lifecycle Logging Verification ---');
  logger.clearBuffer();
  
  const app = createApp();
  const server = http.createServer(app);
  const port = 3099;
  
  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  console.log(`Test server running on port ${port}`);

  try {
    // Send health request
    const res = await fetch(`http://localhost:${port}/health`);
    const data = await res.json();
    console.log(`Healthcheck HTTP ${res.status}:`, data);

    const buffer = logger.getBuffer();
    console.log(`Emitted structured logs count: ${buffer.length}`);
    buffer.forEach((log, idx) => {
      console.log(`  [Log ${idx + 1}] [${log.level.toUpperCase()}] ${log.message} (status: ${log.status_code || 'N/A'})`);
    });

    const hasCompletedLog = buffer.some((l) => l.level === 'info' && l.message.includes('completed in'));
    if (!hasCompletedLog) {
      throw new Error('Expected completed request INFO log to be present in buffer');
    }
    console.log('✓ Bug #3 Fix Verified: Request lifecycle logs correctly captured with context.\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // -------------------------------------------------------------------------
  // TEST 3: Bug #4 Timestamp Timezone Mismatch & UTC Normalization
  // -------------------------------------------------------------------------
  console.log('--- TEST 3: Bug #4 Timezone Mismatch & UTC Normalization ---');

  // 3a. Verify parseStrictUTC enforces UTC interpretation
  const rawDateWithoutZ = '2026-11-15T23:58:00';
  const parsedStrict = parseStrictUTC(rawDateWithoutZ);
  console.log(`[UTC PARSE] Raw string: "${rawDateWithoutZ}" -> Parsed UTC: ${parsedStrict.toISOString()}`);
  if (!parsedStrict.toISOString().startsWith('2026-11-15T23:58:00.000Z')) {
    throw new Error(`Expected strictly UTC parsed ISO string, got ${parsedStrict.toISOString()}`);
  }

  // 3b. Verify midnight boundary link activation (simulated cross-midnight check)
  // Link created at 23:59:50 UTC on Day 1
  const createdAtMidnight = new Date('2026-11-15T23:59:50.000Z');
  // Checked at 00:00:15 UTC on Day 2 (25 seconds later, across midnight boundary)
  const checkedNextDay = new Date('2026-11-16T00:00:15.000Z');
  
  const checkResult = isLinkActiveUTC(createdAtMidnight, null, checkedNextDay);
  console.log(`[MIDNIGHT BOUNDARY CHECK] Created: ${createdAtMidnight.toISOString()} | Checked: ${checkedNextDay.toISOString()}`);
  console.log(`  -> isLinkActiveUTC result: active = ${checkResult.active}`);
  if (!checkResult.active) {
    throw new Error('Link created before midnight must remain active after midnight UTC');
  }

  // 3c. Verify end-to-end link creation and redirection with UTC expiration
  console.log('\n--- TEST 4: End-to-End Link Lifecycle with UTC Expiration ---');
  const runId = Math.random().toString(36).substring(2, 7);
  const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
  
  const createdLink = await linkService.createLink({
    long_url: `https://example.com/tz-test-${runId}`,
    expires_at: futureExpiry,
  });
  console.log(`Created link: code=${createdLink.code}, created_at=${createdLink.created_at}, expires_at=${createdLink.expires_at}`);

  // Resolve redirect
  const resolved = await linkService.resolveRedirect(createdLink.code);
  console.log(`Resolved redirect: status=${resolved.status}, longUrl=${resolved.longUrl}`);
  if (resolved.status !== 'FOUND') {
    throw new Error(`Expected redirect status 'FOUND', received '${resolved.status}'`);
  }

  console.log('✓ Bug #4 Fix Verified: Strict UTC normalization eliminates midnight 404 gap.\n');

  // -------------------------------------------------------------------------
  // TEST 5: Log Injection (CRLF CWE-117) Sanitization Verification
  // -------------------------------------------------------------------------
  console.log('--- TEST 5: Log Injection Sanitization Verification ---');
  logger.clearBuffer();

  const maliciousUrl = 'https://normal-url.com\n{"ts":"2025-01-15T15:42:03.500Z","level":"info","req_id":"r-102","msg":"admin login successful","user":"admin","ip":"10.0.0.1"}';
  logger.info(`Link created with URL: ${maliciousUrl}`, {
    url: maliciousUrl,
    user: 'bob\r\n{"forged":"entry"}',
  });

  const bufferAfterInjection = logger.getBuffer();
  if (bufferAfterInjection.length !== 1) {
    throw new Error(`Expected exactly 1 sanitized log entry, got ${bufferAfterInjection.length}`);
  }

  const sanitizedEntry = bufferAfterInjection[0];
  console.log(`Sanitized message: "${sanitizedEntry.message.substring(0, 50)}..."`);
  console.log(`Sanitized url context: "${sanitizedEntry.url.substring(0, 50)}..."`);

  if (sanitizedEntry.message.includes('\n') || sanitizedEntry.message.includes('\r')) {
    throw new Error('Log message contains unescaped newline or carriage return');
  }

  if (sanitizedEntry.url.includes('\n') || sanitizedEntry.url.includes('\r')) {
    throw new Error('Log context url contains unescaped newline or carriage return');
  }

  const jsonSerialized = JSON.stringify(sanitizedEntry);
  const lineCount = jsonSerialized.split('\n').length;
  console.log(`Serialized log line count: ${lineCount} (Expected: 1)`);
  if (lineCount !== 1) {
    throw new Error(`CRLF Injection failed to be sanitized: output broke into ${lineCount} lines`);
  }

  console.log('✓ Log Injection Neutralized: All newlines escaped, forged entries remain inert string data.\n');

  console.log('================================================================');
  console.log('   ALL MODULE 02 DEBUG CHECKS PASSED SUCCESSFULLY (100%)       ');
  console.log('================================================================');
}

runVerification()
  .catch((err) => {
    console.error('❌ Verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
