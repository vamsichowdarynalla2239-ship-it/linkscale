import client from 'prom-client';

// Create a custom Prometheus registry
export const register = new client.Registry();

// Collect Node.js process and runtime default metrics (CPU, memory, event loop lag)
client.collectDefaultMetrics({ register });

// 1. Counter: http_requests_total
export const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests processed by the service',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

// 2. Histogram: http_request_duration_seconds
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// 3. Gauges: in-flight concurrency and business queue/links gauge
export const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Current number of in-flight HTTP requests being processed',
  registers: [register],
});

export const businessQueueDepthGauge = new client.Gauge({
  name: 'notification_queue_depth',
  help: 'Current depth of pending notification/click delivery events in queue',
  labelNames: ['channel'],
  registers: [register],
});

// Initialize default channel gauge values to 0 so they appear on scrape immediately
businessQueueDepthGauge.set({ channel: 'email' }, 0);
businessQueueDepthGauge.set({ channel: 'sms' }, 0);
businessQueueDepthGauge.set({ channel: 'push' }, 0);

// 4. Circuit Breaker observability metrics
export const circuitBreakerStateGauge = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Current circuit breaker state (0=closed, 1=half_open, 2=open)',
  labelNames: ['dependency'],
  registers: [register],
});

export const circuitBreakerFallbacksTotal = new client.Counter({
  name: 'circuit_breaker_fallbacks_total',
  help: 'Total number of fallback invocations served while circuit breaker is open or failing',
  labelNames: ['dependency'],
  registers: [register],
});
