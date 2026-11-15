import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingRequestId = req.headers['x-request-id'];

  const requestId =
    typeof incomingRequestId === 'string' && incomingRequestId.trim()
      ? incomingRequestId.trim()
      : `req_${randomUUID()}`;

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  next();
}

