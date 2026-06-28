import { CapitalAllocator } from './allocator.js';
import { ConsensusDecision, PortfolioState } from './types.js';

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

console.log('--- Test 1: Normal Allocation ---');
const result1 = allocator.allocate(mockConsensus, mockPortfolio, 'NORMAL');
console.log(result1);

console.log('\n--- Test 2: Cautious Allocation (50% size) ---');
const result2 = allocator.allocate(mockConsensus, mockPortfolio, 'CAUTIOUS');
console.log(result2);

console.log('\n--- Test 3: Survival Mode (Reject) ---');
const result3 = allocator.allocate(mockConsensus, mockPortfolio, 'SURVIVAL');
console.log(result3);

console.log('\n--- Test 4: Low Score (Reject) ---');
const result4 = allocator.allocate({...mockConsensus, final_alpha: 40}, mockPortfolio, 'NORMAL');
console.log(result4);
