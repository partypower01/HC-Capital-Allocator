import { HCEventBus } from './bus/bus.js';
import { CapitalAllocator } from './allocator.js';
import { loadCapitalLimitsFromEnv } from './capital-limits.js';
import { RiskSettingsProvider, FAIL_CLOSED_PROVIDER, createSettingsProviderFromEnv } from './settings-provider.js';
import { DeployedCapitalTracker, accountKey, DEFAULT_UNFILLED_TTL_MS } from './deployed-capital.js';
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
  private settings: RiskSettingsProvider = FAIL_CLOSED_PROVIDER;
  private deployed: DeployedCapitalTracker;

  constructor() {
    this.bus = new HCEventBus({ 
      groupName: 'hc-capital-allocator-group' 
    });
    this.allocator = new CapitalAllocator();
    const ttl = Number(process.env.HC_ALLOCATOR_UNFILLED_TTL_MS);
    this.deployed = new DeployedCapitalTracker(Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_UNFILLED_TTL_MS);
  }

  async start() {
    console.log('HC-Capital-Allocator starting...');

    // Per-user capital limits (dashboard account_risk_settings by default).
    this.settings = await createSettingsProviderFromEnv(process.env, (s) => import(s), loadCapitalLimitsFromEnv);

    // ONE consumer for all event types. HCEventBus uses a single consumer
    // group per service, and Redis delivers each stream entry to only one
    // consumer of a group (non-matching types are acked and dropped). With
    // one consumer per type, most PortfolioUpdate/CPMUpdate/ConsensusDecision
    // events were silently lost to the "wrong" consumer.
    await this.bus.subscribe('allocator-main', this.handleEvent.bind(this), [
      'PortfolioUpdate',
      'CPMUpdate',
      'ExecutionReport',
      'PositionClosed',
      'ConsensusDecision',
    ]);

    console.log('HC-Capital-Allocator is operational.');
  }

  private async handleEvent(event: EventEnvelope) {
    switch (event.event_type) {
      case 'PortfolioUpdate': {
        // Keep local portfolio state
        const portfolio = event.payload as PortfolioState;
        const key = `${portfolio.account_id}:${portfolio.environment}`;
        this.portfolios.set(key, portfolio);
        console.log(`Updated local portfolio cache for ${key}`);
        break;
      }
      case 'CPMUpdate': {
        const { environment, mode } = event.payload;
        this.cpmState.set(environment, mode);
        console.log(`CPM Mode for ${environment} set to ${mode}`);
        break;
      }
      // Per-user capital tracking: release reservations when the order
      // failed or the position closed (see deployed-capital.ts for limitations).
      case 'ExecutionReport':
        this.deployed.onExecutionReport(event.correlation_id, String(event.payload?.status ?? ''));
        break;
      case 'PositionClosed':
        this.deployed.onPositionClosed(event.correlation_id);
        break;
      case 'ConsensusDecision':
        await this.handleConsensus(event);
        break;
      default:
        break;
    }
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

    const { user_key, limit } = await this.settings.resolve(account_id, environment);
    const trackKey = accountKey(user_key, environment);
    const allocation = this.allocator.allocateForUser(consensus, portfolio, cpm, {
      limit,
      deployed_usdt: this.deployed.deployed(trackKey, Date.now()),
    });

    if (allocation.status !== 'REJECTED' && allocation.allocation_usdt > 0) {
      this.deployed.reserve(trackKey, correlation_id, allocation.allocation_usdt, Date.now());
    }
    
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
