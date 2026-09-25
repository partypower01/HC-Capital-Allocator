/**
 * In-memory tracking of capital the software has deployed per account.
 *
 * The allocator has no authoritative source of "USDT currently deployed by
 * the software" (PortfolioState only carries available_balance and an
 * exposure percentage for the WHOLE account, including positions opened
 * outside the software). So this tracker counts the allocator's own
 * approved allocations and releases them on the lifecycle events that
 * already flow on the bus:
 *
 *   AllocationDecision APPROVED/REDUCED  -> reserve allocation_usdt under correlation_id
 *   ExecutionReport FILLED/PARTIALLY_... -> mark reservation as filled (kept until close)
 *   ExecutionReport REJECTED/CANCELLED   -> release, if nothing was filled yet
 *   PositionClosed (HC-Position-Watcher) -> release (envelope correlation_id =
 *                                           opening correlation_id)
 *   no fill within unfilledTtlMs         -> release (allocation was never executed,
 *                                           e.g. vetoed downstream by Risk-Guardian)
 *
 * Known limitations (documented, deliberate for a minimal first version):
 *  - State is in memory: after a restart the tracker starts at 0 deployed
 *    while positions may still be open. Until a persistent source exists,
 *    the portfolio's own available_balance/exposure guards still apply,
 *    but the per-user limit could be over-used by the value of positions
 *    open across a restart.
 *  - Deployed = USDT committed at entry, not current mark value (PnL is
 *    ignored in both directions). Partial closes are not released pro rata;
 *    the full reservation is released on PositionClosed.
 *  - Relies on correlation_id being threaded unchanged from ConsensusDecision
 *    through ExecutionReport to PositionClosed, as the current services do.
 */

export interface Reservation {
  correlation_id: string;
  account_key: string;
  usdt: number;
  reserved_at_ms: number;
  filled: boolean;
}

export const DEFAULT_UNFILLED_TTL_MS = 15 * 60 * 1000;

export function accountKey(account_id: string, environment: string): string {
  return `${account_id}:${environment}`;
}

export class DeployedCapitalTracker {
  private reservations = new Map<string, Reservation>();

  constructor(private readonly unfilledTtlMs: number = DEFAULT_UNFILLED_TTL_MS) {}

  reserve(account_key: string, correlation_id: string, usdt: number, now_ms: number): void {
    if (!Number.isFinite(usdt) || usdt <= 0) return;
    const existing = this.reservations.get(correlation_id);
    if (existing) {
      // A second allocation for the same trade candidate adds to it.
      existing.usdt += usdt;
      return;
    }
    this.reservations.set(correlation_id, { correlation_id, account_key, usdt, reserved_at_ms: now_ms, filled: false });
  }

  onExecutionReport(correlation_id: string, status: string): void {
    const r = this.reservations.get(correlation_id);
    if (!r) return;
    if (status === 'FILLED' || status === 'PARTIALLY_FILLED') {
      r.filled = true;
    } else if ((status === 'REJECTED' || status === 'CANCELLED') && !r.filled) {
      this.reservations.delete(correlation_id);
    }
  }

  onPositionClosed(correlation_id: string): void {
    this.reservations.delete(correlation_id);
  }

  /** Drop reservations that were never filled within the TTL. */
  expire(now_ms: number): void {
    for (const [id, r] of this.reservations) {
      if (!r.filled && now_ms - r.reserved_at_ms > this.unfilledTtlMs) this.reservations.delete(id);
    }
  }

  deployed(account_key: string, now_ms: number): number {
    this.expire(now_ms);
    let sum = 0;
    for (const r of this.reservations.values()) if (r.account_key === account_key) sum += r.usdt;
    return sum;
  }

  size(): number {
    return this.reservations.size;
  }
}
