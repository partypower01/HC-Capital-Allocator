# HC-Capital-Allocator

Layer 3 Module — Risk-Adjusted Position Sizing for HypeCatcher v3.

## Responsibility
HC-Capital-Allocator is the third pillar of the **Decision Trinity**. It takes an approved `ConsensusDecision` and calculates the appropriate position size in USDT based on:
1.  **Bayesian Consensus Score** (0-100)
2.  **Signal Confidence** (0-100)
3.  **Capital Preservation Mode** (CPM)
4.  **Portfolio State** (Available Balance & Exposure)

## Features
- **Sizing Matrix**: Implements institutional allocation ranges (0.25% to 3.00%).
- **Hard Caps**: Strictly enforces a 3% max position size per total AUM.
- **CPM Integration**: Scales down position sizes in `CAUTIOUS` mode (50%) and rejects trades in `DEFENSIVE`, `SURVIVAL`, or `LOCKDOWN` modes.
- **Multi-Account Support**: Correctly scopes allocations to specific `account_id` and `environment` (LIVE/BACKTEST).

## Technical Stack
- **Runtime**: Node.js (TypeScript)
- **Event Bus**: Redis Streams
- **Data Contracts**: Standardized via `HC-Shared-Commons`

## Setup
```bash
npm install
npm run build
npm run start
```

## Matrix Logic
| Score Range | Confidence Required | Allocation (% of capital) |
|-------------|-------------------|--------------------------|
| 50–60       | >80               | 0.25%                    |
| 60–70       | >80               | 0.50%                    |
| 70–80       | >85               | 1.00%                    |
| 80–90       | >90               | 2.00%                    |
| 90+         | >95               | 3.00%                    |

## Per-user capital limit (2026-09-25)
Owner decision: every user has a maximum trading capital (e.g. 100 USDT) that the
software tracks itself. `allocateForUser()` never approves an allocation that would
push the user's deployed capital above that limit: it caps down to the remaining
room (status `REDUCED`) when that room is at least the minimum allocation size
(default 5 USDT), otherwise it rejects with a reason.

- **Source of the limit** (`src/settings-provider.ts`): by default the dashboard's
  `account_risk_settings.max_trade_capital_usdt` (shared app DB), read through
  `hc-db-client` (`TEAM_DB_URL`), cached 30 s. `HC_ALLOCATOR_SETTINGS_SOURCE=config`
  uses a JSON config instead (`HC_ALLOCATOR_CAPITAL_LIMITS(_FILE)`, see
  `src/capital-limits.ts`).
- **Safe default: fail closed.** No row, a NULL max, invalid values, a DB error, or
  `hc-db-client` not being installed all mean *no new allocation*, never unlimited.
- **Account to user mapping**: `HC_ALLOCATOR_ACCOUNT_USER_MAPPING=direct` (default,
  account_id is the user_id) or `exchange_accounts` (account_id is
  `exchange_accounts.id`; the budget is then shared by all accounts of the user).
- **Sizing base**: `HC_ALLOCATOR_SIZING_BASE=LIMIT` (default: matrix % of
  min(AUM, limit), so 3% of 100 = 3 USDT) or `ACCOUNT` (% of full AUM, then capped).
- `safe_buffer_usdt` in the same table is **not** an allocator limit; it caps what
  the safekill / re-buy logic may act on (HC-Risk-Guardian).
- **Deployed capital** (`src/deployed-capital.ts`) is tracked in memory from the
  allocator's own approvals, released on `ExecutionReport` REJECTED/CANCELLED
  (unfilled), `PositionClosed`, or after 15 min without a fill
  (`HC_ALLOCATOR_UNFILLED_TTL_MS`). Limitations: lost on restart, counts entry
  USDT not mark value, no pro-rata release on partial closes.
- `hc-db-client` is loaded at runtime, not yet a package dependency (it is a
  `file:` sibling and CI would need the sibling checkout + `HC_REPOS_TOKEN`, as in
  HC-State-Manager). Until it is added, `db` mode fails closed.

## Exposure guard (bug fix 2026-09-25)
`total_exposure` >= 100% (or invalid), or `available_balance` <= 0, is rejected.
The size is always finite, >= 0 and never more than `available_balance`
(previously 100% exposure gave `Infinity`, >100% a negative size, and 99% gave
100x the balance, all `APPROVED`).

