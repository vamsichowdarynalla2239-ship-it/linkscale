import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { hashApiKey } from '../utils/api-key';

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

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];

  let rawKey: string | undefined;

  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
    rawKey = apiKeyHeader.trim();
  } else if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    rawKey = authHeader.slice(7).trim();
  }

  if (!rawKey) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: Missing API Key',
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
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized: Invalid API Key',
          request_id: req.requestId,
        },
      });
      return;
    }

    if (apiKey.revokedAt) {
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
