import { getEffectiveLogLevel } from '../config/logger.config';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'private_key',
]);

/**
 * Neutralizes CRLF Log Injection (CWE-117) by escaping CR and LF characters.
 */
export function sanitizeLogString(val: string): string {
  if (typeof val !== 'string') return val;
  return val
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[REDACTED]@')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Recursively deep-clones an object, redacts sensitive keys, and sanitizes CRLF log injection.
 */
export function redactSensitiveData(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    if (obj.toLowerCase().startsWith('bearer ')) {
      return 'Bearer [REDACTED]';
    }
    return sanitizeLogString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item));
  }

  if (typeof obj === 'object') {
    const redacted: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lowerKey)) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = redactSensitiveData(value);
      } else if (typeof value === 'string' && lowerKey.includes('key')) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'string') {
        redacted[key] = sanitizeLogString(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  return obj;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  request_id?: string;
  route?: string;
  method?: string;
  status_code?: number;
  latency_ms?: number;
  [key: string]: any;
}

class Logger {
  private inMemoryBuffer: LogEntry[] = [];
  private maxBufferSize = 500;

  public shouldLog(level: LogLevel, activeLevel: LogLevel = getEffectiveLogLevel()): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[activeLevel];
  }

  private log(level: LogLevel, message: string, context: Record<string, any> = {}): void {
    const activeLevel = getEffectiveLogLevel();
    if (!this.shouldLog(level, activeLevel)) {
      return;
    }

    const sanitizedContext = redactSensitiveData(context);
    const entry: LogEntry = {
      timestamp: new Date().toISOString(), // Strictly UTC ISO-8601
      level,
      message: sanitizeLogString(message), // Neutralize CRLF in message
      service_name: 'linkscale',
      ...sanitizedContext,
    };

    // Store in ring buffer for inspection & testing
    this.inMemoryBuffer.push(entry);
    if (this.inMemoryBuffer.length > this.maxBufferSize) {
      this.inMemoryBuffer.shift();
    }

    const jsonString = JSON.stringify(entry);

    if (level === 'error') {
      console.error(jsonString);
    } else if (level === 'warn') {
      console.warn(jsonString);
    } else {
      console.log(jsonString);
    }
  }

  info(message: string, context?: Record<string, any>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, any>): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, any>): void {
    this.log('error', message, context);
  }

  debug(message: string, context?: Record<string, any>): void {
    this.log('debug', message, context);
  }

  getBuffer(): LogEntry[] {
    return [...this.inMemoryBuffer];
  }

  clearBuffer(): void {
    this.inMemoryBuffer = [];
  }
}

export const logger = new Logger();
