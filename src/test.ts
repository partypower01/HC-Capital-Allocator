// Real unit test - no live services needed, allocate() is pure/deterministic.
// TD-030: this file previously called allocator.allocate() across 4
// scenarios and console.log'd each result with no assertion anywhere -
// proved nothing about whether the real matrix logic actually produces
// correct output.
import { CapitalAllocator } from './allocator.js';
import { ConsensusDecision, PortfolioState } from './types.js';

function assert(cond: boolean, message: string) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: ${message}`);
}

function closeTo(a: number, b: number, epsilon = 0.01): boolean {
  return Math.abs(a - b) < epsilon;
}

const allocator = new CapitalAllocator();

const mockConsensus: ConsensusDecision = {
  signal_id: 'sig-123',
  correlation_id: 'corr-456',
  final_alpha: 85,
  confidence_score: 92,
  direction: 'LONG',
  regime_alignment: 0.8,
  decision_latency_ms: 50,
  ttl_seconds: 300,
  account_id: 'acc-test',
  environment: 'LIVE'
};

const mockPortfolio: PortfolioState = {
  account_id: 'acc-test',
  environment: 'LIVE',
  platform_name: 'MEXC',
  total_exposure: 10,
  open_positions: 2,
  sector_exposure: {},
  long_exposure: 5,
  short_exposure: 5,
  net_exposure: 0,
  gross_exposure: 10,
  available_balance: 9000,
  updated_at: new Date().toISOString()
};

// --- Test 1: Normal allocation (alpha=85, confidence=92 -> 2.0% tier) ---
console.log('--- Test 1: Normal Allocation ---');
const result1 = allocator.allocate(mockConsensus, mockPortfolio, 'NORMAL');
console.log(result1);
assert(result1.status === 'APPROVED', 'Test 1: NORMAL allocation with strong score is APPROVED');
assert(closeTo(result1.allocation_pct, 2.0), `Test 1: allocation_pct is the real 2.0% matrix tier (got ${result1.allocation_pct})`);
// virtualAUM = 9000 / (1 - 10/100) = 10000; allocationUsdt = 10000 * 2.0 / 100 = 200
assert(closeTo(result1.allocation_usdt, 200), `Test 1: allocation_usdt matches the real formula (got ${result1.allocation_usdt})`);

// --- Test 2: CAUTIOUS halves the same tier ---
console.log('\n--- Test 2: Cautious Allocation (50% size) ---');
const result2 = allocator.allocate(mockConsensus, mockPortfolio, 'CAUTIOUS');
console.log(result2);
assert(result2.status === 'APPROVED', 'Test 2: CAUTIOUS still approves a strong signal');
assert(closeTo(result2.allocation_pct, 1.0), `Test 2: CAUTIOUS halves 2.0% to 1.0% (got ${result2.allocation_pct})`);
assert(closeTo(result2.allocation_usdt, 100), `Test 2: allocation_usdt halved accordingly (got ${result2.allocation_usdt})`);

// --- Test 3: SURVIVAL mode rejects unconditionally ---
console.log('\n--- Test 3: Survival Mode (Reject) ---');
const result3 = allocator.allocate(mockConsensus, mockPortfolio, 'SURVIVAL');
console.log(result3);
assert(result3.status === 'REJECTED', 'Test 3: SURVIVAL mode rejects regardless of score');
assert(result3.allocation_pct === 0 && result3.allocation_usdt === 0, 'Test 3: rejected allocation is zero-sized');
assert(!!result3.reason && result3.reason.includes('SURVIVAL'), `Test 3: rejection reason names the active CPM state (got "${result3.reason}")`);

// --- Test 4: score below the minimum matrix tier rejects ---
console.log('\n--- Test 4: Low Score (Reject) ---');
const result4 = allocator.allocate({ ...mockConsensus, final_alpha: 40 }, mockPortfolio, 'NORMAL');
console.log(result4);
assert(result4.status === 'REJECTED', 'Test 4: alpha=40 is below every matrix tier, rejected');
assert(result4.allocation_pct === 0 && result4.allocation_usdt === 0, 'Test 4: rejected allocation is zero-sized');
assert(!!result4.reason && result4.reason.includes('below minimum threshold'), `Test 4: rejection reason cites the threshold (got "${result4.reason}")`);

if (process.exitCode === 1) {
  console.error('\nSome assertions FAILED - see above.');
} else {
  console.log('\nAll HC-Capital-Allocator matrix assertions passed against the real allocate() logic.');
}
