import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { EventEnvelope } from '../types.js';

// Vendored copy of HC-Event-Bus: keep in sync with its src/bus.ts for the
// production-readiness changes of the Redis runbook (2026-09-26):
//   W1 retention: every publish is XADD <stream> MAXLEN ~ maxLen (option, else
//      HC_BUS_MAXLEN, else 100000). Trimming ignores consumer groups: an entry a
//      lagging group has not read/acked yet is lost once it falls outside the
//      newest ~maxLen entries, so maxLen must stay well above the worst lag
//      (the Reliability-Watchdog watches XINFO GROUPS lag via hc-event-bus).
//   W2 fail-fast: in production (NODE_ENV/HC_ENV/HC_ENVIRONMENT=production) a
//      missing redisUrl/REDIS_URL throws instead of silently falling back to
//      redis://localhost:6379 (the password-less test Redis on the server).
export const DEFAULT_MAX_LEN = 100_000;
export const DEV_REDIS_URL = 'redis://localhost:6379';

type Env = Record<string, string | undefined>;

export function isProductionEnv(env: Env = process.env): boolean {
  return [env.NODE_ENV, env.HC_ENV, env.HC_ENVIRONMENT].some((v) => v?.trim().toLowerCase() === 'production');
}

export function resolveRedisUrl(explicit?: string, env: Env = process.env): string {
  const url = explicit?.trim() || env.REDIS_URL?.trim();
  if (url) return url;
  if (isProductionEnv(env)) {
    throw new Error(
      '[HCEventBus] No Redis URL configured in production (NODE_ENV/HC_ENV=production): ' +
      'set REDIS_URL or pass redisUrl. Refusing to fall back to ' + DEV_REDIS_URL + '.'
    );
  }
  return DEV_REDIS_URL;
}

export function resolveMaxLen(option: number | undefined, env: Env = process.env): number {
  const raw = option ?? (env.HC_BUS_MAXLEN?.trim() ? Number(env.HC_BUS_MAXLEN) : DEFAULT_MAX_LEN);
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(`[HCEventBus] Invalid stream max length ${option !== undefined ? 'option' : 'HC_BUS_MAXLEN'}=${String(option ?? env.HC_BUS_MAXLEN)}: expected a positive integer.`);
  }
  return raw;
}

export class HCEventBus {
  private redis: Redis;
  private streamName: string;
  private groupName: string;
  readonly maxLen: number;

  constructor(options: { redisUrl?: string, streamName?: string, groupName?: string, maxLen?: number } = {}) {
    // Validate before connecting, so a misconfigured process fails fast.
    const url = resolveRedisUrl(options.redisUrl);
    this.maxLen = resolveMaxLen(options.maxLen);
    this.streamName = options.streamName || 'hc-events';
    this.groupName = options.groupName || 'hc-default-group';
    this.redis = new Redis(url);
  }

  async publish(event: Partial<EventEnvelope> & Pick<EventEnvelope, 'event_type' | 'producer' | 'payload' | 'correlation_id'>): Promise<string> {
    const fullEvent: EventEnvelope = {
      event_id: event.event_id || uuidv4(),
      event_type: event.event_type,
      producer: event.producer,
      timestamp: event.timestamp || new Date().toISOString(),
      schema_version: event.schema_version || '1.0.0',
      correlation_id: event.correlation_id,
      payload: event.payload,
      signature: event.signature,
    };

    const id = await this.redis.xadd(
      this.streamName,
      'MAXLEN', '~', this.maxLen,
      '*',
      'event',
      JSON.stringify(fullEvent)
    );

    return id!;
  }

  async subscribe(consumerName: string, callback: (event: EventEnvelope) => Promise<void>, eventTypes: string[] = ['*']) {
    // Ensure group exists
    try {
      await this.redis.xgroup('CREATE', this.streamName, this.groupName, '0', 'MKSTREAM');
    } catch (e: any) {
      if (!e.message.includes('BUSYGROUP')) {
        throw e;
      }
    }

    console.log(`Consumer ${consumerName} subscribed to types: ${eventTypes.join(', ')}`);

    // Polling loop (simplified for client lib)
    const poll = async () => {
      try {
        const results: any = await this.redis.xreadgroup(
          'GROUP', this.groupName, consumerName,
          'COUNT', 1,
          'BLOCK', 1000,
          'STREAMS', this.streamName, '>'
        );

        if (results) {
          for (const [_, messages] of results) {
            for (const [id, [__, eventJson]] of messages) {
              const event: EventEnvelope = JSON.parse(eventJson);
              if (eventTypes.includes('*') || eventTypes.includes(event.event_type)) {
                try {
                  await callback(event);
                } catch (err) {
                  console.error(`Error processing event ${id}:`, err);
                }
              }
              // Always acknowledge to move the pointer
              await this.redis.xack(this.streamName, this.groupName, id);
            }
          }
        }
      } catch (err) {
        console.error('Subscription error:', err);
      }
      setImmediate(poll);
    };

    poll();
  }

  async disconnect() {
    await this.redis.quit();
  }
}
