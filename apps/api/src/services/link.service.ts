import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { generateShortCode } from '../utils/code-generator';
import { CreateLinkInput, ListLinksQuery, SearchLinksQuery, UpdateLinkInput } from '../schemas/link.schema';
import { env } from '../config/env';
import { cacheService } from './cache.service';
import { queueService } from './queue.service';
import { analyticsService, AnalyticsQueryOptions } from './analytics.service';
import { logger } from '../utils/logger';
import { parseStrictUTC, isLinkActiveUTC } from '../utils/timezone';

export class LinkService {
  /**
   * Helper to ensure a tenant exists when auth middleware is not yet in place (Module 04).
   */
  async getOrCreateDefaultTenant(): Promise<string> {
    const existing = await prisma.tenant.findFirst();
    if (existing) {
      return existing.id;
    }
    const created = await prisma.tenant.create({
      data: {
        name: 'Default Organization',
      },
    });
    return created.id;
  }

  /**
   * Creates a new short link with an engine-level collision retry loop.
   */
  async createLink(input: CreateLinkInput, tenantId?: string, baseUrl?: string) {
    const effectiveTenantId = tenantId || (await this.getOrCreateDefaultTenant());
    const longUrl = (input.long_url || input.longUrl)!.trim();
    const expiresAtRaw = input.expires_at || input.expiresAt;
    const expiresAt = expiresAtRaw ? parseStrictUTC(expiresAtRaw) : null;
    const tagsSerialized = input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null;

    const hostBase = baseUrl || `http://localhost:${env.PORT}`;
    const MAX_RETRIES = 5;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const code = generateShortCode(7);

      try {
        const link = await prisma.link.create({
          data: {
            code,
            longUrl,
            expiresAt,
            tags: tagsSerialized,
            tenantId: effectiveTenantId,
          },
        });

        return {
          id: link.id,
          code: link.code,
          short_url: `${hostBase}/r/${link.code}`,
          long_url: link.longUrl,
          created_at: link.createdAt.toISOString(),
          expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
          tags: link.tags ? JSON.parse(link.tags) : [],
        };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          attempt < MAX_RETRIES
        ) {
          console.warn(`[COLLISION] Slug collision detected for code "${code}" (attempt ${attempt}/${MAX_RETRIES}). Retrying with new code...`);
          continue;
        }
        throw error;
      }
    }

    throw new Error('Failed to generate a unique short code after maximum retry attempts.');
  }

  /**
   * Returns a paged list of links for a tenant.
   */
  async listLinks(query: ListLinksQuery, tenantId?: string, baseUrl?: string) {
    const effectiveTenantId = tenantId || (await this.getOrCreateDefaultTenant());
    const { page, limit } = query;
    const skip = (page - 1) * limit;
    const hostBase = baseUrl || `http://localhost:${env.PORT}`;

    // Eager loading with batch click count to avoid N+1 query overhead (Bug #7)
    const [links, total] = await Promise.all([
      prisma.link.findMany({
        where: { tenantId: effectiveTenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        include: {
          _count: {
            select: { clicks: true },
          },
        },
      }),
      prisma.link.count({
        where: { tenantId: effectiveTenantId },
      }),
    ]);

    return {
      data: links.map((link) => ({
        id: link.id,
        code: link.code,
        short_url: `${hostBase}/r/${link.code}`,
        long_url: link.longUrl,
        created_at: link.createdAt.toISOString(),
        expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
        tags: link.tags ? JSON.parse(link.tags) : [],
        clicks: link._count?.clicks ?? 0,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Diagnostic helper: demonstrates Bug #7 (N+1 query pattern)
   * Dispatches 1 query for links list, then N separate count queries in a loop.
   */
  async listLinksWithNPlusOne(tenantId: string, limit: number = 50) {
    let queryCount = 0;
    queryCount++; // 1 for findMany
    const links = await prisma.link.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const enriched = [];
    for (const link of links) {
      queryCount++; // N queries, 1 per link
      const clickCount = await prisma.clickEvent.count({
        where: { linkId: link.id },
      });
      enriched.push({
        ...link,
        clicks: clickCount,
      });
    }

    return { enriched, queryCount };
  }

  /**
   * Diagnostic helper: demonstrates Bug #7 Fix (Eager loading)
   * Dispatches exactly 1 query to fetch links with batch aggregated click counts.
   */
  async listLinksWithEagerLoading(tenantId: string, limit: number = 50) {
    let queryCount = 0;
    queryCount++; // 1 query with _count aggregation
    const links = await prisma.link.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        _count: {
          select: { clicks: true },
        },
      },
    });

    const enriched = links.map((l) => ({
      ...l,
      clicks: l._count?.clicks ?? 0,
    }));

    return { enriched, queryCount };
  }

  /**
   * Searches and filters links scoped strictly to the authenticated tenant.
   * Enforces top-level tenant isolation, allowlisted sorting, and bounded pagination.
   */
  async searchLinks(query: SearchLinksQuery, tenantId?: string, baseUrl?: string) {
    const effectiveTenantId = tenantId || (await this.getOrCreateDefaultTenant());
    const hostBase = baseUrl || `http://localhost:${env.PORT}`;
    const { q, tag, page, page_size, sort_by, sort_order } = query;
    const skip = (Math.max(1, page) - 1) * page_size;

    // Strict multi-tenant scoping at top level of where clause
    const where: Prisma.LinkWhereInput = {
      tenantId: effectiveTenantId,
    };

    const andConditions: Prisma.LinkWhereInput[] = [];

    if (q) {
      andConditions.push({
        OR: [
          { longUrl: { contains: q } },
          { code: { contains: q } },
        ],
      });
    }

    if (tag) {
      andConditions.push({
        tags: { contains: tag },
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    let orderBy: Prisma.LinkOrderByWithRelationInput;
    if (sort_by === 'clicks') {
      orderBy = { clicks: { _count: sort_order } };
    } else if (sort_by === 'expires_at') {
      orderBy = { expiresAt: sort_order };
    } else {
      orderBy = { createdAt: sort_order };
    }

    const [links, total] = await Promise.all([
      prisma.link.findMany({
        where,
        orderBy,
        skip,
        take: page_size,
        include: {
          _count: {
            select: { clicks: true },
          },
        },
      }),
      prisma.link.count({
        where,
      }),
    ]);

    return {
      data: links.map((link) => ({
        id: link.id,
        code: link.code,
        short_url: `${hostBase}/r/${link.code}`,
        long_url: link.longUrl,
        created_at: link.createdAt.toISOString(),
        expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
        tags: link.tags ? JSON.parse(link.tags) : [],
        clicks: link._count.clicks,
      })),
      pagination: {
        page,
        page_size,
        total,
        total_pages: Math.ceil(total / page_size),
      },
    };
  }

  /**
   * Retrieves a single link by ID with tenant metadata caching.
   */
  async getLinkById(id: string, tenantId?: string, baseUrl?: string) {
    const effectiveTenantId = tenantId || (await this.getOrCreateDefaultTenant());
    const hostBase = baseUrl || `http://localhost:${env.PORT}`;

    // 1. Try tenant-scoped metadata cache
    const cached = await cacheService.getTenantLink(effectiveTenantId, id);
    if (cached) {
      return cached;
    }

    // 2. Scoped lookup enforcing tenant isolation to prevent IDOR
    const link = await prisma.link.findFirst({
      where: {
        id,
        tenantId: effectiveTenantId,
      },
    });

    if (!link) {
      return null;
    }

    const formatted = {
      id: link.id,
      code: link.code,
      short_url: `${hostBase}/r/${link.code}`,
      long_url: link.longUrl,
      created_at: link.createdAt.toISOString(),
      expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
      tags: link.tags ? JSON.parse(link.tags) : [],
    };

    // 3. Cache tenant link metadata
    await cacheService.setTenantLink(effectiveTenantId, id, formatted, 3600);

    return formatted;
  }

  /**
   * Updates an existing link's destination or tags (Scoped to tenant).
   * Implements Cache-Aside eviction: updates DB then deletes cache keys.
   */
  async updateLink(id: string, input: UpdateLinkInput, tenantId?: string, baseUrl?: string) {
    const effectiveTenantId = tenantId || (await this.getOrCreateDefaultTenant());
    const hostBase = baseUrl || `http://localhost:${env.PORT}`;

    // Verify ownership
    const existing = await prisma.link.findFirst({
      where: {
        id,
        tenantId: effectiveTenantId,
      },
    });

    if (!existing) {
      return null;
    }

    const updateData: Prisma.LinkUpdateInput = {};
    const newLongUrl = input.long_url || input.longUrl;
    if (newLongUrl) {
      updateData.longUrl = newLongUrl.trim();
    }
    if (input.expires_at !== undefined) {
      updateData.expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    }
    if (input.tags !== undefined) {
      updateData.tags = JSON.stringify(input.tags);
    }

    const updated = await prisma.link.update({
      where: { id: existing.id },
      data: updateData,
    });

    // EVICTION: Evict public redirect cache and tenant metadata cache
    await cacheService.invalidateRedirectTarget(existing.code);
    await cacheService.invalidateTenantLink(effectiveTenantId, id);

    return {
      id: updated.id,
      code: updated.code,
      short_url: `${hostBase}/r/${updated.code}`,
      long_url: updated.longUrl,
      created_at: updated.createdAt.toISOString(),
      expires_at: updated.expiresAt ? updated.expiresAt.toISOString() : null,
      tags: updated.tags ? JSON.parse(updated.tags) : [],
    };
  }

  /**
   * Deletes a short link (Scoped to tenant).
   * Implements Cache-Aside eviction: deletes in DB then invalidates cache.
   */
  async deleteLink(id: string, tenantId?: string): Promise<boolean> {
    const effectiveTenantId = tenantId || (await this.getOrCreateDefaultTenant());

    const existing = await prisma.link.findFirst({
      where: {
        id,
        tenantId: effectiveTenantId,
      },
    });

    if (!existing) {
      return false;
    }

    await prisma.link.delete({
      where: { id: existing.id },
    });

    // EVICTION: Evict public redirect cache and tenant metadata cache
    await cacheService.invalidateRedirectTarget(existing.code);
    await cacheService.invalidateTenantLink(effectiveTenantId, id);

    return true;
  }

  /**
   * Resolves a public short code for redirection using Cache-Aside.
   * If Redis is down, it catches error and falls back to PostgreSQL seamlessly.
   */
  async resolveRedirect(code: string, ip?: string, userAgent?: string, referrer?: string) {
    // 1. Check Redis Cache
    const cachedUrl = await cacheService.getRedirectTarget(code);
    if (cachedUrl) {
      this.recordClickAsync(code, ip, userAgent, referrer);
      return {
        status: 'FOUND' as const,
        longUrl: cachedUrl,
        source: 'cache' as const,
      };
    }

    // 2. Cache Miss -> Query Database
    const link = await prisma.link.findUnique({
      where: { code },
    });

    if (!link) {
      return { status: 'NOT_FOUND' as const };
    }

    // Check expiration and UTC validity (Bug #4 fix: strict UTC comparison prevents midnight 404 gap)
    const activeCheck = isLinkActiveUTC(link.createdAt, link.expiresAt);
    if (!activeCheck.active) {
      if (activeCheck.reason === 'EXPIRED') {
        return { status: 'EXPIRED' as const };
      }
      return { status: 'NOT_FOUND' as const };
    }

    // 3. Populate Redis Cache (1-hour TTL + jitter)
    await cacheService.setRedirectTarget(code, link.longUrl, 3600);

    // Record bucketed click atomically (Bug #5 fix: eliminates check-then-act race condition)
    await this.recordClickBucketAtomic(link.id);

    // Record click event asynchronously
    this.recordClickAsync(code, ip, userAgent, referrer);

    return {
      status: 'FOUND' as const,
      longUrl: link.longUrl,
      source: 'db' as const,
    };
  }

  /**
   * Retrieves link click analytics (owner-scoped).
   */
  async getLinkAnalytics(id: string, tenantId?: string, options?: AnalyticsQueryOptions) {
    const effectiveTenantId = tenantId || (await this.getOrCreateDefaultTenant());
    return analyticsService.getLinkAnalytics(id, effectiveTenantId, options);
  }

  /**
   * Enqueues click event asynchronously via queueService with privacy-preserving ipHash and eventId.
   */
  private async recordClickAsync(code: string, ip?: string, userAgent?: string, referrer?: string) {
    try {
      const link = await prisma.link.findUnique({
        where: { code },
        select: { id: true, tenantId: true },
      });

      if (!link) return;

      const eventId = `clk_${crypto.randomUUID()}`;
      const ipHash = analyticsService.hashIp(ip);

      await queueService.enqueueClick({
        eventId,
        linkId: link.id,
        tenantId: link.tenantId,
        ipHash,
        userAgent: userAgent ? userAgent.slice(0, 500) : null,
        referrer: referrer ? referrer.slice(0, 500) : null,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.warn(`[ANALYTICS] Graceful degradation: Failed to enqueue click for ${code}: ${err.message}`);
    }
  }

  /**
   * Check-then-act pattern vulnerable to race conditions (Bug #5 demonstration).
   */
  async recordClickBucketBuggy(linkId: string, timestamp: Date = new Date()): Promise<void> {
    const bucket = timestamp.toISOString().substring(0, 13);
    const existing = await prisma.analyticsBucket.findUnique({
      where: {
        analytics_link_id_bucket_unique: {
          linkId,
          timestampBucket: bucket,
        },
      },
    });

    // Artificially small pause to open the race window for concurrent requests
    await new Promise((r) => setTimeout(r, 15));

    if (!existing) {
      await prisma.analyticsBucket.create({
        data: {
          linkId,
          timestampBucket: bucket,
          count: 1,
        },
      });
    } else {
      await prisma.analyticsBucket.update({
        where: {
          analytics_link_id_bucket_unique: {
            linkId,
            timestampBucket: bucket,
          },
        },
        data: {
          count: { increment: 1 },
        },
      });
    }
  }

  /**
   * Unsafe timestamp update vulnerable to out-of-order clobbering (Step 5 Break demonstration).
   */
  async recordClickBucketUnsafeTimestamp(linkId: string, timestamp: Date): Promise<void> {
    const bucket = timestamp.toISOString().substring(0, 13);
    await prisma.analyticsBucket.upsert({
      where: {
        analytics_link_id_bucket_unique: {
          linkId,
          timestampBucket: bucket,
        },
      },
      create: {
        linkId,
        timestampBucket: bucket,
        count: 1,
        lastAccessedAt: timestamp,
      },
      update: {
        count: { increment: 1 },
        lastAccessedAt: timestamp, // Unconditional overwrite clobbers newer timestamps
      },
    });
  }

  /**
   * Atomic database upsert eliminating race conditions and enforcing monotonic timestamps.
   */
  async recordClickBucketAtomic(linkId: string, timestamp: Date = new Date()): Promise<void> {
    const bucket = timestamp.toISOString().substring(0, 13);
    
    // In PostgreSQL: ON CONFLICT DO UPDATE SET count = count + 1, lastAccessedAt = GREATEST(lastAccessedAt, EXCLUDED.lastAccessedAt)
    const existing = await prisma.analyticsBucket.findUnique({
      where: {
        analytics_link_id_bucket_unique: {
          linkId,
          timestampBucket: bucket,
        },
      },
      select: {
        lastAccessedAt: true,
      },
    });

    const targetTimestamp = existing && existing.lastAccessedAt > timestamp
      ? existing.lastAccessedAt
      : timestamp;

    await prisma.analyticsBucket.upsert({
      where: {
        analytics_link_id_bucket_unique: {
          linkId,
          timestampBucket: bucket,
        },
      },
      create: {
        linkId,
        timestampBucket: bucket,
        count: 1,
        lastAccessedAt: timestamp,
      },
      update: {
        count: { increment: 1 },
        lastAccessedAt: targetTimestamp,
      },
    });
  }

  /**
   * Retrieves bucket count for verification.
   */
  async getBucketCount(linkId: string, timestamp: Date = new Date()): Promise<number> {
    const bucket = timestamp.toISOString().substring(0, 13);
    const record = await prisma.analyticsBucket.findUnique({
      where: {
        analytics_link_id_bucket_unique: {
          linkId,
          timestampBucket: bucket,
        },
      },
    });
    return record?.count ?? 0;
  }

  /**
   * Retrieves full bucket record for verification.
   */
  async getBucketRecord(linkId: string, timestamp: Date = new Date()) {
    const bucket = timestamp.toISOString().substring(0, 13);
    return prisma.analyticsBucket.findUnique({
      where: {
        analytics_link_id_bucket_unique: {
          linkId,
          timestampBucket: bucket,
        },
      },
    });
  }
}

export const linkService = new LinkService();

