import { globalErrorHandler } from '../apps/api/src/middleware/error.middleware';
import { logger } from '../apps/api/src/utils/logger';
import assert from 'assert';

function makeMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: any = null;
  const res: any = {
    set(k: string, v: string) {
      headers[k] = v;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: any) {
      body = payload;
      return res;
    },
    getState: () => ({ statusCode, headers, body }),
  };
  return res;
}

logger.clearBuffer();

// 1. DNS ENOTFOUND
const dnsErr: any = new Error('getaddrinfo ENOTFOUND postgres-host');
dnsErr.code = 'ENOTFOUND';
const res1 = makeMockRes();
globalErrorHandler(dnsErr, { method: 'POST', originalUrl: '/links', requestId: 'fix-dns-1' } as any, res1, () => {});
assert.strictEqual(res1.getState().statusCode, 503);
assert.strictEqual(res1.getState().headers['Retry-After'], '5');
assert.strictEqual(res1.getState().body.error.code, 'DEPENDENCY_UNREACHABLE');

// 2. TimeoutError
const toErr: any = new Error('The operation was aborted due to timeout');
toErr.name = 'TimeoutError';
const res2 = makeMockRes();
globalErrorHandler(toErr, { method: 'POST', originalUrl: '/notify', requestId: 'fix-to-1' } as any, res2, () => {});
assert.strictEqual(res2.getState().statusCode, 504);
assert.strictEqual(res2.getState().body.error.code, 'UPSTREAM_TIMEOUT');

// 3. Read-only DB failover
const roErr: any = new Error('cannot execute INSERT in a read-only transaction');
const res3 = makeMockRes();
globalErrorHandler(roErr, { method: 'POST', originalUrl: '/links', requestId: 'fix-ro-1' } as any, res3, () => {});
assert.strictEqual(res3.getState().statusCode, 503);
assert.strictEqual(res3.getState().headers['Retry-After'], '5');
assert.strictEqual(res3.getState().body.error.code, 'SERVICE_UNAVAILABLE');

const logs = logger.getBuffer();
assert(logs.some((l) => l.request_id === 'fix-dns-1' && l.failure_mode === 'dns_resolution_failure'));
assert(logs.some((l) => l.request_id === 'fix-to-1' && l.failure_mode === 'dependency_timeout'));
assert(logs.some((l) => l.request_id === 'fix-ro-1' && l.failure_mode === 'database_unavailable_or_readonly'));

console.log('✅ ALL MODULE 05 FIX RE-SIMULATION ASSERTIONS PASSED!');
