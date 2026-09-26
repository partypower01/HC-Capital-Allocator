// Vendored HC-Event-Bus copy: runbook 2026-09-26 W1 (publish trims with
// XADD MAXLEN ~) and W2 (no Redis URL in production throws; dev/test keep the
// localhost fallback). The trimming case needs a real (test) Redis and only
// runs when REDIS_URL is set, since this repo's CI has no Redis service.
import { afterEach, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';
import { HCEventBus, resolveRedisUrl, DEFAULT_MAX_LEN, DEV_REDIS_URL } from '../src/bus/bus.js';

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['NODE_ENV', 'HC_ENV', 'HC_ENVIRONMENT', 'REDIS_URL', 'HC_BUS_MAXLEN']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('W2 fail-fast on a missing Redis URL in production', () => {
  test('NODE_ENV or HC_ENV = production without a URL throws', () => {
    expect(() => resolveRedisUrl(undefined, { NODE_ENV: 'production' })).toThrow(/No Redis URL configured in production/);
    expect(() => resolveRedisUrl(undefined, { HC_ENV: 'production' })).toThrow(/No Redis URL configured in production/);
    expect(() => resolveRedisUrl('  ', { NODE_ENV: 'production', REDIS_URL: '' })).toThrow(/production/);
  });

  test('production uses REDIS_URL or an explicit URL', () => {
    expect(resolveRedisUrl(undefined, { NODE_ENV: 'production', REDIS_URL: 'redis://prod:6380' })).toBe('redis://prod:6380');
    expect(resolveRedisUrl('redis://explicit:1', { HC_ENV: 'production' })).toBe('redis://explicit:1');
  });

  test('test/dev keep the localhost fallback', () => {
    expect(resolveRedisUrl(undefined, { NODE_ENV: 'test' })).toBe(DEV_REDIS_URL);
    expect(resolveRedisUrl(undefined, {})).toBe(DEV_REDIS_URL);
  });

  test('the constructor throws before connecting', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.HC_ENV;
    delete process.env.HC_ENVIRONMENT;
    delete process.env.REDIS_URL;
    expect(() => new HCEventBus()).toThrow(/production/);
  });
});

describe('W1 stream retention config', () => {
  test('rejects an invalid HC_BUS_MAXLEN before connecting', () => {
    process.env.HC_BUS_MAXLEN = 'lots';
    expect(() => new HCEventBus({ redisUrl: 'redis://127.0.0.1:1' })).toThrow(/positive integer/);
    delete process.env.HC_BUS_MAXLEN;
    expect(() => new HCEventBus({ redisUrl: 'redis://127.0.0.1:1', maxLen: 0 })).toThrow(/positive integer/);
  });
});

describe.skipIf(!process.env.REDIS_URL)('W1 stream retention against a real Redis (REDIS_URL)', () => {
  test('defaults, env override, and 1000 publishes with maxLen=100 leave ~100 entries', async () => {
    const redisUrl = process.env.REDIS_URL!;
    const raw = new Redis(redisUrl);
    const stream = `hc-events-test-retention-${Date.now()}`;
    const buses: HCEventBus[] = [];
    try {
      delete process.env.HC_BUS_MAXLEN;
      buses.push(new HCEventBus({ redisUrl }));
      expect(buses[0]!.maxLen).toBe(DEFAULT_MAX_LEN);
      process.env.HC_BUS_MAXLEN = '321';
      buses.push(new HCEventBus({ redisUrl }));
      expect(buses[1]!.maxLen).toBe(321);

      const bus = new HCEventBus({ redisUrl, streamName: stream, maxLen: 100 });
      buses.push(bus);
      for (let i = 0; i < 1000; i++) {
        await bus.publish({ event_type: 'SERVICE_HEARTBEAT', producer: 'retention-test', correlation_id: `c${i}`, payload: { i } } as any);
      }
      const len = await raw.xlen(stream);
      expect(len).toBeGreaterThanOrEqual(100);
      expect(len).toBeLessThanOrEqual(200);
    } finally {
      for (const b of buses) await b.disconnect();
      await raw.del(stream);
      await raw.quit();
    }
  }, 30_000);
});
