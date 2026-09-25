import { describe, expect, test } from 'bun:test';
import { CapitalAllocator } from '../src/allocator.js';
import {
  EMPTY_LIMITS,
  loadCapitalLimitsFromEnv,
  parseCapitalLimits,
  resolveUserLimit,
  type UserCapitalLimit,
} from '../src/capital-limits.js';
import { DeployedCapitalTracker, accountKey } from '../src/deployed-capital.js';
import type { ConsensusDecision, PortfolioState } from '../src/types.js';

const allocator = new CapitalAllocator();

function consensus(final_alpha = 95, confidence_score = 99, overrides: Partial<ConsensusDecision> = {}): ConsensusDecision {
  return {
    signal_id: 'sig-1',
    correlation_id: 'corr-1',
    final_alpha,
    confidence_score,
    direction: 'LONG',
    regime_alignment: 0.8,
    decision_latency_ms: 10,
    ttl_seconds: 300,
    account_id: 'acc-1',
    environment: 'LIVE',
    ...overrides,
  };
}

function portfolio(available_balance: number, total_exposure = 0): PortfolioState {
  return {
    account_id: 'acc-1',
    environment: 'LIVE',
    platform_name: 'MEXC',
    total_exposure,
    open_positions: 0,
    sector_exposure: {},
    long_exposure: 0,
    short_exposure: 0,
    net_exposure: 0,
    gross_exposure: 0,
    available_balance,
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const lim = (max: number, extra: Partial<UserCapitalLimit> = {}): UserCapitalLimit => ({ max_capital_usdt: max, ...extra });

describe('allocateForUser: safe default', () => {
  test('no configured limit -> REJECTED (never unlimited)', () => {
    const r = allocator.allocateForUser(consensus(), portfolio(10_000), 'NORMAL', { limit: null, deployed_usdt: 0 });
    expect(r.status).toBe('REJECTED');
    expect(r.allocation_usdt).toBe(0);
    expect(r.reason).toContain('No capital limit configured for account acc-1');
  });

  test.each([NaN, -1, Infinity])('unknown deployed capital %p -> REJECTED (fail closed)', (d) => {
    const r = allocator.allocateForUser(consensus(), portfolio(10_000), 'NORMAL', { limit: lim(1_000), deployed_usdt: d });
    expect(r.status).toBe('REJECTED');
  });

  test('account-level rejections still win (CPM, threshold, exposure)', () => {
    const u = { limit: lim(1_000_000), deployed_usdt: 0 };
    expect(allocator.allocateForUser(consensus(), portfolio(10_000), 'LOCKDOWN', u).reason).toContain('CPM Active');
    expect(allocator.allocateForUser(consensus(10, 10), portfolio(10_000), 'NORMAL', u).reason).toContain('below minimum threshold');
    expect(allocator.allocateForUser(consensus(), portfolio(10_000, 100), 'NORMAL', u).reason).toContain('leaves no room');
  });
});

describe('allocateForUser: sizing against the limit', () => {
  test("default sizing_base 'LIMIT': the matrix % is taken of min(AUM, limit)", () => {
    // AUM 10_000, limit 1_000 -> 3% of 1_000 = 30
    const r = allocator.allocateForUser(consensus(95, 99), portfolio(10_000), 'NORMAL', { limit: lim(1_000), deployed_usdt: 0 });
    expect(r.status).toBe('APPROVED');
    expect(r.allocation_usdt).toBeCloseTo(30, 6);
    expect(r.allocation_pct).toBeCloseTo(0.3, 6); // still expressed as % of the account AUM
  });

  test("limit above AUM: 'LIMIT' base falls back to the AUM", () => {
    const r = allocator.allocateForUser(consensus(95, 99), portfolio(1_000), 'NORMAL', { limit: lim(50_000), deployed_usdt: 0 });
    expect(r.allocation_usdt).toBeCloseTo(30, 6);
  });

  test("sizing_base 'ACCOUNT': % of full AUM, then capped to remaining room", () => {
    // 3% of 10_000 = 300 > limit 100 -> REDUCED to 100
    const r = allocator.allocateForUser(consensus(95, 99), portfolio(10_000), 'NORMAL', {
      limit: lim(100, { sizing_base: 'ACCOUNT' }),
      deployed_usdt: 0,
    });
    expect(r.status).toBe('REDUCED');
    expect(r.allocation_usdt).toBeCloseTo(100, 6);
    expect(r.reason).toContain('per-user remaining room');
  });

  test('owner example: max 100 USDT, 80 deployed -> capped to 20', () => {
    const r = allocator.allocateForUser(consensus(95, 99), portfolio(10_000), 'NORMAL', {
      limit: lim(100, { sizing_base: 'ACCOUNT' }),
      deployed_usdt: 80,
    });
    expect(r.status).toBe('REDUCED');
    expect(r.allocation_usdt).toBeCloseTo(20, 6);
  });

  test('remaining room below the minimum -> REJECTED with reason', () => {
    const r = allocator.allocateForUser(consensus(95, 99), portfolio(10_000), 'NORMAL', {
      limit: lim(100, { sizing_base: 'ACCOUNT', min_allocation_usdt: 5 }),
      deployed_usdt: 96,
    });
    expect(r.status).toBe('REJECTED');
    expect(r.allocation_usdt).toBe(0);
    expect(r.reason).toContain('Per-user capital limit reached: deployed 96.00 of 100.00 USDT, remaining 4.00 < minimum 5.00');
  });

  test('already over the limit (e.g. limit lowered) -> REJECTED, remaining reported as 0', () => {
    const r = allocator.allocateForUser(consensus(), portfolio(10_000), 'NORMAL', { limit: lim(100), deployed_usdt: 150 });
    expect(r.status).toBe('REJECTED');
    expect(r.reason).toContain('remaining 0.00');
  });

  test('limit 0 disables the account', () => {
    const r = allocator.allocateForUser(consensus(), portfolio(10_000), 'NORMAL', { limit: lim(0), deployed_usdt: 0 });
    expect(r.status).toBe('REJECTED');
  });

  test('wanted size below the minimum allocation -> REJECTED (3% of 100 = 3 < default 5)', () => {
    const r = allocator.allocateForUser(consensus(95, 99), portfolio(10_000), 'NORMAL', { limit: lim(100), deployed_usdt: 0 });
    expect(r.status).toBe('REJECTED');
    expect(r.reason).toContain('below minimum 5.00');
  });

  test('min_allocation_usdt is configurable', () => {
    const r = allocator.allocateForUser(consensus(95, 99), portfolio(10_000), 'NORMAL', {
      limit: lim(100, { min_allocation_usdt: 1 }),
      deployed_usdt: 0,
    });
    expect(r.status).toBe('APPROVED');
    expect(r.allocation_usdt).toBeCloseTo(3, 6);
  });

  test('also never exceeds the available balance', () => {
    // 99% exposure: AUM 100_000, ACCOUNT base 3% = 3_000, available 1_000, limit 50_000
    const r = allocator.allocateForUser(consensus(95, 99), portfolio(1_000, 99), 'NORMAL', {
      limit: lim(50_000, { sizing_base: 'ACCOUNT' }),
      deployed_usdt: 0,
    });
    expect(r.allocation_usdt).toBeCloseTo(1_000, 6);
    expect(r.status).toBe('REDUCED');
  });

  test('property: deployed + allocation never exceeds the limit; size finite, >= 0, <= available', () => {
    for (const max of [0, 10, 100, 1_000, 25_000]) {
      for (const deployed of [0, 1, 50, 99, 100, 999, 30_000]) {
        for (const bal of [0, 3, 100, 10_000]) {
          for (const exp of [0, 50, 97, 99.5, 100, 130]) {
            for (const base of ['LIMIT', 'ACCOUNT'] as const) {
              const r = allocator.allocateForUser(consensus(95, 99), portfolio(bal, exp), 'NORMAL', {
                limit: lim(max, { sizing_base: base }),
                deployed_usdt: deployed,
              });
              expect(Number.isFinite(r.allocation_usdt)).toBe(true);
              expect(r.allocation_usdt).toBeGreaterThanOrEqual(0);
              expect(r.allocation_usdt).toBeLessThanOrEqual(Math.max(bal, 0) + 1e-9);
              if (r.status !== 'REJECTED') {
                expect(deployed + r.allocation_usdt).toBeLessThanOrEqual(max + 1e-9);
                expect(r.allocation_usdt).toBeGreaterThanOrEqual(5);
              } else {
                expect(r.allocation_usdt).toBe(0);
              }
            }
          }
        }
      }
    }
  });
});

describe('capital limits config', () => {
  const cfg = parseCapitalLimits(JSON.stringify({
    default: { max_capital_usdt: 10 },
    accounts: {
      'acc-1': { max_capital_usdt: 100 },
      'acc-1:BACKTEST': { max_capital_usdt: 5_000, min_allocation_usdt: 1, sizing_base: 'ACCOUNT' },
    },
  }));

  test('account:environment beats account beats default', () => {
    expect(resolveUserLimit(cfg, 'acc-1', 'BACKTEST')?.max_capital_usdt).toBe(5_000);
    expect(resolveUserLimit(cfg, 'acc-1', 'LIVE')?.max_capital_usdt).toBe(100);
    expect(resolveUserLimit(cfg, 'acc-2', 'LIVE')?.max_capital_usdt).toBe(10);
  });

  test('no default -> unknown account resolves to null (no new allocation)', () => {
    const c = parseCapitalLimits('{"accounts":{"acc-1":{"max_capital_usdt":100}}}');
    expect(resolveUserLimit(c, 'acc-2', 'LIVE')).toBeNull();
    expect(resolveUserLimit(EMPTY_LIMITS, 'acc-1', 'LIVE')).toBeNull();
  });

  test.each([
    '{"accounts":{"a":{"max_capital_usdt":-1}}}',
    '{"accounts":{"a":{"max_capital_usdt":"100"}}}',
    '{"accounts":{"a":{}}}',
    '{"accounts":{"a":{"max_capital_usdt":100,"min_allocation_usdt":-2}}}',
    '{"accounts":{"a":{"max_capital_usdt":100,"sizing_base":"WHATEVER"}}}',
    '{"accounts":[]}',
    '{"default":{"max_capital_usdt":null},"accounts":{}}',
    'not json',
  ])('invalid config throws: %s', (json) => {
    expect(() => parseCapitalLimits(json)).toThrow();
  });

  test('loadCapitalLimitsFromEnv fails closed on missing or invalid config', () => {
    expect(loadCapitalLimitsFromEnv({})).toEqual(EMPTY_LIMITS);
    expect(loadCapitalLimitsFromEnv({ HC_ALLOCATOR_CAPITAL_LIMITS: '{"accounts":{"a":{"max_capital_usdt":-1}}}' })).toEqual(EMPTY_LIMITS);
    expect(loadCapitalLimitsFromEnv({ HC_ALLOCATOR_CAPITAL_LIMITS_FILE: 'Z:/does/not/exist.json' })).toEqual(EMPTY_LIMITS);
  });

  test('loadCapitalLimitsFromEnv reads inline JSON', () => {
    const c = loadCapitalLimitsFromEnv({ HC_ALLOCATOR_CAPITAL_LIMITS: '{"accounts":{"a":{"max_capital_usdt":100}}}' });
    expect(resolveUserLimit(c, 'a', 'LIVE')?.max_capital_usdt).toBe(100);
  });
});

describe('DeployedCapitalTracker', () => {
  const k = accountKey('acc-1', 'LIVE');
  const other = accountKey('acc-2', 'LIVE');

  test('reservations sum per account and are released on PositionClosed', () => {
    const t = new DeployedCapitalTracker(60_000);
    t.reserve(k, 'c1', 30, 0);
    t.reserve(k, 'c2', 20, 0);
    t.reserve(other, 'c3', 999, 0);
    t.onExecutionReport('c1', 'FILLED');
    t.onExecutionReport('c2', 'FILLED');
    expect(t.deployed(k, 1)).toBe(50);
    t.onPositionClosed('c1');
    expect(t.deployed(k, 1)).toBe(20);
    expect(t.deployed(other, 1)).toBe(999);
  });

  test('rejected/cancelled orders release only if nothing was filled', () => {
    const t = new DeployedCapitalTracker(60_000);
    t.reserve(k, 'c1', 30, 0);
    t.onExecutionReport('c1', 'REJECTED');
    expect(t.deployed(k, 1)).toBe(0);
    t.reserve(k, 'c2', 30, 0);
    t.onExecutionReport('c2', 'PARTIALLY_FILLED');
    t.onExecutionReport('c2', 'CANCELLED');
    expect(t.deployed(k, 1)).toBe(30);
  });

  test('unfilled reservations expire after the TTL, filled ones do not', () => {
    const t = new DeployedCapitalTracker(1_000);
    t.reserve(k, 'c1', 30, 0);
    t.reserve(k, 'c2', 40, 0);
    t.onExecutionReport('c2', 'FILLED');
    expect(t.deployed(k, 1_000)).toBe(70);
    expect(t.deployed(k, 1_001)).toBe(40);
    expect(t.deployed(k, 10_000_000)).toBe(40);
  });

  test('ignores non-positive / non-finite amounts and unknown ids', () => {
    const t = new DeployedCapitalTracker();
    t.reserve(k, 'c1', 0, 0);
    t.reserve(k, 'c2', NaN, 0);
    t.reserve(k, 'c3', -5, 0);
    t.onPositionClosed('nope');
    t.onExecutionReport('nope', 'FILLED');
    expect(t.size()).toBe(0);
  });

  test('end to end: the limit holds across a sequence of approvals', () => {
    const t = new DeployedCapitalTracker();
    const limit = lim(100, { sizing_base: 'ACCOUNT' });
    const sizes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const c = consensus(95, 99, { correlation_id: `c${i}` });
      const r = allocator.allocateForUser(c, portfolio(1_000), 'NORMAL', { limit, deployed_usdt: t.deployed(k, i) });
      if (r.status !== 'REJECTED') t.reserve(k, c.correlation_id, r.allocation_usdt, i);
      sizes.push(r.allocation_usdt);
    }
    // 3% of 1_000 = 30 each: 30, 30, 30, then capped 10, then rejected
    expect(sizes.slice(0, 5)).toEqual([30, 30, 30, 10, 0].map((x) => expect.closeTo(x, 6)) as unknown as number[]);
    expect(t.deployed(k, 10)).toBeCloseTo(100, 6);
    t.onPositionClosed('c0');
    const again = allocator.allocateForUser(consensus(95, 99, { correlation_id: 'c-new' }), portfolio(1_000), 'NORMAL', {
      limit,
      deployed_usdt: t.deployed(k, 11),
    });
    expect(again.status).toBe('APPROVED');
    expect(again.allocation_usdt).toBeCloseTo(30, 6);
  });
});
