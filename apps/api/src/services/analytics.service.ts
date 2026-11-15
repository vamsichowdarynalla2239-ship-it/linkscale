import crypto from 'crypto';
import { prisma } from '../db';
import { logger } from '../utils/logger';

const IP_SALT = process.env.ANALYTICS_IP_SALT || 'upsk_salt_secure_analytics_2026';

export interface AnalyticsQueryOptions {
  from?: string;
  to?: string;
}

export interface LinkAnalyticsResult {
  link_id: string;
  total_clicks: number;
  last_clicked_at: string | null;
  time_window: {
    from: string;
    to: string;
  };
}

export class AnalyticsService {
  /**
   * Hashes an IP address using salted SHA-256 for privacy compliance (GDPR/CCPA).
   * Raw IPs are never stored in the database or cache.
   */
  hashIp(ip?: string): string | null {
    if (!ip) {
      return null;
    }
    // Normalize localhost / ipv6-mapped ipv4
    const cleanedIp = ip.replace(/^::ffff:/, '').trim();
    if (!cleanedIp || cleanedIp === '127.0.0.1' || cleanedIp === '::1') {
      return crypto.createHash('sha256').update(`localhost_${IP_SALT}`).digest('hex');
    }
    return crypto.createHash('sha256').update(`${cleanedIp}_${IP_SALT}`).digest('hex');
  }

  /**
   * Retrieves owner-scoped click analytics for a specific link over a time window.
   */
  async getLinkAnalytics(
    linkId: string,
    tenantId: string,
    options?: AnalyticsQueryOptions
  ): Promise<LinkAnalyticsResult | null> {
    // 1. Verify link ownership to prevent IDOR
    const link = await prisma.link.findFirst({
      where: {
        id: linkId,
        tenantId,
      },
    });

    if (!link) {
      return null;
    }

    // 2. Parse time window filters
    const now = new Date();
    const fromDate = options?.from ? new Date(options.from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const toDate = options?.to ? new Date(options.to) : now;

    // 3. Count matching clicks within window
    const totalClicks = await prisma.clickEvent.count({
      where: {
        linkId,
        tenantId,
        clickedAt: {
          gte: fromDate,
          lte: toDate,
        },
      },
    });

    // 4. Retrieve most recent click timestamp
    const latestClick = await prisma.clickEvent.findFirst({
      where: {
        linkId,
        tenantId,
      },
      orderBy: {
        clickedAt: 'desc',
      },
      select: {
        clickedAt: true,
      },
    });

    return {
      link_id: link.id,
      total_clicks: totalClicks,
      last_clicked_at: latestClick ? latestClick.clickedAt.toISOString() : null,
      time_window: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
      },
    };
  }

  /**
   * Enforces data retention by purging click records older than retentionDays.
   */
  async purgeOldClicks(retentionDays: number = 30, tenantId?: string): Promise<{ deleted: number; cutoff: string }> {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const result = await prisma.clickEvent.deleteMany({
      where: {
        clickedAt: {
          lt: cutoffDate,
        },
        ...(tenantId ? { tenantId } : {}),
      },
    });

    logger.info(`[ANALYTICS] Purged ${result.count} click records older than ${cutoffDate.toISOString()}`);

    return {
      deleted: result.count,
      cutoff: cutoffDate.toISOString(),
    };
  }
}

export const analyticsService = new AnalyticsService();
