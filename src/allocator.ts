import { ConsensusDecision, PortfolioState, AllocationDecision, CapitalPreservationMode } from './types.js';

export class CapitalAllocator {
  private readonly HARD_CAP_PCT = 3.0;

  /**
   * Calculate position size based on Consensus Score, Confidence, Portfolio State and CPM
   */
  public allocate(
    consensus: ConsensusDecision,
    portfolio: PortfolioState,
    cpm: CapitalPreservationMode = 'NORMAL'
  ): Omit<AllocationDecision, 'account_id' | 'environment' | 'platform_name'> {
    const { final_alpha, confidence_score } = consensus;
    
    // 1. CPM Check - If not NORMAL/CAUTIOUS, reject new trades
    if (cpm !== 'NORMAL' && cpm !== 'CAUTIOUS') {
      return {
        signal_id: consensus.signal_id,
        correlation_id: consensus.correlation_id,
        allocation_pct: 0,
        allocation_usdt: 0,
        leverage: 1,
        margin_type: 'ISOLATED',
        status: 'REJECTED',
        reason: `CPM Active: ${cpm}. New trades disabled.`
      };
    }

    // 2. Base Allocation from Matrix
    let basePct = 0;

    if (final_alpha >= 90 && confidence_score > 95) {
      basePct = 3.0;
    } else if (final_alpha >= 80 && confidence_score > 90) {
      basePct = 2.0;
    } else if (final_alpha >= 70 && confidence_score > 85) {
      basePct = 1.0;
    } else if (final_alpha >= 60 && confidence_score > 80) {
      basePct = 0.5;
    } else if (final_alpha >= 50 && confidence_score > 80) {
      basePct = 0.25;
    } else {
      return {
        signal_id: consensus.signal_id,
        correlation_id: consensus.correlation_id,
        allocation_pct: 0,
        allocation_usdt: 0,
        leverage: 1,
        margin_type: 'ISOLATED',
        status: 'REJECTED',
        reason: `Score/Confidence below minimum threshold (${final_alpha}/${confidence_score})`
      };
    }

    // 3. CPM Scaling
    if (cpm === 'CAUTIOUS') {
      basePct *= 0.5;
    }

    // 4. Hard Cap enforcement (redundant here but good for safety)
    const finalPct = Math.min(basePct, this.HARD_CAP_PCT);

    // 5. USDT Calculation
    // Assuming portfolio total_exposure is % used, we need total AUM or available balance.
    // TDS doesn't explicitly define where AUM is, but let's assume portfolio.available_balance 
    // is for new trades or we use a virtual AUM.
    // For now, let's use a dummy AUM if not provided in state.
    const virtualAUM = portfolio.available_balance / (1 - portfolio.total_exposure/100); 
    // Actually, let's just use available_balance as the base for simplicity or if 
    // total_exposure is low. Better yet, let's just use 10,000 as a mock AUM if balance is weird.
    
    const allocationUsdt = (virtualAUM * finalPct) / 100;

    return {
      signal_id: consensus.signal_id,
      correlation_id: consensus.correlation_id,
      allocation_pct: finalPct,
      allocation_usdt: allocationUsdt,
      leverage: 1, // Leverage Engine will set this later in the pipeline
      margin_type: 'ISOLATED',
      status: 'APPROVED'
    };
  }
}
