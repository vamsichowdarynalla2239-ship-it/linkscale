import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error';
import { logger } from '../utils/logger';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: any;
  };
}

/**
 * 404 handler for unrecognized routes.
 */
export function notFoundHandler(req: Request, res: Response): void {
  const envelope: ErrorEnvelope = {
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl || req.url} not found`,
      request_id: req.requestId,
    },
  };
  res.status(404).json(envelope);
}

/**
 * Global Express error handling middleware.
 * Ensures consistent error envelopes and prevents leaking stack traces.
 */
export function globalErrorHandler(
  err: any,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const requestId = req.requestId || 'req_unknown';

  if (err instanceof AppError) {
    // Known operational error
    if (err.statusCode >= 500) {
      logger.error(`Operational error: ${err.message}`, {
        request_id: requestId,
        code: err.code,
        status_code: err.statusCode,
        stack: err.stack,
      });
    }

    const envelope: ErrorEnvelope = {
      error: {
        code: err.code,
        message: err.message,
        request_id: requestId,
        ...(err.details ? { details: err.details } : {}),
      },
    };

    res.status(err.statusCode).json(envelope);
    return;
  }

  // Unhandled / programmer / unexpected error (500)
  logger.error(`Unhandled exception on ${req.method} ${req.originalUrl || req.url}: ${err?.message || err}`, {
    request_id: requestId,
    route: req.originalUrl || req.url,
    method: req.method,
    stack: err?.stack,
  });

  const envelope: ErrorEnvelope = {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal server error occurred.',
      request_id: requestId,
    },
  };

  res.status(500).json(envelope);
}

