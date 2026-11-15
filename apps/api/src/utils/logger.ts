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
 * Recursively deep-clones an object and redacts any sensitive keys.
 */
export function redactSensitiveData(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // If a string contains common header patterns like "Bearer <token>", redact the token
    if (obj.toLowerCase().startsWith('bearer ')) {
      return 'Bearer [REDACTED]';
    }
    return obj;
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
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  return obj;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

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
  private log(level: LogLevel, message: string, context: Record<string, any> = {}): void {
    const sanitizedContext = redactSensitiveData(context);
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...sanitizedContext,
    };

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
}

export const logger = new Logger();

