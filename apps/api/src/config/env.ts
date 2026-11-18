import * as dotenv from 'dotenv';
import crypto from 'crypto';
import { z } from 'zod';

// Load .env file in development / local runtimes
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production', 'test']).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  parsed.error.issues.forEach((issue) => {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

const resolvedEnv = parsed.data.APP_ENV || parsed.data.NODE_ENV;

// Non-secret deterministic fingerprint to detect out-of-band configuration drift
const configFingerprint = crypto
  .createHash('sha256')
  .update(
    JSON.stringify({
      environment: resolvedEnv,
      port: parsed.data.PORT,
      log_level: parsed.data.LOG_LEVEL,
      cors_origin: parsed.data.CORS_ORIGIN,
    })
  )
  .digest('hex')
  .slice(0, 12);

export const env = {
  ...parsed.data,
  NODE_ENV: resolvedEnv,
  APP_ENV: resolvedEnv,
  CONFIG_FINGERPRINT: configFingerprint,
};

export const config = env;

// Safe startup announcement without leaking sensitive secrets
console.log(
  JSON.stringify({
    message: 'Service configuration loaded',
    environment: env.NODE_ENV,
    port: env.PORT,
    log_level: env.LOG_LEVEL,
    cors_origin: env.CORS_ORIGIN,
    config_fingerprint: env.CONFIG_FINGERPRINT,
  })
);
