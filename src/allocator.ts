import { ConsensusDecision, PortfolioState, AllocationDecision, CapitalPreservationMode } from './types.js';
import { DEFAULT_MIN_ALLOCATION_USDT, UserCapitalLimit } from './capital-limits.js';

export type AllocationResult = Omit<AllocationDecision, 'account_id' | 'environment' | 'platform_name'>;

/** Per-user context the service resolves before sizing (see capital-limits.ts / deployed-capital.ts). */
export interface UserCapitalContext {
  /** null = no limit configured for this account -> no new allocation (safe default). */
  limit: UserCapitalLimit | null;
  /** USDT the software currently has deployed for this account. */
  deployed_usdt: number;
}

type Sizing =
  | { ok: false; result: AllocationResult }
  | { ok: true; tierPct: number; aum: number; available: number };

export class CapitalAllocator {
  private readonly HARD_CAP_PCT = 3.0;

  /**
   * Calculate position size based on Consensus Score, Confidence, Portfolio State and CPM.
   * Account-level only: does NOT apply a per-user capital limit (use allocateForUser).
   *
   * Invariants (fix for the >=100% exposure bug found 2026-09-25):
   *  - available_balance <= 0 / non-finite, or total_exposure outside [0, 100) -> REJECTED
   *  - allocation_usdt is always finite, >= 0 and <= available_balance
   */
  public allocate(
    consensus: ConsensusDecision,
    portfolio: PortfolioState,
    cpm: CapitalPreservationMode = 'NORMAL'
  ): AllocationResult {
    const s = this.size(consensus, portfolio, cpm);
    if (!s.ok) return s.result;
    return this.finish(consensus, s.tierPct, s.aum, Math.min((s.aum * s.tierPct) / 100, s.available), s.available);
  }

  /**
   * allocate() plus the per-user capital limit (owner decision 2026-09-25):
   * never approves an allocation that would push the user's deployed capital
   * above max_capital_usdt. Caps down to the remaining room when that room is
   * >= the minimum allocation size, otherwise rejects with a reason.
   */
  public allocateForUser(
    consensus: ConsensusDecision,
    portfolio: PortfolioState,
    cpm: CapitalPreservationMode,
    user: UserCapitalContext
  ): AllocationResult {
    const s = this.size(consensus, portfolio, cpm);
    if (!s.ok) return s.result;

    const { limit, deployed_usdt } = user;
    if (!limit) {
      return this.reject(consensus, `No capital limit configured for account ${consensus.account_id}: new allocations disabled (safe default)`);
    }
    if (!Number.isFinite(deployed_usdt) || deployed_usdt < 0) {
      return this.reject(consensus, `Deployed capital unknown (${deployed_usdt}): failing closed`);
    }
    const max = limit.max_capital_usdt;
    const min = limit.min_allocation_usdt ?? DEFAULT_MIN_ALLOCATION_USDT;
    if (!Number.isFinite(max) || max < 0) {
      return this.reject(consensus, `Invalid capital limit settings for account ${consensus.account_id}: failing closed`);
    }
    const remaining = max - deployed_usdt;
    if (remaining <= 0 || remaining < min) {
      return this.reject(
        consensus,
        `Per-user capital limit reached: deployed ${fmt(deployed_usdt)} of ${fmt(max)} USDT, remaining ${fmt(Math.max(remaining, 0))} < minimum ${fmt(min)}`
      );
    }

    const capitalBase = (limit.sizing_base ?? 'LIMIT') === 'ACCOUNT' ? s.aum : Math.min(s.aum, max);
    const wanted = Math.min((capitalBase * s.tierPct) / 100, s.available);
    if (wanted < min) {
      return this.reject(consensus, `Allocation ${fmt(wanted)} USDT below minimum ${fmt(min)} USDT`);
    }
    if (wanted > remaining) {
      const r = this.finish(consensus, s.tierPct, s.aum, remaining, s.available);
      return {
        ...r,
        status: 'REDUCED',
        reason: `Capped to per-user remaining room: ${fmt(remaining)} USDT (deployed ${fmt(deployed_usdt)} of ${fmt(max)})`,
      };
    }
    return this.finish(consensus, s.tierPct, s.aum, wanted, s.available);
  }

  private size(consensus: ConsensusDecision, portfolio: PortfolioState, cpm: CapitalPreservationMode): Sizing {
    const { final_alpha, confidence_score } = consensus;

    // 1. CPM Check - If not NORMAL/CAUTIOUS, reject new trades
    if (cpm !== 'NORMAL' && cpm !== 'CAUTIOUS') {
      return { ok: false, result: this.reject(consensus, `CPM Active: ${cpm}. New trades disabled.`) };
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
        ok: false,
        result: this.reject(consensus, `Score/Confidence below minimum threshold (${final_alpha}/${confidence_score})`),
      };
    }

    // 3. CPM Scaling
    if (cpm === 'CAUTIOUS') {
      basePct *= 0.5;
    }

    // 4. Hard Cap enforcement
    const tierPct = Math.min(basePct, this.HARD_CAP_PCT);

    // 5. Balance / exposure guards. total_exposure is the % of AUM already
    // in use, so AUM = available / (1 - exposure). At >= 100% that is
    // Infinity or negative, so there is simply no room: reject.
    const available = portfolio.available_balance;
    const exposure = portfolio.total_exposure;
    if (!Number.isFinite(available) || available <= 0) {
      return { ok: false, result: this.reject(consensus, `No available balance (${available})`) };
    }
    if (!Number.isFinite(exposure) || exposure < 0 || exposure >= 100) {
      return { ok: false, result: this.reject(consensus, `Total exposure ${exposure}% leaves no room for new allocations`) };
    }
    const aum = available / (1 - exposure / 100);
    return { ok: true, tierPct, aum, available };
  }

  private finish(consensus: ConsensusDecision, tierPct: number, aum: number, usdt: number, available: number): AllocationResult {
    const wanted = (aum * tierPct) / 100;
    const capped = usdt < wanted;
    const base: AllocationResult = {
      signal_id: consensus.signal_id,
      correlation_id: consensus.correlation_id,
      allocation_pct: capped ? (usdt / aum) * 100 : tierPct,
      allocation_usdt: usdt,
      leverage: 1, // Leverage Engine will set this later in the pipeline
      margin_type: 'ISOLATED',
      status: 'APPROVED',
    };
    if (capped && usdt >= available) {
      return { ...base, status: 'REDUCED', reason: `Capped to available balance ${fmt(available)} USDT` };
    }
    return base;
  }

  private reject(consensus: ConsensusDecision, reason: string): AllocationResult {
    return {
      signal_id: consensus.signal_id,
      correlation_id: consensus.correlation_id,
      allocation_pct: 0,
      allocation_usdt: 0,
      leverage: 1,
      margin_type: 'ISOLATED',
      status: 'REJECTED',
      reason,
    };
  }
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}
