import CircuitBreaker from 'opossum';
import { logger } from './logger';
import { circuitBreakerStateGauge, circuitBreakerFallbacksTotal } from './metrics';

export interface TimeoutOptions {
  timeoutMs: number;
  dependency: string;
  operation: string;
  requestId?: string;
}

/**
 * Wraps any async operation in a strict explicit timeout so slow dependencies
 * fail fast instead of holding sockets/connections indefinitely.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: TimeoutOptions
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      const err: any = new Error(
        `Timeout after ${options.timeoutMs}ms calling ${options.dependency}.${options.operation}`
      );
      err.name = 'TimeoutError';
      err.code = 'ETIMEDOUT';
      logger.warn('dependency_timeout', {
        event: 'dependency_timeout',
        dependency: options.dependency,
        operation: options.operation,
        timeout_ms: options.timeoutMs,
        request_id: options.requestId,
      });
      reject(err);
    });
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  retryableCodes?: string[];
  dependency?: string;
  requestId?: string;
}

const DEFAULT_RETRYABLE_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
];

function isTransientError(error: any, retryableCodes: string[]): boolean {
  // Never retry explicit HTTP 4xx client/auth errors (400, 401, 403, 404, 422)
  const status = error?.statusCode || error?.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return false;
  }
  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    return true;
  }
  const code = error?.code || error?.cause?.code;
  if (code && retryableCodes.includes(code)) {
    return true;
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return true;
  }
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('temporarily unavailable');
}

/**
 * Retries transient errors using exponential backoff with randomized jitter
 * to prevent synchronized thundering-herd retry waves.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const rawMaxRetries = options.maxRetries ?? 3;
  const maxRetries = Number.isFinite(rawMaxRetries) ? Math.min(Math.max(0, rawMaxRetries), 10) : 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = Math.min(options.maxDelayMs ?? 2000, 30000);
  const jitterMs = Math.max(5, options.jitterMs ?? 50);
  const retryableCodes = options.retryableCodes ?? DEFAULT_RETRYABLE_CODES;

  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Immediately fail non-transient / permanent errors without retrying
      if (!isTransientError(error, retryableCodes)) {
        throw error;
      }

      if (attempt === maxRetries) {
        break;
      }

      const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitterOffset = Math.floor(Math.random() * jitterMs * 2) - jitterMs;
      const delayMs = Math.max(1, exponentialDelay + jitterOffset);

      logger.warn('retry_attempt', {
        event: 'retry_attempt',
        dependency: options.dependency || 'unknown',
        attempt: attempt + 1,
        max_retries: maxRetries,
        delay_ms: delayMs,
        error_code: error?.code || error?.name || 'UNKNOWN',
        error_message: error?.message,
        request_id: options.requestId,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

export interface BreakerConfig {
  dependency: string;
  timeoutMs?: number;
  errorThresholdPercentage?: number;
  resetTimeoutMs?: number;
  volumeThreshold?: number;
}

/**
 * Creates a production-instrumented opossum CircuitBreaker with Prometheus
 * state gauges, fallback counters, and structured state-transition logs.
 */
export function createResilientBreaker<TArgs extends any[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  fallback: (...args: TArgs) => TResult | Promise<TResult>,
  config: BreakerConfig
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker<TArgs, TResult>(action, {
    timeout: config.timeoutMs ?? 1000,
    errorThresholdPercentage: config.errorThresholdPercentage ?? 50,
    resetTimeout: config.resetTimeoutMs ?? 30000,
    volumeThreshold: config.volumeThreshold ?? 5,
  });

  circuitBreakerStateGauge.set({ dependency: config.dependency }, 0);

  breaker.fallback((...args: any[]) => {
    circuitBreakerFallbacksTotal.inc({ dependency: config.dependency });
    logger.warn('circuit_open_fallback', {
      event: 'circuit_open_fallback',
      dependency: config.dependency,
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half_open' : 'closed',
    });
    return fallback(...(args as TArgs));
  });

  breaker.on('open', () => {
    circuitBreakerStateGauge.set({ dependency: config.dependency }, 2);
    logger.error('circuit_opened', {
      event: 'circuit_opened',
      dependency: config.dependency,
    });
  });

  breaker.on('halfOpen', () => {
    circuitBreakerStateGauge.set({ dependency: config.dependency }, 1);
    logger.info('circuit_half_open', {
      event: 'circuit_half_open',
      dependency: config.dependency,
    });
  });

  breaker.on('close', () => {
    circuitBreakerStateGauge.set({ dependency: config.dependency }, 0);
    logger.info('circuit_closed', {
      event: 'circuit_closed',
      dependency: config.dependency,
    });
  });

  return breaker;
}
