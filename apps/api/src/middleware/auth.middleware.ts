import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { hashApiKey } from '../utils/api-key';
import { logger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      principal?: {
        tenantId: string;
        keyId: string;
      };
    }
  }
}

/**
 * Hardened Authentication Middleware (Bug #8 Fix)
 * Defends against auth bypass via empty/whitespace headers, malformed Bearer tokens, or missing credentials.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];

  let rawKey: string | undefined;

  // 1. Check API Key Header (Must be non-empty string with non-whitespace content)
  if (typeof apiKeyHeader === 'string') {
    const trimmed = apiKeyHeader.trim();
    if (trimmed.length > 0) {
      rawKey = trimmed;
    }
  }

  // 2. Check Authorization Header (Must be formatted strictly as "Bearer <token>")
  if (!rawKey && typeof authHeader === 'string') {
    const trimmed = authHeader.trim();
    if (trimmed.length > 0) {
      const parts = trimmed.split(/\s+/);
      if (parts.length === 2 && parts[0] === 'Bearer' && parts[1].trim().length > 0) {
        rawKey = parts[1].trim();
      } else {
        logger.warn('[SECURITY] Malformed Authorization header rejected', {
          ip: req.ip,
          request_id: req.requestId,
          format: parts[0] || 'empty',
        });
        res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized: Invalid authorization format. Expected "Bearer <token>"',
            request_id: req.requestId,
          },
        });
        return;
      }
    }
  }

  // 3. Reject if no valid credential extracted
  if (!rawKey) {
    logger.warn('[SECURITY] Unauthenticated request rejected', {
      ip: req.ip,
      request_id: req.requestId,
      method: req.method,
      path: req.path,
    });
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: Valid Authorization header or x-api-key required',
        request_id: req.requestId,
      },
    });
    return;
  }

  const keyHash = hashApiKey(rawKey);

  try {
    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
    });

    if (!apiKey) {
      logger.warn('[SECURITY] Unknown API key hash rejected', {
        ip: req.ip,
        request_id: req.requestId,
      });
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized: Invalid credentials',
          request_id: req.requestId,
        },
      });
      return;
    }

    if (apiKey.revokedAt) {
      logger.warn('[SECURITY] Revoked API key access attempt', {
        keyId: apiKey.id,
        tenantId: apiKey.tenantId,
        request_id: req.requestId,
      });
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized: API Key has been revoked',
          request_id: req.requestId,
        },
      });
      return;
    }

    req.tenantId = apiKey.tenantId;
    req.principal = {
      tenantId: apiKey.tenantId,
      keyId: apiKey.id,
    };

    next();
  } catch (error) {
    next(error);
  }
}
