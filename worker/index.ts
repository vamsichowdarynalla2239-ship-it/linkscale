import Redis from "ioredis";
import { Pool } from "pg";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const dbUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/linkops?schema=public";
const redis = new Redis(redisUrl);
const pool = new Pool({ connectionString: dbUrl });

async function processJob(linkId: string) {
  try {
    await pool.query(
      `INSERT INTO analytics (link_id, timestamp_bucket, count, last_accessed_at)
       VALUES ($1, DATE_TRUNC('hour', NOW()), 1, NOW())
       ON CONFLICT (link_id, timestamp_bucket)
       DO UPDATE SET count = analytics.count + 1, last_accessed_at = NOW()`,
      [linkId]
    );
  } catch (err: any) {
    console.error("[WORKER] Failed to process analytics job:", err.message);
  }
}

async function start() {
  console.log("worker: started");
  while (true) {
    try {
      const job = await redis.brpop("analytics:queue", 5);
      if (job) {
        const [, linkId] = job;
        await processJob(linkId);
      }
    } catch (err: any) {
      console.error("[WORKER] Queue polling error:", err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

start().catch((err) => {
  console.error("worker: fatal", err);
  process.exit(1);
});
