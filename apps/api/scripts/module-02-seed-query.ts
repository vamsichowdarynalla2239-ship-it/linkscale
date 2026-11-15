import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Connecting to database...');
  await prisma.$connect();

  // Clean previous test data if any
  await prisma.clickEvent.deleteMany();
  await prisma.link.deleteMany();
  await prisma.tenant.deleteMany();

  // Create test tenant
  const tenant = await prisma.tenant.create({
    data: {
      name: 'Acme Corp',
    },
  });

  const testCode = 'acme-launch';
  const testLongUrl = 'https://acme.example.com/products/launch-2026';

  // 1. Insert Link
  const createdLink = await prisma.link.create({
    data: {
      code: testCode,
      longUrl: testLongUrl,
      tenantId: tenant.id,
    },
  });

  console.log(`[SEED] Inserted code: ${createdLink.code}`);
  console.log(`[SEED] Long URL: ${createdLink.longUrl}`);

  // 2. Query Link by unique code (simulates high-speed redirect lookup)
  const foundLink = await prisma.link.findUnique({
    where: {
      code: testCode,
    },
  });

  if (!foundLink) {
    throw new Error(`Failed to find link with code: ${testCode}`);
  }

  console.log(`[QUERY] Selected code: ${foundLink.code}`);
  console.log(`[QUERY] Matched long_url: ${foundLink.longUrl}`);
  console.log(`[VERIFY] Query-by-code succeeded: code="${foundLink.code}", matched_long_url="${foundLink.longUrl}"`);

  // 3. Create a test click event to verify foreign key and cascade
  const click = await prisma.clickEvent.create({
    data: {
      linkId: foundLink.id,
      tenantId: tenant.id,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      referrer: 'https://news.ycombinator.com',
      ipHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  });

  console.log(`[ANALYTICS] Inserted ClickEvent id=${click.id} for linkId=${click.linkId}`);
}

main()
  .catch((e) => {
    console.error('Seed/Query failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
