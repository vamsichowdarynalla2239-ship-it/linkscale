import { Request, Response, NextFunction } from 'express';
import {
  createLinkSchema,
  listLinksQuerySchema,
  searchLinksQuerySchema,
  updateLinkSchema,
} from '../schemas/link.schema';
import { linkService } from '../services/link.service';

export class LinkController {
  /**
   * POST /links - Create short link (scoped to authenticated tenant)
   */
  async createLink(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parseResult = createLinkSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            request_id: req.requestId,
            details: parseResult.error.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
        return;
      }

      const tenantId = req.tenantId || (req.headers['x-tenant-id'] as string) || undefined;
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const link = await linkService.createLink(parseResult.data, tenantId, baseUrl);

      res.status(201).json(link);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /links - List links (paged, strictly scoped to authenticated tenant)
   */
  async listLinks(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parseResult = listLinksQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            request_id: req.requestId,
            details: parseResult.error.issues,
          },
        });
        return;
      }

      const tenantId = req.tenantId || (req.headers['x-tenant-id'] as string) || undefined;
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const result = await linkService.listLinks(parseResult.data, tenantId, baseUrl);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /links/search - Search and filter links (paged, strictly scoped to authenticated tenant)
   */
  async searchLinks(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parseResult = searchLinksQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            request_id: req.requestId,
            details: parseResult.error.issues,
          },
        });
        return;
      }

      const tenantId = req.tenantId || (req.headers['x-tenant-id'] as string) || undefined;
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const result = await linkService.searchLinks(parseResult.data, tenantId, baseUrl);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /links/:id - Get link by ID (IDOR-protected, returns 404 if not owned)
   */
  async getLinkById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const tenantId = req.tenantId || (req.headers['x-tenant-id'] as string) || undefined;
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      const link = await linkService.getLinkById(id, tenantId, baseUrl);
      if (!link) {
        // Return 404 to avoid leaking resource existence to other tenants (anti-IDOR)
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Link not found',
            request_id: req.requestId,
          },
        });
        return;
      }

      res.status(200).json(link);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /links/:id - Update link destination/tags (Evicts cache)
   */
  async updateLink(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const parseResult = updateLinkSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            request_id: req.requestId,
            details: parseResult.error.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
        return;
      }

      const tenantId = req.tenantId || (req.headers['x-tenant-id'] as string) || undefined;
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const updated = await linkService.updateLink(id, parseResult.data, tenantId, baseUrl);

      if (!updated) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Link not found',
            request_id: req.requestId,
          },
        });
        return;
      }

      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /links/:id - Delete link (Evicts cache)
   */
  async deleteLink(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const tenantId = req.tenantId || (req.headers['x-tenant-id'] as string) || undefined;
      const deleted = await linkService.deleteLink(id, tenantId);

      if (!deleted) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Link not found',
            request_id: req.requestId,
          },
        });
        return;
      }

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /r/:code - Public redirect by short code (Unauthenticated)
   */
  async redirect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = req.params;

      if (!code || typeof code !== 'string') {
        res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message: 'Short code is required',
            request_id: req.requestId,
          },
        });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress;
      const userAgent = req.get('user-agent');
      const referrer = req.get('referrer') || req.get('referer');

      const result = await linkService.resolveRedirect(code, ip, userAgent, referrer);

      if (result.status === 'NOT_FOUND') {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Short link not found',
            request_id: req.requestId,
          },
        });
        return;
      }

      if (result.status === 'EXPIRED') {
        res.status(410).json({
          error: {
            code: 'GONE',
            message: 'Short link has expired',
            request_id: req.requestId,
          },
        });
        return;
      }

      // Indicate whether redirect was served from Redis cache or DB
      res.setHeader('X-Cache', result.source === 'cache' ? 'HIT' : 'MISS');

      // Safe HTTP 302 Found redirect
      res.redirect(302, result.longUrl);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /links/:id/analytics - Get analytics for link (owner-scoped)
   */
  async getAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const tenantId = req.tenantId;

      if (!tenantId) {
        res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            request_id: req.requestId,
          },
        });
        return;
      }

      const { from, to } = req.query;
      const analytics = await linkService.getLinkAnalytics(id, tenantId, {
        from: from as string | undefined,
        to: to as string | undefined,
      });

      if (!analytics) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Link not found',
            request_id: req.requestId,
          },
        });
        return;
      }

      res.status(200).json(analytics);
    } catch (error) {
      next(error);
    }
  }
}

export const linkController = new LinkController();
