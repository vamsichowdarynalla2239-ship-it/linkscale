import { createResilientBreaker, withTimeout } from '../utils/resilience';
import { businessQueueDepthGauge } from '../utils/metrics';
import { logger } from '../utils/logger';

export type NotificationChannel = 'email' | 'sms' | 'push';

export interface NotificationRequest {
  channel: NotificationChannel;
  recipient: string;
  message: string;
  requestId?: string;
}

export interface NotificationDeliveryResult {
  delivered: boolean;
  degraded: boolean;
  channel: NotificationChannel;
  status: 'sent' | 'queued_fallback';
  provider: string;
  queued_id?: string;
}

export class NotificationService {
  private static readonly MAX_FALLBACK_QUEUE_SIZE = 1000;
  private fallbackQueue: Array<NotificationRequest & { queued_id: string; enqueued_at: string }> = [];
  private providerSimMode: 'healthy' | 'down' | 'slow' = 'healthy';
  private providerCallCount = 0;

  private readonly timeoutMs: number;
  private readonly breaker;

  constructor(options: { timeoutMs?: number; resetTimeoutMs?: number; volumeThreshold?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 1000;
    this.breaker = createResilientBreaker(
      async (req: NotificationRequest) => this.dispatchToProvider(req),
      (req: NotificationRequest) => this.enqueueFallback(req),
      {
        dependency: 'notification_provider',
        timeoutMs: this.timeoutMs,
        errorThresholdPercentage: 50,
        resetTimeoutMs: options.resetTimeoutMs ?? 30000,
        volumeThreshold: options.volumeThreshold ?? 5,
      }
    );
  }

  public setSimulatedProviderMode(mode: 'healthy' | 'down' | 'slow'): void {
    this.providerSimMode = mode;
  }

  public getProviderCallCount(): number {
    return this.providerCallCount;
  }

  public getFallbackQueue(): Array<NotificationRequest & { queued_id: string; enqueued_at: string }> {
    return [...this.fallbackQueue];
  }

  public getBreakerState(): 'open' | 'half_open' | 'closed' {
    if (this.breaker.opened) return 'open';
    if (this.breaker.halfOpen) return 'half_open';
    return 'closed';
  }

  private async dispatchToProvider(req: NotificationRequest): Promise<NotificationDeliveryResult> {
    this.providerCallCount += 1;

    return withTimeout(
      async (signal) => {
        if (this.providerSimMode === 'down') {
          const err: any = new Error('External notification provider unreachable (ECONNREFUSED)');
          err.code = 'ECONNREFUSED';
          throw err;
        }

        if (this.providerSimMode === 'slow') {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 3000);
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('Provider request aborted due to timeout'));
            });
          });
        }

        const provider = req.channel === 'email' ? 'sendgrid' : req.channel === 'sms' ? 'twilio' : 'firebase';
        logger.info('Notification dispatched via primary provider', {
          request_id: req.requestId,
          channel: req.channel,
          provider,
        });

        return {
          delivered: true,
          degraded: false,
          channel: req.channel,
          status: 'sent',
          provider,
        };
      },
      {
        timeoutMs: this.timeoutMs,
        dependency: 'notification_provider',
        operation: `send_${req.channel}`,
        requestId: req.requestId,
      }
    );
  }

  private enqueueFallback(req: NotificationRequest): NotificationDeliveryResult {
    const queuedId = `retry_${Date.now()}_${this.fallbackQueue.length + 1}`;
    if (this.fallbackQueue.length >= NotificationService.MAX_FALLBACK_QUEUE_SIZE) {
      this.fallbackQueue.shift(); // Bound in-memory queue to prevent OOM memory leak
    }
    this.fallbackQueue.push({
      ...req,
      queued_id: queuedId,
      enqueued_at: new Date().toISOString(),
    });

    const channelDepth = this.fallbackQueue.filter((item) => item.channel === req.channel).length;
    businessQueueDepthGauge.set({ channel: req.channel }, channelDepth);

    return {
      delivered: false,
      degraded: true,
      channel: req.channel,
      status: 'queued_fallback',
      provider: 'async_retry_queue',
      queued_id: queuedId,
    };
  }

  public async send(req: NotificationRequest): Promise<NotificationDeliveryResult> {
    return this.breaker.fire(req);
  }
}

export const notificationService = new NotificationService();
