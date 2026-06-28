import { HCEventBus } from './bus/bus.js';
import { CapitalAllocator } from './allocator.js';
import { 
  ConsensusDecision, 
  PortfolioState, 
  CapitalPreservationMode, 
  EventEnvelope,
  AllocationDecision
} from './types.js';

class CapitalAllocatorService {
  private bus: HCEventBus;
  private allocator: CapitalAllocator;
  private portfolios: Map<string, PortfolioState> = new Map();
  private cpmState: Map<string, CapitalPreservationMode> = new Map();

  constructor() {
    this.bus = new HCEventBus({ 
      groupName: 'hc-capital-allocator-group' 
    });
    this.allocator = new CapitalAllocator();
  }

  async start() {
    console.log('HC-Capital-Allocator starting...');

    // Subscribe to PortfolioUpdates to keep local state
    await this.bus.subscribe('allocator-portfolio-sync', async (event: EventEnvelope) => {
      const portfolio = event.payload as PortfolioState;
      const key = `${portfolio.account_id}:${portfolio.environment}`;
      this.portfolios.set(key, portfolio);
      console.log(`Updated local portfolio cache for ${key}`);
    }, ['PortfolioUpdate']);

    // Subscribe to CPM changes (if we had a specific event, for now let's assume it comes in via StateChange or similar)
    // Or we just listen to a 'CPMUpdate' event
    await this.bus.subscribe('allocator-cpm-sync', async (event: EventEnvelope) => {
      const { environment, mode } = event.payload;
      this.cpmState.set(environment, mode);
      console.log(`CPM Mode for ${environment} set to ${mode}`);
    }, ['CPMUpdate']);

    // Subscribe to ConsensusDecisions to perform allocation
    await this.bus.subscribe('allocator-decision-engine', this.handleConsensus.bind(this), ['ConsensusDecision']);

    console.log('HC-Capital-Allocator is operational.');
  }

  private async handleConsensus(event: EventEnvelope) {
    const consensus = event.payload as ConsensusDecision;
    const { account_id, environment, correlation_id } = consensus;
    const key = `${account_id}:${environment}`;

    console.log(`Processing ConsensusDecision for ${key} (CID: ${correlation_id})`);

    const portfolio = this.portfolios.get(key);
    const cpm = this.cpmState.get(environment) || 'NORMAL';

    if (!portfolio) {
      console.warn(`No portfolio state found for ${key}. Rejecting allocation.`);
      await this.publishRejection(consensus, `Portfolio state not found for ${key}`);
      return;
    }

    const allocation = this.allocator.allocate(consensus, portfolio, cpm);
    
    // Enrich with multi-account metadata
    const finalAllocation: AllocationDecision = {
      ...allocation,
      account_id,
      environment,
      platform_name: portfolio.platform_name || 'UNKNOWN'
    };

    console.log(`Allocation result for ${correlation_id}: ${finalAllocation.status} (${finalAllocation.allocation_pct}%)`);

    await this.bus.publish({
      event_type: 'AllocationDecision',
      producer: 'HC-Capital-Allocator',
      correlation_id,
      payload: finalAllocation
    });
  }

  private async publishRejection(consensus: ConsensusDecision, reason: string) {
    const rejection: AllocationDecision = {
      signal_id: consensus.signal_id,
      correlation_id: consensus.correlation_id,
      allocation_pct: 0,
      allocation_usdt: 0,
      leverage: 1,
      margin_type: 'ISOLATED',
      status: 'REJECTED',
      reason,
      account_id: consensus.account_id,
      environment: consensus.environment,
      platform_name: 'UNKNOWN'
    };

    await this.bus.publish({
      event_type: 'AllocationDecision',
      producer: 'HC-Capital-Allocator',
      correlation_id: consensus.correlation_id,
      payload: rejection
    });
  }
}

const service = new CapitalAllocatorService();
service.start().catch(err => {
  console.error('Failed to start HC-Capital-Allocator:', err);
  process.exit(1);
});
