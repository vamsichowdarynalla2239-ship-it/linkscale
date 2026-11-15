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
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
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

    const [links, total] = await Promise.all([
      prisma.link.findMany({
        where: { tenantId: effectiveTenantId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
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

    // Check expiration
    if (link.expiresAt && new Date() > link.expiresAt) {
      return { status: 'EXPIRED' as const };
    }

    // 3. Populate Redis Cache (1-hour TTL + jitter)
    await cacheService.setRedirectTarget(code, link.longUrl, 3600);

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
}

export const linkService = new LinkService();

