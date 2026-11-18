import { createApp } from '../apps/api/src/app';
import http from 'http';
import fs from 'fs';

async function testEndpoints() {
  const app = createApp();
  const server = http.createServer(app);
  
  await new Promise<void>((resolve) => {
    server.listen(3000, () => resolve());
  });

  console.log('Test server listening on port 3000');

  // Test /live
  const liveRes = await fetch('http://localhost:3000/live');
  const liveData = await liveRes.json();
  console.log('/live status:', liveRes.status, liveData);

  // Test /ready (or /health)
  const healthRes = await fetch('http://localhost:3000/health');
  const healthData = await healthRes.json();
  console.log('/health status:', healthRes.status, healthData);

  server.close();

  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  const hasNonRoot = dockerfile.includes('USER appuser');
  const hasHealthcheck = dockerfile.includes('HEALTHCHECK') && dockerfile.includes('/live');
  const hasMultiStage = dockerfile.includes('AS builder') && dockerfile.includes('AS runner');
  const hasIgnore = fs.existsSync('.dockerignore');

  console.log('Dockerfile checks:', {
    hasNonRoot,
    hasHealthcheck,
    hasMultiStage,
    hasIgnore
  });

  if (!hasNonRoot || !hasHealthcheck || !hasMultiStage || !hasIgnore) {
    throw new Error('Dockerfile verification failed');
  }

  console.log('All container readiness checks PASSED!');
}

testEndpoints().catch((err) => {
  console.error(err);
  process.exit(1);
});
