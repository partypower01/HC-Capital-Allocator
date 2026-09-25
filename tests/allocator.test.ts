import { describe, expect, test } from 'bun:test';
import { CapitalAllocator } from '../src/allocator.js';
import type { CapitalPreservationMode, ConsensusDecision, PortfolioState } from '../src/types.js';

const allocator = new CapitalAllocator();

function consensus(final_alpha: number, confidence_score: number, overrides: Partial<ConsensusDecision> = {}): ConsensusDecision {
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
    environment: 'BACKTEST',
    ...overrides,
  };
}

function portfolio(available_balance: number, total_exposure: number): PortfolioState {
  return {
    account_id: 'acc-1',
    environment: 'BACKTEST',
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

// available 10_000 at 0% exposure -> virtual AUM 10_000, so 1% == 100 USDT.
const flat = portfolio(10_000, 0);

describe('sizing matrix tiers (NORMAL)', () => {
  // [alpha, confidence, expected pct]
  const cases: Array<[number, number, number]> = [
    [100, 100, 3.0],
    [90, 95.01, 3.0],
    [90, 95, 2.0], // confidence must be strictly > 95 for the 3% tier
    [89.99, 99, 2.0], // alpha below 90 falls to the 2% tier
    [80, 90.01, 2.0],
    [80, 90, 1.0],
    [79.99, 99, 1.0],
    [70, 85.01, 1.0],
    [70, 85, 0.5],
    [69.99, 99, 0.5],
    [60, 80.01, 0.5],
    [59.99, 99, 0.25],
    [50, 80.01, 0.25],
    // high alpha with only moderate confidence drops to the tier its confidence allows
    [95, 86, 1.0],
    [95, 81, 0.5],
  ];

  test.each(cases)('alpha=%p confidence=%p -> %p%%', (alpha, conf, pct) => {
    const r = allocator.allocate(consensus(alpha, conf), flat, 'NORMAL');
    expect(r.status).toBe('APPROVED');
    expect(r.allocation_pct).toBeCloseTo(pct, 10);
    expect(r.allocation_usdt).toBeCloseTo(pct * 100, 6);
    expect(r.leverage).toBe(1);
    expect(r.margin_type).toBe('ISOLATED');
    expect(r.reason).toBeUndefined();
  });

  const rejects: Array<[number, number]> = [
    [49.99, 99], // alpha below the lowest tier
    [50, 80], // confidence must be strictly > 80
    [100, 80], // even max alpha needs confidence > 80
    [0, 0],
  ];

  test.each(rejects)('alpha=%p confidence=%p -> REJECTED below threshold', (alpha, conf) => {
    const r = allocator.allocate(consensus(alpha, conf), flat, 'NORMAL');
    expect(r.status).toBe('REJECTED');
    expect(r.allocation_pct).toBe(0);
    expect(r.allocation_usdt).toBe(0);
    expect(r.reason).toBe(`Score/Confidence below minimum threshold (${alpha}/${conf})`);
  });

  test('never exceeds the 3% hard cap', () => {
    for (let alpha = 0; alpha <= 100; alpha += 5) {
      for (let conf = 0; conf <= 100; conf += 5) {
        const r = allocator.allocate(consensus(alpha, conf), flat, 'NORMAL');
        expect(r.allocation_pct).toBeLessThanOrEqual(3.0);
      }
    }
  });

  test('allocation is monotonic non-decreasing in alpha at fixed confidence', () => {
    let prev = -1;
    for (let alpha = 0; alpha <= 100; alpha += 1) {
      const r = allocator.allocate(consensus(alpha, 99), flat, 'NORMAL');
      expect(r.allocation_pct).toBeGreaterThanOrEqual(prev);
      prev = r.allocation_pct;
    }
  });
});

describe('capital preservation mode', () => {
  test('defaults to NORMAL when no mode is given', () => {
    const r = allocator.allocate(consensus(85, 92), flat);
    expect(r.status).toBe('APPROVED');
    expect(r.allocation_pct).toBeCloseTo(2.0, 10);
  });

  test('CAUTIOUS halves every tier', () => {
    for (const [alpha, conf, pct] of [[100, 100, 3.0], [85, 92, 2.0], [75, 90, 1.0], [65, 85, 0.5], [55, 85, 0.25]]) {
      const r = allocator.allocate(consensus(alpha!, conf!), flat, 'CAUTIOUS');
      expect(r.status).toBe('APPROVED');
      expect(r.allocation_pct).toBeCloseTo(pct! / 2, 10);
      expect(r.allocation_usdt).toBeCloseTo((pct! / 2) * 100, 6);
    }
  });

  test('CAUTIOUS still rejects sub-threshold signals with the threshold reason', () => {
    const r = allocator.allocate(consensus(40, 99), flat, 'CAUTIOUS');
    expect(r.status).toBe('REJECTED');
    expect(r.reason).toContain('below minimum threshold');
  });

  test.each(['DEFENSIVE', 'SURVIVAL', 'LOCKDOWN'] as CapitalPreservationMode[])(
    '%s rejects even a perfect signal before evaluating the matrix',
    (mode) => {
      const r = allocator.allocate(consensus(100, 100), flat, mode);
      expect(r.status).toBe('REJECTED');
      expect(r.allocation_pct).toBe(0);
      expect(r.allocation_usdt).toBe(0);
      expect(r.leverage).toBe(1);
      expect(r.reason).toBe(`CPM Active: ${mode}. New trades disabled.`);
    },
  );
});

describe('USDT sizing from portfolio state', () => {
  test('virtual AUM = available_balance / (1 - exposure%)', () => {
    // 9_000 available at 10% exposure -> AUM 10_000 -> 2% = 200
    const r = allocator.allocate(consensus(85, 92), portfolio(9_000, 10), 'NORMAL');
    expect(r.allocation_usdt).toBeCloseTo(200, 6);
  });

  test('higher exposure scales the implied AUM up', () => {
    // 5_000 available at 50% exposure -> AUM 10_000 -> 3% = 300
    const r = allocator.allocate(consensus(95, 99), portfolio(5_000, 50), 'NORMAL');
    expect(r.allocation_usdt).toBeCloseTo(300, 6);
  });

  test('zero balance yields a zero-sized (but approved) allocation', () => {
    const r = allocator.allocate(consensus(95, 99), portfolio(0, 0), 'NORMAL');
    expect(r.status).toBe('APPROVED');
    expect(r.allocation_usdt).toBe(0);
  });

  test('scales linearly with available balance', () => {
    const a = allocator.allocate(consensus(75, 90), portfolio(1_000, 20), 'NORMAL');
    const b = allocator.allocate(consensus(75, 90), portfolio(3_000, 20), 'NORMAL');
    expect(b.allocation_usdt).toBeCloseTo(a.allocation_usdt * 3, 6);
  });
});

describe('identity propagation', () => {
  test('approved and rejected decisions carry signal and correlation ids', () => {
    const c = consensus(85, 92, { signal_id: 'S-42', correlation_id: 'C-42' });
    for (const mode of ['NORMAL', 'LOCKDOWN'] as CapitalPreservationMode[]) {
      const r = allocator.allocate(c, flat, mode);
      expect(r.signal_id).toBe('S-42');
      expect(r.correlation_id).toBe('C-42');
    }
    const low = allocator.allocate({ ...c, final_alpha: 10 }, flat, 'NORMAL');
    expect(low.signal_id).toBe('S-42');
    expect(low.correlation_id).toBe('C-42');
  });

  test('does not leak multi-account fields (the service adds them)', () => {
    const r = allocator.allocate(consensus(85, 92), flat, 'NORMAL') as Record<string, unknown>;
    expect(r).not.toHaveProperty('account_id');
    expect(r).not.toHaveProperty('environment');
    expect(r).not.toHaveProperty('platform_name');
  });

  test('is deterministic and does not mutate its inputs', () => {
    const c = consensus(85, 92);
    const p = portfolio(9_000, 10);
    const cCopy = structuredClone(c);
    const pCopy = structuredClone(p);
    const r1 = allocator.allocate(c, p, 'CAUTIOUS');
    const r2 = allocator.allocate(c, p, 'CAUTIOUS');
    expect(r1).toEqual(r2);
    expect(c).toEqual(cCopy);
    expect(p).toEqual(pCopy);
  });
});

describe('known gap: total_exposure >= 100%', () => {
  // BUG (not fixed here, needs a product decision): virtualAUM divides by
  // (1 - total_exposure/100). At exactly 100% exposure allocation_usdt is
  // Infinity, above 100% it turns negative, and both are still APPROVED.
  // Near 100% (e.g. 99%) the implied AUM explodes to 100x the balance.
  // Run with `bun test --todo` to see it fail.
  test.todo('allocation_usdt stays finite and non-negative at >= 100% exposure', () => {
    for (const exposure of [100, 120]) {
      const r = allocator.allocate(consensus(95, 99), portfolio(1_000, exposure), 'NORMAL');
      expect(Number.isFinite(r.allocation_usdt)).toBe(true);
      expect(r.allocation_usdt).toBeGreaterThanOrEqual(0);
    }
  });
});
