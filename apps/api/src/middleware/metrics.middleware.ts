import { Request, Response, NextFunction } from 'express';
import { httpRequestCounter, httpRequestDuration, httpRequestsInFlight } from '../utils/metrics';

/**
 * Normalizes route paths to prevent high-cardinality label explosion in Prometheus.
 */
function resolveRouteLabel(req: Request): string {
  const cleanPath = (req.originalUrl || req.url || '/').split('?')[0];
  if (req.route && req.route.path) {
    const base = req.baseUrl || '';
    if (Array.isArray(req.route.path)) {
      return cleanPath;
    }
    return `${base}${req.route.path}`;
  }
  // Collapse dynamic short-link codes and UUID segments
  if (cleanPath.startsWith('/r/')) return '/r/:code';
  if (cleanPath.startsWith('/links/') && cleanPath.split('/').length >= 3) return '/links/:id';
  return cleanPath;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startNs = process.hrtime.bigint();
  httpRequestsInFlight.inc();

  res.on('finish', () => {
    httpRequestsInFlight.dec();
    const elapsedSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    const labels = {
      method: req.method,
      path: resolveRouteLabel(req),
      status: String(res.statusCode),
    };

    httpRequestCounter.inc(labels);
    httpRequestDuration.observe(labels, elapsedSeconds);
  });

  next();
}
