import { execSync } from 'child_process';
import assert from 'assert';

console.log('--- Running Module 03 Config Validation Drills ---');

// Drill 1: Missing required variable (DATABASE_URL)
try {
  console.log('Testing Drill 1: Missing DATABASE_URL...');
  execSync('node apps/api/dist/config/env.js', {
    env: { ...process.env, DATABASE_URL: '', JWT_SECRET: '12345678901234567890123456789012' },
    stdio: 'pipe',
  });
  assert.fail('Should have failed when DATABASE_URL is missing');
} catch (err: any) {
  const stderr = err.stderr ? err.stderr.toString() : '';
  const stdout = err.stdout ? err.stdout.toString() : '';
  const output = stderr + stdout;
  console.log('Drill 1 caught expected failure:');
  console.log(output);
  assert(output.includes('DATABASE_URL'), 'Error output must mention DATABASE_URL');
}

// Drill 2: Invalid enum value (APP_ENV=banana)
try {
  console.log('Testing Drill 2: Invalid APP_ENV=banana...');
  execSync('node apps/api/dist/config/env.js', {
    env: { ...process.env, DATABASE_URL: 'file:./dev.db', APP_ENV: 'banana', JWT_SECRET: '12345678901234567890123456789012' },
    stdio: 'pipe',
  });
  assert.fail('Should have failed when APP_ENV is invalid');
} catch (err: any) {
  const stderr = err.stderr ? err.stderr.toString() : '';
  const stdout = err.stdout ? err.stdout.toString() : '';
  const output = stderr + stdout;
  console.log('Drill 2 caught expected failure:');
  console.log(output);
  assert(output.includes('APP_ENV') || output.includes('Invalid enum value'), 'Error output must mention APP_ENV or enum');
}

// Drill 3: Valid configuration
console.log('Testing Drill 3: Valid configuration...');
const validOutput = execSync('node apps/api/dist/config/env.js', {
  env: {
    ...process.env,
    DATABASE_URL: 'file:./dev.db',
    APP_ENV: 'production',
    JWT_SECRET: 'super-secret-jwt-key-for-local-development-32chars',
    PORT: '4000',
    LOG_LEVEL: 'warn'
  },
  stdio: 'pipe',
}).toString();

console.log('Drill 3 valid boot output:');
console.log(validOutput);
assert(validOutput.includes('Service configuration loaded'));
assert(!validOutput.includes('super-secret-jwt-key'), 'Secrets must not be logged');
assert(validOutput.includes('"environment":"production"'));

console.log('✅ ALL MODULE 03 CONFIG VALIDATION DRILLS PASSED!');
