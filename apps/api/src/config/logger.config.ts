export interface LoggerConfig {
  logging: {
    level?: string;
  };
}

/**
 * Logger configuration.
 * 
 * BUG #3 ROOT CAUSE ANALYSIS:
 * Previously, this configuration had a hardcoded override:
 *   logging: { level: 'warn' }
 * Combined with the short-circuit evaluation:
 *   const level = loggerConfig.logging.level || process.env.LOG_LEVEL || 'info';
 * This prevented `process.env.LOG_LEVEL=info` from ever being reached, suppressing
 * all INFO (request received, response sent) and DEBUG entries and causing 
 * error logs to appear without context.
 * 
 * FIX:
 * Remove hardcoded override and prioritize process.env.LOG_LEVEL over config defaults.
 */
export const loggerConfig: LoggerConfig = {
  logging: {
    level: undefined, // Fixed: do not hardcode 'warn'
  },
};

export const getEffectiveLogLevel = (): 'debug' | 'info' | 'warn' | 'error' => {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  const configLevel = loggerConfig.logging.level?.toLowerCase();
  const resolved = envLevel || configLevel || 'info';

  if (resolved === 'debug' || resolved === 'info' || resolved === 'warn' || resolved === 'error') {
    return resolved;
  }
  return 'info';
};
